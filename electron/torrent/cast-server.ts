/**
 * CastServer — "Stream to any device on your network".
 *
 * Unlike the in-app stream server (127.0.0.1 only), this binds to all interfaces
 * so a phone/TV/laptop on the same Wi-Fi can open a URL and watch a torrent —
 * with real seeking — even if the file is an mkv/HEVC/AVI the browser can't
 * decode, because the desktop (which has ffmpeg) transcodes to HLS on the fly.
 *
 * Two delivery paths:
 *   • Direct (mp4/webm/h264…): the on-disk file is streamed with HTTP Range, so
 *     the device's native player seeks with zero CPU on our side.
 *   • Transcoded (everything else): on-demand **HLS VOD**. We probe the duration,
 *     hand the device a playlist of fixed-length segments, and transcode each
 *     segment only when requested (ffmpeg `-ss`/`-t`). That means instant start
 *     and seek-anywhere without transcoding the whole movie up front. Two
 *     bitrates (720p/480p) are offered for adaptive quality.
 *
 * Access is gated: only files explicitly published via `publish()` are served,
 * and every URL must carry a random per-session token (`?k=`). The server binds
 * to the LAN, so the token is what stops other devices on the network from
 * guessing URLs.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils';

const log = logger.child('CastServer');

const SEG = 6; // HLS segment length, seconds

interface Variant {
  id: string; height: number; vMax: string; vBuf: string; aBr: string; bandwidth: number; w: number; h: number;
}
// Ordered best→worst; hls.js picks per measured bandwidth.
const VARIANTS: Variant[] = [
  { id: '720', height: 720, vMax: '2800k', vBuf: '5600k', aBr: '128k', bandwidth: 3000000, w: 1280, h: 720 },
  { id: '480', height: 480, vMax: '1200k', vBuf: '2400k', aBr: '96k', bandwidth: 1400000, w: 854, h: 480 },
];

interface FileInfo {
  name: string; length: number; diskPath: string; complete: boolean;
  kind: 'video' | 'audio' | 'other'; direct: boolean;
}

/** Provided by the torrent manager: resolve a published file's on-disk info. */
type Resolver = (id: string, fileIndex: number) => FileInfo | null;

