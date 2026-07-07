/**
 * TransmissionSidecar — spawns and supervises a bundled transmission-daemon as
 * the native download engine, reachable only via localhost RPC.
 *
 * Security posture: RPC binds 127.0.0.1 with per-launch random credentials, and
 * the daemon's own peer/host whitelists are left on, so a DNS-rebinding page
 * can't reach it and no remote host can drive our engine. The loopback RPC is
 * still reachable by any LOCAL process, so those credentials are the only
 * barrier between local users — keep configDir in a per-user-protected location
 * (e.g. %APPDATA%) so settings.json, which briefly holds the plaintext password
 * before the daemon hashes it on exit, isn't world-readable.
 *
 * No Electron imports — runs in the torrent-host utilityProcess and in plain
 * Node (spike harness).
 */

import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { TransmissionRpc } from './transmission-rpc';

export interface SidecarOptions {
  binaryPath: string;   // transmission-daemon(.exe), DLLs alongside
  configDir: string;    // daemon state: settings.json, resume/, torrents/, dht.dat
  downloadDir: string;
  rpcPort?: number;     // default: pick a free ephemeral port
  peerPort?: number;    // default: pick a free ephemeral port
  /** Extra settings.json keys layered over the managed defaults (e.g. speed limits). */
  settingsOverrides?: Record<string, unknown>;
  onLog?: (line: string) => void;
  /** Fired when the daemon exits without stop() being called (crash → caller decides restart policy). */
  onUnexpectedExit?: (code: number | null) => void;
  readyTimeoutMs?: number; // default 20s
}

/** Grab n distinct free TCP ports (all sockets held open until each port is read). */
async function getFreePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise<net.Server>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    })),
  );
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

export class TransmissionSidecar {
  private child: ChildProcess | null = null;
  private stopping = false;
  private rpcClient: TransmissionRpc | null = null;
  private rpcPortActual = 0;
  private peerPortActual = 0;

  constructor(private readonly opts: SidecarOptions) {}

  /** RPC client for the running daemon. Throws before start()/after stop(). */
  get rpc(): TransmissionRpc {
    if (!this.rpcClient) throw new Error('transmission sidecar is not running');
    return this.rpcClient;
  }

  get pid(): number | undefined { return this.child?.pid; }
  get rpcPort(): number { return this.rpcPortActual; }
  get peerPort(): number { return this.peerPortActual; }
  private get pidFile(): string { return path.join(this.opts.configDir, 'sidecar.pid'); }

