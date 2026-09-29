import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface MpvPosition { position: number; duration: number | null }
/** Private per-process IPC; only fixed read commands, never renderer-supplied commands. */
export class MpvWatch {
  readonly endpoint: string;
  private readonly directory: string | null;
  private socket: net.Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<number, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private generation = 0;
  private buffer = '';
  private running = false;
  private closed = false;
  private deadline = Date.now() + 15000;
  private last: MpvPosition | null = null;
  constructor(private readonly source: string, private readonly publish: (position: MpvPosition) => void) {
    this.directory = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-mpv-'));
    if (this.directory) fs.chmodSync(this.directory, 0o700);
    this.endpoint = this.directory ? path.join(this.directory, 'ipc') : `\\\\.\\pipe\\havvn-mpv-${crypto.randomUUID()}`;
  }
  start(): void { if (!this.closed && !this.socket) this.connect(); }
  private connect(): void {
    if (this.closed) return;
    const socket = net.createConnection(this.endpoint); this.socket = socket;
    socket.setEncoding('utf8'); socket.unref();
    socket.once('connect', () => {
      if (this.closed) { socket.destroy(); return; }
      this.deadline = Date.now() + 15000;
      void this.poll(); this.interval = setInterval(() => void this.poll(), 1000); this.interval.unref();
    });
    socket.on('data', chunk => this.receive(String(chunk)));
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = null; this.buffer = ''; this.generation++;
      if (this.interval) clearInterval(this.interval); this.interval = null;
      this.cancelRequests();
      if (!this.closed && Date.now() < this.deadline) {
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 250); this.retry.unref();
      }
    });
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 65536) { this.socket?.destroy(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let message: { event?: string; request_id?: number; error?: string; data?: unknown };
      try { message = JSON.parse(line); if (!message || typeof message !== 'object') continue; } catch { continue; }
      if (message.event === 'start-file') { this.generation++; this.last = null; }
      if (message.event === 'end-file') { this.flush(); this.generation++; }
      if (message.event === 'file-loaded' || message.event === 'playback-restart') void this.poll();
      if (typeof message.request_id === 'number') {
        const request = this.pending.get(message.request_id); if (!request) continue;
        this.pending.delete(message.request_id); clearTimeout(request.timer);
        request.resolve(message.error === 'success' ? message.data : undefined);
      }
    }
  }
  private get(property: 'path' | 'time-pos' | 'duration'): Promise<unknown> {
    const socket = this.socket; if (!socket || socket.connecting || socket.destroyed || this.closed) return Promise.resolve(undefined);
    const request_id = ++this.sequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(request_id); resolve(undefined); }, 1500); timer.unref();
      this.pending.set(request_id, { resolve, timer });
      socket.write(JSON.stringify({ command: ['get_property', property], request_id }) + '\n');
    });
  }
  private matches(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (/^https?:\/\//.test(this.source)) return value === this.source;
    if (!path.isAbsolute(value)) return false;
    const canonical = (p: string) => process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
    return canonical(value) === canonical(this.source);
  }
  private async poll(): Promise<void> {
    if (this.running || this.closed) return; this.running = true;
    const generation = this.generation;
    try {
      if (!this.matches(await this.get('path'))) return;
      const [position, duration] = await Promise.all([this.get('time-pos'), this.get('duration')]);
      const endingPath = await this.get('path');
      if (this.closed || generation !== this.generation || !this.matches(endingPath) || typeof position !== 'number' || !Number.isFinite(position) || position < 0) return;
      const total = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null;
      this.last = { position: total ? Math.min(position, total) : position, duration: total }; this.flush();
    } catch { /* An IPC failure must not stop playback. */ }
    finally { this.running = false; }
  }
  private flush(): void { if (this.last) { try { this.publish({ ...this.last }); } catch { /* Keep playback independent of history storage. */ } } }
  private cancelRequests(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.resolve(undefined); } this.pending.clear();
  }
  close(): void {
    if (this.closed) return; this.flush(); this.closed = true;
    if (this.interval) clearInterval(this.interval); if (this.retry) clearTimeout(this.retry);
    this.cancelRequests(); this.socket?.destroy(); this.socket = null;
    if (this.directory) {
      // Only remove the exact private socket and empty directory created by this instance.
      try { fs.unlinkSync(this.endpoint); } catch { /* mpv may already have removed its socket */ }
      try { fs.rmdirSync(this.directory); } catch { /* no recursive deletion */ }
    }
  }
}
