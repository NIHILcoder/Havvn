/**
 * NativeMediaServer — a single 127.0.0.1 HTTP server for in-app playback of
 * files the transmission engine writes to disk. Two route families:
 *
 *   GET /direct/<id>/<fileIndex>     HTTP Range straight from the on-disk file.
 *   GET /transcode/<id>/<fileIndex>  ffmpeg → fragmented MP4 / MP3 from disk.
 *
 * With the daemon in sequential mode + a priority-high head (set by the manager
 * before handing out a URL), the front of the file lands first, so the /direct
 * path can serve early Range requests of a still-downloading file. The server
 * is loopback-only and rejects any cross-origin / DNS-rebinding request, exactly
 * like the webtorrent transcode server.
 */

import http from 'node:http';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { spawn, ChildProcess } from 'node:child_process';

export interface MediaFileInfo {
  diskPath: string;
  length: number; // full file size (may exceed what's downloaded yet)
  name: string;
  kind: 'video' | 'audio' | 'other';
}

export type MediaResolver = (id: string, fileIndex: number) => MediaFileInfo | null;
/** Contiguous downloaded bytes from the file start (RPC bytesCompleted). transmission
 *  files are SPARSE, so on-disk size ≠ downloaded — this must come from the daemon. */
export type BytesAvailable = (id: string, fileIndex: number) => Promise<number>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a single "bytes=start-end" Range header against a known total. */
function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] ? parseInt(m[1], 10) : NaN;
  let end = m[2] ? parseInt(m[2], 10) : NaN;
  if (Number.isNaN(start)) { // suffix range: bytes=-N (last N bytes)
    if (Number.isNaN(end)) return null;
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (Number.isNaN(end)) {
    end = total - 1;
  }
  if (start > end || start < 0) return null;
  return { start, end: Math.min(end, total - 1) };
}

export class NativeMediaServer {
  private server: http.Server | null = null;
  private portValue = 0;
  private starting: Promise<number> | null = null;
  private readonly transcodes = new Set<ChildProcess>();

  constructor(
    private readonly resolve: MediaResolver,
    private readonly ffmpeg: () => string | null,
    private readonly bytesAvailable: BytesAvailable,
    private readonly token: string,
  ) {}

  get port(): number { return this.portValue; }