export class CastServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = '';
  private published = new Set<string>(); // `${id}/${fileIndex}`
  private durations = new Map<string, number>(); // diskPath → seconds
  private active = new Set<ChildProcess>();
  private hlsLib: Buffer | null = null;          // cached hls.min.js
  private resolveFile: Resolver;
  private getFfmpeg: () => string | null;

  constructor(resolveFile: Resolver, getFfmpeg: () => string | null) {
    this.resolveFile = resolveFile;
    this.getFfmpeg = getFfmpeg;
  }

  /** Best-guess LAN IPv4 (prefers 192.168.* → 10.* → 172.16–31.*). */
  static lanAddress(): string | null {
    const ifaces = os.networkInterfaces();
    const addrs: string[] = [];
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
      }
    }
    const score = (ip: string) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
    addrs.sort((a, b) => score(a) - score(b));
    return addrs[0] || null;
  }

  private ensureServer(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.token = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      // Bind to all interfaces so LAN devices can reach it (may prompt the OS firewall).
      server.listen(0, '0.0.0.0', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        log.info('Cast server started', { port: this.port });
        resolve();
      });
    });
  }

  /**
   * Publish a file for casting and return the device-facing URL (player page).
   * Returns null when there's no LAN address to reach this machine on.
   */
  async publish(id: string, fileIndex: number): Promise<{ url: string; lan: string; port: number } | null> {
    const info = this.resolveFile(id, fileIndex);
    if (!info) throw new Error('File not available for casting');
    if (info.kind === 'other') throw new Error('This file is not a playable media file');
    if (!info.direct && !this.getFfmpeg()) throw new Error('Casting this format needs the bundled ffmpeg, which is unavailable');
    await this.ensureServer();
    const lan = CastServer.lanAddress();
    if (!lan) return null;
    this.published.add(`${id}/${fileIndex}`);
    const url = `http://${lan}:${this.port}/play/${encodeURIComponent(id)}/${fileIndex}?k=${this.token}`;
    return { url, lan, port: this.port };
  }

  unpublish(id: string, fileIndex: number): void { this.published.delete(`${id}/${fileIndex}`); }

  /**
   * Build a direct media URL + content type for a TV (Chromecast/DLNA), which
   * fetches the URL itself. Browser-playable files go via /direct (seekable);
   * everything else via HLS, which Chromecast plays natively.
   */
  async tvMedia(id: string, fileIndex: number): Promise<{ url: string; contentType: string; title: string }> {
    const info = this.resolveFile(id, fileIndex);
    if (!info) throw new Error('File not available for casting');
    if (info.kind === 'other') throw new Error('This file is not a playable media file');
    if (!info.direct && !this.getFfmpeg()) throw new Error('Casting this format needs the bundled ffmpeg, which is unavailable');
    await this.ensureServer();
    const lan = CastServer.lanAddress();
    if (!lan) throw new Error('No local network address found');
    this.published.add(`${id}/${fileIndex}`);
    const base = `http://${lan}:${this.port}`;
    const path = `/${encodeURIComponent(id)}/${fileIndex}`;
    if (info.direct) {
      return { url: `${base}/direct${path}?k=${this.token}`, contentType: directContentType(info.name), title: info.name };
    }
    return { url: `${base}/hls${path}/master.m3u8?k=${this.token}`, contentType: 'application/x-mpegurl', title: info.name };
  }

  // ── Request routing ────────────────────────────────────────────────────────
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '', 'http://cast');
      if (url.searchParams.get('k') !== this.token) { res.writeHead(403); res.end('forbidden'); return; }
      const parts = url.pathname.split('/').filter(Boolean);
      // /play/<id>/<idx> | /direct/<id>/<idx> | /hls/<id>/<idx>/master.m3u8
      //   | /hls/<id>/<idx>/<variant>/index.m3u8 | /hls/<id>/<idx>/<variant>/seg-<n>.ts
      const route = parts[0];
      // Serve the HLS player library locally so devices never need to reach a
      // CDN (the #1 reason transcoded formats failed: hls.js wouldn't load).
      if (route === 'hls.js') return void this.serveHlsLib(res);

      const id = decodeURIComponent(parts[1] || '');
      const fileIndex = Number(parts[2]);
      if (!this.published.has(`${id}/${fileIndex}`)) { res.writeHead(404); res.end('not published'); return; }
      const info = this.resolveFile(id, fileIndex);
      if (!info) { res.writeHead(404); res.end('gone'); return; }

      if (route === 'play') return void this.servePlayer(res, info, id, fileIndex);
      if (route === 'direct') return this.serveDirect(req, res, info);
      if (route === 'stream') return this.serveProgressive(req, res, info); // single-pass MP4 fallback
      if (route === 'hls') {
        if (parts[3] === 'master.m3u8') return void this.serveMaster(res, id, fileIndex);
        const variant = parts[3];
        if (parts[4] === 'index.m3u8') return void this.serveMedia(res, info, id, fileIndex, variant);
        const segMatch = /^seg-(\d+)\.ts$/.exec(parts[4] || '');
        if (segMatch) return this.serveSegment(req, res, info, variant, Number(segMatch[1]));
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      log.error('Cast request failed', { error: String(e) });
      try { res.writeHead(500); res.end(); } catch { /* ignore */ }
    }
  }

  // ── Player page ─────────────────────────────────────────────────────────────
  private servePlayer(res: http.ServerResponse, info: FileInfo, id: string, fileIndex: number): void {
    const q = `?k=${this.token}`;
    const base = `/${encodeURIComponent(id)}/${fileIndex}`;
    const directUrl = `/direct${base}${q}`;
    const masterUrl = `/hls${base}/master.m3u8${q}`;
    const streamUrl = `/stream${base}${q}`;
    // Old containers (avi/wmv/flv/mpg…) have messy timestamps that break the
    // per-segment HLS transcode — play them via the single-pass MP4 stream, which
    // is bulletproof. mkv/HEVC keep HLS (seeking).
    const progressiveFirst = prefersProgressive(info.name);
    // info.direct files play natively with a plain <video>; everything else uses
    // HLS (native on Safari/iOS, hls.js elsewhere). A failed direct play also
    // upgrades to HLS, covering MP4s with an unsupported codec (e.g. HEVC).
    const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(info.name)} — TorrentHunt</title>