  async start(): Promise<TransmissionRpc> {
    if (this.child) throw new Error('transmission sidecar already started');
    this.stopping = false;

    const wantPorts = [this.opts.rpcPort, this.opts.peerPort].filter((p) => p === undefined).length;
    const free = wantPorts > 0 ? await getFreePorts(wantPorts) : [];
    this.rpcPortActual = this.opts.rpcPort ?? (free.shift() as number);
    this.peerPortActual = this.opts.peerPort ?? (free.shift() as number);

    const username = 'havvn';
    const password = crypto.randomBytes(18).toString('base64url');
    this.writeSettings(username, password); // also creates configDir
    // A previous run that died uncleanly (parent crash / hard-kill / Ctrl-C)
    // can leave the daemon orphaned, still torrenting and holding this config
    // dir. Reap it before spawning so we never end up with two daemons racing
    // on the same resume/ state.
    this.reapStaleDaemon();

    fs.mkdirSync(this.opts.downloadDir, { recursive: true });
    const child = spawn(this.opts.binaryPath, ['-f', '--config-dir', this.opts.configDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    try { fs.writeFileSync(this.pidFile, String(child.pid), { mode: 0o600 }); } catch { /* best effort */ }
    const onData = (d: Buffer) => {
      const text = String(d).trim();
      if (text) for (const line of text.split(/\r?\n/)) this.opts.onLog?.(line);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      this.child = null;
      this.rpcClient = null;
      this.safeUnlink(this.pidFile);
      if (!this.stopping) this.opts.onUnexpectedExit?.(code);
    });

    const rpc = new TransmissionRpc({ port: this.rpcPortActual, username, password });
    try {
      await this.waitForRpc(rpc, child);
    } catch (e) {
      // Readiness failed but the daemon may still be alive (e.g. it lost the RPC
      // port to a TOCTOU race yet keeps running) — killing it here is what stops
      // a leaked, invisible daemon. Mark stopping so the exit handler stays quiet.
      this.stopping = true;
      try { child.kill(); } catch { /* ignore */ }
      this.child = null;
      this.safeUnlink(this.pidFile);
      throw e;
    }
    this.rpcClient = rpc;
    return rpc;
  }

  private safeUnlink(file: string): void {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  /** Kill a transmission-daemon left behind by a previous unclean exit (pid file). */
  private reapStaleDaemon(): void {
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(this.pidFile, 'utf8').trim(), 10); } catch { return; }
    if (!pid || Number.isNaN(pid)) { this.safeUnlink(this.pidFile); return; }
    try { process.kill(pid, 0); } catch { this.safeUnlink(this.pidFile); return; } // not running
    try {
      if (process.platform === 'win32') {
        // Guard against PID reuse: only kill if it's actually our daemon image.
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        if (/transmission-daemon\.exe/i.test(out)) execFileSync('taskkill', ['/PID', String(pid), '/F', '/T']);
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch { /* best effort */ }
    this.safeUnlink(this.pidFile);
  }

  /**
   * settings.json is read once at daemon startup and rewritten by the daemon on
   * exit, so managed keys must be re-imposed on every launch; unmanaged keys the
   * daemon added (e.g. stats) are preserved.
   */
  private writeSettings(username: string, password: string): void {
    fs.mkdirSync(this.opts.configDir, { recursive: true });
    const file = path.join(this.opts.configDir, 'settings.json');
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { /* first launch */ }
    const managed: Record<string, unknown> = {
      // RPC: localhost-only + per-launch random credentials (plaintext here; the
      // daemon replaces it with a salted hash on its first settings rewrite).
      'rpc-enabled': true,
      'rpc-bind-address': '127.0.0.1',
      'rpc-port': this.rpcPortActual,
      'rpc-authentication-required': true,
      'rpc-username': username,
      'rpc-password': password,
      'rpc-whitelist-enabled': true,
      'rpc-whitelist': '127.0.0.1,::1',
      // Transport — the whole point of the swap: real µTP + DHT + PEX + LSD and
      // protocol encryption (1 = prefer encrypted, still accepts plaintext).
      'utp-enabled': true,
      'dht-enabled': true,
      'pex-enabled': true,
      'lpd-enabled': true,
      'encryption': 1,
      'peer-port': this.peerPortActual,
      'peer-port-random-on-start': false,
      'port-forwarding-enabled': true, // daemon's own UPnP/NAT-PMP
      'download-dir': this.opts.downloadDir,
      // The app has its own queue/limits semantics; don't let the daemon's
      // download queue hold torrents in "queued" states the UI doesn't know.
      'download-queue-enabled': false,
      'seed-queue-enabled': false,
      'watch-dir-enabled': false,
      'incomplete-dir-enabled': false,
      'start-added-torrents': true,
      ...this.opts.settingsOverrides,
    };
    // 0o600 because the file holds the plaintext RPC password until the daemon
    // rewrites it as a salted hash on exit. writeFileSync's mode only applies on
    // create, so chmod too (covers an existing file; on Windows this only sets
    // the read-only bit — a per-user-protected configDir is the real guard).
    fs.writeFileSync(file, JSON.stringify({ ...existing, ...managed }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  private async waitForRpc(rpc: TransmissionRpc, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 20_000);
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`transmission-daemon exited during startup (code ${child.exitCode})`);
      try { await rpc.sessionGet(); return; } catch (e) { lastErr = e; }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`transmission-daemon RPC not ready in time: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }

  /** Clean shutdown: session-close lets the daemon persist resume data, kill() is the backstop. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try { await this.rpcClient?.sessionClose(); } catch { /* daemon may already be gone */ }
    const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 7_000))]);
    if (!graceful) {
      try { child.kill(); } catch { /* ignore */ }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
    }
    this.child = null;
    this.rpcClient = null;
  }
}