  /** Lazily bind on 127.0.0.1; concurrent first calls share one bind. */
  ensure(): Promise<number> {
    if (this.server) return Promise.resolve(this.portValue);
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (e) => { this.starting = null; reject(e); });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.portValue = (server.address() as { port: number }).port;
        resolve(this.portValue);
      });
    });
    return this.starting;
  }

  close(): void {
    for (const p of this.transcodes) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    this.transcodes.clear();
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; }
    this.starting = null;
  }

  private guard(req: http.IncomingMessage, url: URL): boolean {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return false;  // DNS-rebinding
    if (req.headers.origin) return false;                            // cross-origin fetch
    if (url.searchParams.get('k') !== this.token) return false;      // per-session token
    return true;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (!this.guard(req, url)) { res.writeHead(403); res.end(); return; }
    const parts = url.pathname.split('/').filter(Boolean); // [mode, id, index]
    const id = parts.length >= 3 ? decodeURIComponent(parts[1]) : '';
    const fileIndex = Number(parts[2]);
    const info = parts.length >= 3 ? this.resolve(id, fileIndex) : null;
    if (!info) { res.writeHead(404); res.end(); return; }
    if (parts[0] === 'direct') { void this.serveDirect(req, res, info, id, fileIndex); return; }
    if (parts[0] === 'transcode') { this.serveTranscode(res, info, id, fileIndex); return; }
    res.writeHead(404); res.end();
  }

  private mime(info: MediaFileInfo): string {
    if (info.kind === 'audio') return 'audio/mpeg';
    const ext = info.name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'ogg' || ext === 'ogv') return 'video/ogg';
    return 'video/mp4';
  }

  /**
   * Range read from the on-disk file. transmission files are SPARSE — the
   * on-disk size is the full allocated length immediately, so availability is
   * gated on the daemon's contiguous `bytesCompleted` (grows front-to-back under
   * sequential mode), NOT on fs size. Serves the largest present prefix of the
   * requested range; the player re-requests the remainder.
   */
  private async serveDirect(req: http.IncomingMessage, res: http.ServerResponse, info: MediaFileInfo, id: string, fileIndex: number): Promise<void> {
    const total = info.length;
    const range = parseRange(req.headers.range, total);
    const start = range ? range.start : 0;
    const wantEnd = range ? range.end : total - 1;

    // Register teardown BEFORE the await so a disconnect during the wait can't
    // leak the fd or write to a dead socket.
    let stream: fs.ReadStream | null = null;
    const cleanup = () => { if (stream) { try { stream.destroy(); } catch { /* ignore */ } stream = null; } };
    res.on('close', cleanup);
    res.on('error', () => { /* client aborted — cleanup runs on 'close' */ });

    // Wait (bounded) until the requested start byte is downloaded.
    let avail = 0;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (res.destroyed) return; // client left during the wait
      avail = await this.bytesAvailable(id, fileIndex).catch(() => 0);
      if (avail > start || avail >= total || Date.now() >= deadline) break;
      await sleep(300);
    }
    if (res.destroyed) return;
    if (avail <= start && total > 0) { res.writeHead(503); res.end(); return; }

    const end = Math.min(wantEnd, avail - 1);
    // 206 for ANY prefix that isn't the whole file — even a rangeless request —
    // so a client never reads a truncated body as the complete resource.
    const partial = start > 0 || end < total - 1 || range !== null;
    const headers: Record<string, string> = {
      'Content-Type': this.mime(info),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(Math.max(0, end - start + 1)),
    };
    if (partial) res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}` });
    else res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }

    stream = fs.createReadStream(info.diskPath, { start, end });
    stream.on('error', cleanup);
    stream.pipe(res);
  }

  /**
   * Read a still-downloading (sparse) file into `dest` sequentially, pausing at
   * the download frontier and resuming as `bytesAvailable` grows — the disk
   * equivalent of webtorrent's blocking createReadStream, so ffmpeg can transcode
   * a file that isn't complete yet instead of hitting a premature EOF.
   */
  private async pumpFile(diskPath: string, total: number, id: string, fileIndex: number, dest: Writable): Promise<void> {
    let pos = 0;
    while (pos < total && !dest.destroyed) {
      let avail = await this.bytesAvailable(id, fileIndex).catch(() => total);
      let waited = 0;
      while (avail <= pos && pos < total && waited < 120_000) { await sleep(300); waited += 300; avail = await this.bytesAvailable(id, fileIndex).catch(() => total); }
      if (avail <= pos) break; // stalled at the frontier for too long — end the stream
      const end = Math.min(avail, total) - 1;
      await new Promise<void>((resolve, reject) => {
        const rs = fs.createReadStream(diskPath, { start: pos, end });
        rs.on('error', reject);
        rs.on('end', resolve);
        dest.on('close', () => rs.destroy());
        rs.pipe(dest, { end: false }); // keep ffmpeg stdin open across segments
      });
      pos = end + 1;
    }
    try { dest.end(); } catch { /* already closed */ }
  }

  /** ffmpeg → fmp4/mp3, fed from a tailing read of the (possibly incomplete) file. */
  private serveTranscode(res: http.ServerResponse, info: MediaFileInfo, id: string, fileIndex: number): void {
    const ffmpeg = this.ffmpeg();
    if (!ffmpeg) { res.writeHead(503); res.end('ffmpeg unavailable'); return; }
    const args = info.kind === 'audio'
      ? ['-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1']
      : [
          '-i', 'pipe:0',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          '-f', 'mp4', 'pipe:1',
        ];
    res.writeHead(200, { 'Content-Type': info.kind === 'audio' ? 'audio/mpeg' : 'video/mp4', 'Cache-Control': 'no-store' });
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    this.transcodes.add(proc);
    const cleanup = () => { this.transcodes.delete(proc); try { proc.kill('SIGKILL'); } catch { /* ignore */ } };
    proc.stdin.on('error', () => { /* EPIPE when ffmpeg/client ends — ignore */ });
    void this.pumpFile(info.diskPath, info.length, id, fileIndex, proc.stdin).catch(cleanup);
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => { /* discard ffmpeg progress chatter */ });
    proc.on('error', () => { cleanup(); try { res.destroy(); } catch { /* ignore */ } });
    proc.on('close', () => this.transcodes.delete(proc));
    res.on('close', cleanup);
  }
}