<style>
  html,body{margin:0;height:100%;background:#000;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column}
  .top{padding:10px 14px;font-size:13px;font-weight:600;background:#0a0a0b;border-bottom:1px solid #26262a;display:flex;gap:8px;align-items:center}
  .top .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  video{flex:1;width:100%;height:100%;background:#000;outline:none}
  .msg{padding:14px;font-size:13px;color:#9a9aa2}
  .msg.err{color:#f87171}
</style></head><body>
<div class="wrap">
  <div class="top"><span>▶</span><span class="t">${escapeHtml(info.name)}</span></div>
  <video id="v" controls autoplay playsinline></video>
  <div class="msg" id="m"></div>
</div>
<script src="/hls.js${q}"></script>
<script>
(function(){
  var v=document.getElementById('v'), m=document.getElementById('m');
  var DIRECT=${info.direct ? 'true' : 'false'};
  var PROGRESSIVE_FIRST=${progressiveFirst ? 'true' : 'false'};
  var directUrl=${JSON.stringify(directUrl)};
  var masterUrl=${JSON.stringify(masterUrl)};
  var streamUrl=${JSON.stringify(streamUrl)};
  var fellBack=false, watchdog=null;
  function say(t,err){ m.textContent=t||''; m.className='msg'+(err?' err':''); }
  function clearSrc(){ try{ v.removeAttribute('src'); v.load(); }catch(e){} }
  function stopWatchdog(){ if(watchdog){ clearTimeout(watchdog); watchdog=null; } }
  v.addEventListener('playing',function(){ stopWatchdog(); say(''); });
  // Last resort: a single-pass transcoded MP4 stream. Plays anything; no seeking.
  function playProgressive(){
    if (fellBack) return; fellBack=true; stopWatchdog();
    try{ if(window._hls){ window._hls.destroy(); window._hls=null; } }catch(e){}
    clearSrc(); say('Converting — playback starts shortly (seeking is limited on this format)…');
    v.src=streamUrl;
    v.addEventListener('error',function(){ say('Could not play this file on this device.',true); },{once:true});
    v.play&&v.play().catch(function(){});
  }
  function playHls(){
    say(''); clearSrc();
    // If HLS produces no playable frame within 8s, drop to the MP4 stream.
    stopWatchdog(); watchdog=setTimeout(playProgressive, 8000);
    if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src=masterUrl; v.play&&v.play().catch(function(){}); return; }
    if (window.Hls && window.Hls.isSupported()) {
      var hls=new window.Hls({maxBufferLength:30}); window._hls=hls;
      hls.loadSource(masterUrl); hls.attachMedia(v);
      hls.on(window.Hls.Events.ERROR,function(_e,d){ if(d&&d.fatal){ playProgressive(); } });
    } else { playProgressive(); }
  }
  if (DIRECT){
    v.src=directUrl;
    v.addEventListener('error',function(){ playHls(); },{once:true});
  } else if (PROGRESSIVE_FIRST){
    playProgressive();
  } else { playHls(); }
})();
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  // ── Direct (Range) ───────────────────────────────────────────────────────────
  private serveDirect(req: http.IncomingMessage, res: http.ServerResponse, info: FileInfo): void {
    let size: number;
    try { size = fs.statSync(info.diskPath).size; } catch { res.writeHead(404); res.end(); return; }
    const range = req.headers.range;
    const ctype = directContentType(info.name);
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': ctype,
      });
      const stream = fs.createReadStream(info.diskPath, { start, end });
      stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
      stream.pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Type': ctype });
      const stream = fs.createReadStream(info.diskPath);
      stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
      stream.pipe(res);
    }
  }

  /** Serve the bundled hls.js (no CDN needed). Cached after first read. */
  private serveHlsLib(res: http.ServerResponse): void {
    try {
      if (!this.hlsLib) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const p = require.resolve('hls.js/dist/hls.min.js');
        this.hlsLib = fs.readFileSync(p);
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(this.hlsLib);
    } catch (e) {
      log.warn('hls.js serve failed', { error: String(e) });
      res.writeHead(404); res.end();
    }
  }

  /**
   * Single-pass transcode to a progressive fragmented MP4 — the proven recipe
   * from the in-app player. No seeking, but it "just works" for avi/mkv/HEVC and
   * is the fallback when HLS misbehaves on the device.
   */
  private serveProgressive(req: http.IncomingMessage, res: http.ServerResponse, info: FileInfo): void {
    const ffmpeg = this.getFfmpeg();
    if (!ffmpeg) { res.writeHead(503); res.end('ffmpeg unavailable'); return; }
    const args = info.kind === 'audio'
      ? ['-i', info.diskPath, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1']
      : [
          '-i', info.diskPath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          '-f', 'mp4', 'pipe:1',
        ];
    res.writeHead(200, { 'Content-Type': info.kind === 'audio' ? 'audio/mpeg' : 'video/mp4', 'Cache-Control': 'no-store' });
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    this.active.add(proc);
    const done = () => { this.active.delete(proc); try { proc.kill('SIGKILL'); } catch { /* ignore */ } };
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => { /* discard */ });
    proc.on('error', (e) => { log.warn('progressive ffmpeg error', { error: String(e) }); done(); try { res.destroy(); } catch { /* ignore */ } });
    proc.on('close', () => this.active.delete(proc));
    res.on('close', done);
    req.on('close', done);
  }

  // ── HLS playlists ────────────────────────────────────────────────────────────
  private serveMaster(res: http.ServerResponse, id: string, fileIndex: number): void {
    const q = `?k=${this.token}`;
    const base = `/hls/${encodeURIComponent(id)}/${fileIndex}`;
    let body = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const v of VARIANTS) {
      body += `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.w}x${v.h}\n${base}/${v.id}/index.m3u8${q}\n`;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  private async serveMedia(res: http.ServerResponse, info: FileInfo, id: string, fileIndex: number, variant: string): Promise<void> {
    if (!VARIANTS.some((v) => v.id === variant)) { res.writeHead(404); res.end(); return; }
    let duration: number;
    try { duration = await this.probeDuration(info.diskPath); }
    catch { res.writeHead(503); res.end('cannot probe media'); return; }
    if (!duration || duration <= 0) { res.writeHead(503); res.end('unknown duration'); return; }

    const q = `?k=${this.token}`;
    const base = `/hls/${encodeURIComponent(id)}/${fileIndex}/${variant}`;
    const count = Math.ceil(duration / SEG);
    let body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    body += `#EXT-X-TARGETDURATION:${SEG}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
    for (let i = 0; i < count; i++) {
      const segDur = i === count - 1 ? +(duration - i * SEG).toFixed(3) : SEG;
      body += `#EXTINF:${segDur.toFixed(3)},\n${base}/seg-${i}.ts${q}\n`;
    }
    body += '#EXT-X-ENDLIST\n';
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // ── On-demand segment transcode ───────────────────────────────────────────────
  private serveSegment(req: http.IncomingMessage, res: http.ServerResponse, info: FileInfo, variantId: string, index: number): void {
    const variant = VARIANTS.find((v) => v.id === variantId);
    const ffmpeg = this.getFfmpeg();
    if (!variant || !ffmpeg) { res.writeHead(404); res.end(); return; }

    const start = index * SEG;
    const args = [
      '-ss', String(start),
      '-i', info.diskPath,
      '-t', String(SEG),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=-2:${variant.height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-maxrate', variant.vMax, '-bufsize', variant.vBuf,
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', variant.aBr, '-ac', '2',
      '-force_key_frames', 'expr:gte(t,0)',
      '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(start),
      '-f', 'mpegts', 'pipe:1',
    ];

    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    this.active.add(proc);
    const done = () => { this.active.delete(proc); try { proc.kill('SIGKILL'); } catch { /* ignore */ } };
    proc.stdout.pipe(res);
    proc.stderr.on('data', () => { /* discard ffmpeg chatter */ });
    proc.on('error', (e) => { log.warn('segment ffmpeg error', { error: String(e) }); done(); try { res.destroy(); } catch { /* ignore */ } });
    proc.on('close', () => this.active.delete(proc));
    res.on('close', done);
    req.on('close', done);
  }

  /** Probe duration (seconds) by parsing ffmpeg's stderr — ffprobe isn't bundled. */
  private probeDuration(file: string): Promise<number> {
    const cached = this.durations.get(file);
    if (cached) return Promise.resolve(cached);
    const ffmpeg = this.getFfmpeg();
    if (!ffmpeg) return Promise.reject(new Error('ffmpeg unavailable'));
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-i', file], { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', reject);
      proc.on('close', () => {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        if (!m) return reject(new Error('duration not found'));
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        this.durations.set(file, secs);
        resolve(secs);
      });
    });
  }

  destroy(): void {
    for (const p of this.active) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    this.active.clear();
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } this.server = null; }
    log.info('Cast server destroyed');
  }
}

// Containers with messy/non-monotonic timestamps that break the per-segment HLS
// transcode — stream these as a single-pass MP4 instead (reliable, no seeking).
const PROGRESSIVE_EXTS = new Set(['avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'asf', 'divx', 'rm', 'rmvb', '3gp', 'ogm']);
function prefersProgressive(name: string): boolean {
  return PROGRESSIVE_EXTS.has(name.split('.').pop()?.toLowerCase() || '');
}

function directContentType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  };
  return map[ext] || 'application/octet-stream';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

let castServer: CastServer | null = null;
export function getCastServer(): CastServer {
  if (!castServer) {
    // Lazy require avoids a load-time cycle with the manager.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getTorrentManager } = require('./index');
    const mgr = getTorrentManager();
    castServer = new CastServer(
      (id: string, idx: number) => mgr.getCastFileInfo(id, idx),
      () => mgr.ffmpegBinary,
    );
  }
  return castServer;
}
