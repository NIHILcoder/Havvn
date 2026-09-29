import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mediaPath } from '../torrent/verified-media';
import { ExternalStream } from './external-stream';
import { MpvWatch } from './mpv-watch';
import { validWatchSession, watchKey, type WatchSession, type WatchTarget, type WatchEntry } from '../../shared/watch-history';
import type { ExternalMedia, ExternalMediaRead, ExternalPlayerSession } from '../../shared/external-player';
import { spawn, type ChildProcess } from 'node:child_process';
import { classifyMediaKind } from '../../shared/media';
import { externalStartTime, type ExternalPlayerPreferences, type ExternalPlayerConfig, type ExternalPlayerChoice, type ExternalPlayerResult, type ExternalPlayerFailure } from '../../shared/external-player';

export type LocalMedia = { ok: true; disk: string; length: number } | { ok: false; reason: ExternalPlayerFailure };
interface Dependencies {
  read: () => unknown;
  write: (value: ExternalPlayerPreferences) => void;
  resolve: (id: string, relativePath: string) => Promise<LocalMedia>;
  openPath: (file: string) => Promise<string>;
  snapshot?: (id: string, relativePath: string) => Promise<ExternalMedia>;
  readMedia?: (id: string, relativePath: string, key: string, start: number, max: number) => Promise<ExternalMediaRead>;
  spawn?: (exe: string, args: string[]) => ChildProcess;
  watchTarget?: (id: string, relativePath: string) => Promise<WatchTarget | null>;
  saveWatch?: (launch: string, entry: WatchEntry, session: WatchSession) => void;
}
const defaults: ExternalPlayerPreferences = { kind: 'default', executable: null };
function playerKind(executable: string): 'vlc' | 'mpv' | null {
  const name = path.basename(executable).toLowerCase();
  if (name === (process.platform === 'win32' ? 'vlc.exe' : 'vlc')) return 'vlc';
  if (name === (process.platform === 'win32' ? 'mpv.exe' : 'mpv')) return 'mpv';
  return null;
}
function executableExists(file: string): boolean {
  try { if (!path.isAbsolute(file) || file.includes('\0') || !fs.statSync(file).isFile()) return false;
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK); return true;
  } catch { return false; }
}
/** The only executable setter is called with a native picker result in main. */
export class ExternalPlayer {
  private readonly streams = new Map<string, { details: ExternalPlayerSession; server: ExternalStream; key: string }>();
  private readonly watches = new Map<string, MpvWatch>();
  private monitor: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private closed = false;
  constructor(private readonly deps: Dependencies) {}
  getConfig(): ExternalPlayerConfig {
    const raw = this.deps.read() as Partial<ExternalPlayerPreferences> | null;
    const selected = raw && (raw.kind === 'vlc' || raw.kind === 'mpv') && typeof raw.executable === 'string';
    const prefs: ExternalPlayerPreferences = selected ? { kind: raw.kind as 'vlc' | 'mpv', executable: raw.executable! } : defaults;
    return { ...prefs, available: prefs.kind === 'default' || (!!prefs.executable && playerKind(prefs.executable) === prefs.kind && executableExists(prefs.executable)) };
  }
  useDefault(): ExternalPlayerConfig { this.deps.write({ ...defaults }); return this.getConfig(); }
  select(file: string): ExternalPlayerChoice {
    const kind = playerKind(file);
    if (!kind) return { ok: false, reason: 'unsupported-player' };
    if (!executableExists(file)) return { ok: false, reason: 'missing-player' };
    this.deps.write({ kind, executable: file });
    return { ok: true, config: this.getConfig() };
  }
  async inspect(id: string, relativePath: string): Promise<'local' | 'stream' | ExternalPlayerFailure> {
    if (!mediaPath(relativePath)) return 'invalid-file';
    try {
      const local = await this.deps.resolve(id, relativePath); if (local.ok) return 'local';
      if (local.reason !== 'incomplete-file' || !this.deps.snapshot) return local.reason;
      const info = await this.deps.snapshot(id, relativePath); return info.ok ? 'stream' : info.reason;
    } catch { return 'unavailable'; }
  }
  sessions(): ExternalPlayerSession[] { return [...this.streams.values()].map(s => ({ ...s.details })); }
  stop(id: string): void {
    this.stopWatch(id);
    const session = this.streams.get(id); if (!session) return;
    this.streams.delete(id); session.server.close();
    if (!this.streams.size && this.monitor) { clearInterval(this.monitor); this.monitor = null; }
  }
  private stopWatch(id: string): void { const watch = this.watches.get(id); this.watches.delete(id); watch?.close(); }
  close(): void { this.closed = true; for (const id of this.streams.keys()) this.stop(id); for (const id of this.watches.keys()) this.stopWatch(id); }
  private watch(): void {
    if (this.monitor) return;
    this.monitor = setInterval(() => {
      if (this.checking) return; this.checking = true;
      void Promise.all([...this.streams].map(async ([id, s]) => {
        try { const info = await this.deps.snapshot!(s.details.downloadId, s.details.path); if (!info.ok || info.key !== s.key || info.length <= 0) this.stop(id); }
        catch { this.stop(id); }
      })).finally(() => { this.checking = false; });
    }, 2000);
    this.monitor.unref();
  }
  async open(id: string, relativePath: string, position?: number, watchSession?: WatchSession): Promise<ExternalPlayerResult> {
    const rel = mediaPath(relativePath); if (!rel) return { ok: false, reason: 'invalid-file' };
    let lease: string | null = null;
    let watchId: string | null = null;
    try {
      if (this.closed) return { ok: false, reason: 'unavailable' };
      const resolved = await this.deps.resolve(id, rel);
      const config = this.getConfig(), startTime = config.kind === 'default' ? 0 : externalStartTime(position);
      if (!config.available) return { ok: false, reason: 'missing-player' };
      let source: string;
      if (resolved.ok) {
        if (!path.isAbsolute(resolved.disk) || classifyMediaKind(resolved.disk) === 'other') return { ok: false, reason: 'invalid-file' };
        try { const stat = fs.statSync(resolved.disk); if (!stat.isFile()) return { ok: false, reason: 'invalid-file' };
          if (stat.size < resolved.length) return { ok: false, reason: 'incomplete-file' };
        } catch { return { ok: false, reason: 'missing-file' }; }
        source = resolved.disk;
      } else {
        if (resolved.reason !== 'incomplete-file' || !this.deps.snapshot || !this.deps.readMedia) return resolved;
        const info = await this.deps.snapshot(id, rel); if (!info.ok) return info;
        if (config.kind === 'default') return { ok: false, reason: 'stream-player' };
        if (!Number.isSafeInteger(info.length) || info.length <= 0) return { ok: false, reason: 'invalid-file' };
        if (this.streams.size >= 4) return { ok: false, reason: 'too-many-streams' };
        if (this.closed) return { ok: false, reason: 'unavailable' };
        lease = crypto.randomUUID(); const sessionId = lease;
        const server = new ExternalStream(info.length, (start, max) => this.deps.readMedia!(id, rel, info.key, start, max), () => this.stop(sessionId));
        this.streams.set(lease, { details: { id: lease, downloadId: id, path: rel, kind: config.kind }, server, key: info.key });
        this.watch(); source = await server.url();
      }
      if (this.closed) throw new Error('Player service closed');
      if (config.kind === 'default') {
        const error = await this.deps.openPath(source).catch(() => 'Failed');
        if (error) return { ok: false, reason: 'launch-failed' };
      } else {
        let watch: MpvWatch | null = null;
        if (config.kind === 'mpv' && watchSession && this.deps.watchTarget && this.deps.saveWatch) {
          const target = await this.deps.watchTarget(id, rel);
          if (!target || !validWatchSession(watchSession) || watchSession.key !== watchKey(target)) throw new Error('Invalid history target');
          if (this.watches.size >= 8) { if (lease) this.stop(lease); return { ok: false, reason: 'too-many-players' }; }
          watchId = lease || crypto.randomUUID(); const launch = watchId, opened = Date.now();
          const session = { ...watchSession };
          watch = new MpvWatch(source, sample => this.deps.saveWatch!(launch, { ...target, ...sample,
            lastOpened: opened, updatedAt: Date.now(), completed: sample.duration !== null && sample.position >= sample.duration * 0.95 }, session));
          this.watches.set(launch, watch);
        }
        if (this.closed) throw new Error('Player service closed');
        // Fixed templates only; URLs remain in main and are never sent to renderer.
        // A separate VLC instance lets its process lifetime own this stream.
        const args = config.kind === 'mpv' ? [...(watch ? [`--input-ipc-server=${watch.endpoint}`] : []), ...(startTime ? [`--start=${startTime}`] : []), '--', source] :
          [...(lease ? ['--no-one-instance', '--no-one-instance-when-started-from-file'] : []), ...(startTime ? [`--start-time=${startTime}`] : []), source];
        const sessionId = lease;
        const trackingId = watchId;
        const launched = await new Promise<boolean>(resolve => {
          const child = this.deps.spawn ? this.deps.spawn(config.executable!, args) :
            spawn(config.executable!, args, { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
          let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
          const release = () => { if (trackingId) this.stopWatch(trackingId); if (sessionId) this.stop(sessionId); };
          const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); child.unref(); resolve(ok); };
          child.once('error', () => { release(); finish(false); });
          child.once('exit', (code, signal) => { release(); finish(!sessionId && code === 0 && !signal); });
          child.once('spawn', () => { watch?.start(); timer = setTimeout(() => finish(!this.closed && (!sessionId || this.streams.has(sessionId))), 500); });
        }).catch(() => false);
        if (!launched) { if (watchId) this.stopWatch(watchId); if (lease) this.stop(lease); return { ok: false, reason: 'launch-failed' }; }
      }
      return { ok: true, kind: config.kind, startTime };
    } catch { if (watchId) this.stopWatch(watchId); if (lease) this.stop(lease); return { ok: false, reason: 'unavailable' }; }
  }
}
