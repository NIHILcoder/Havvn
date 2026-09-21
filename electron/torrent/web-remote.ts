/**
 * WebRemoteServer — "Mobile Web Remote".
 *
 * A small LAN HTTP server that lets a phone (or any browser on the same network)
 * control downloads AND watch/listen to their files. Media playback is delegated
 * entirely to the existing CastServer (direct / HLS / on-the-fly transcode with
 * seeking), so there's no new media code here.
 *
 * Security (this is an inbound control surface, so it's locked down):
 *   • OFF by default — never starts unless the user enables it in Settings.
 *   • Every request must carry a random token (X-TH-Token header for the API,
 *     ?k= for media URLs); compared with crypto.timingSafeEqual.
 *   • Host-header allow-list (loopback or the bound LAN IP) blocks DNS rebinding.
 *   • Binds the LAN so it's reachable from the phone, but the token is what
 *     actually gates access. No arbitrary filesystem access — only torrents the
 *     manager already knows about.
 */

import http from 'http';
import crypto from 'crypto';
import { logger } from '../utils';
import { CastServer } from './cast-server';

const log = logger.child('WebRemote');

type Mgr = import('./host/manager-proxy.js').TorrentManagerProxy;

export class WebRemoteServer {
  private server: http.Server | null = null;
  private port = 0;
  private token = '';

  private mgr(): Mgr {
    // Lazy require avoids a load-time cycle with the manager (cast-server does the same).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getTorrentManager } = require('./index');
    return getTorrentManager();
  }

  isRunning(): boolean { return !!this.server; }

  /** { running, url, port } — url includes the token so it can be shown as a QR. */
  getInfo(): { running: boolean; url: string | null; port: number } {
    if (!this.server) return { running: false, url: null, port: 0 };
    const lan = CastServer.lanAddress();
    const url = lan ? `http://${lan}:${this.port}/?k=${this.token}` : null;
    return { running: true, url, port: this.port };
  }

  /** Start (idempotent). Restarts if the port or token changed. */
  async start(port: number, token: string): Promise<void> {
    if (this.server && this.port === port && this.token === token) return;
    await this.stop();
    this.token = token;
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (e) => { log.error('Server error', { error: String(e) }); reject(e); });
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        log.info('Web remote started', { port: this.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    log.info('Web remote stopped');
  }

  destroy(): void { void this.stop(); }

  // ── Auth & security ────────────────────────────────────────────────────────

  private tokenOk(provided: string | null): boolean {
    if (!provided || !this.token) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  }

  /** Host header must be loopback or the bound LAN IP — blocks DNS rebinding. */
  private hostOk(req: http.IncomingMessage): boolean {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return true;
    const lan = CastServer.lanAddress();
    return !!lan && host === lan.toLowerCase();
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      if (!this.hostOk(req)) { res.writeHead(403); res.end('forbidden'); return; }
      const url = new URL(req.url || '', 'http://remote');
      const provided = req.headers['x-th-token'] as string | undefined ?? url.searchParams.get('k');
      if (!this.tokenOk(provided ?? null)) { res.writeHead(403); res.end('forbidden'); return; }

      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method || 'GET';

      if (parts.length === 0) return void this.serveApp(res);

      if (parts[0] === 'api') {
        if (parts[1] === 'state' && method === 'GET') return void this.apiState(res);
        if (parts[1] === 'files' && parts[2] && method === 'GET') return void this.apiFiles(res, decodeURIComponent(parts[2]));
        if (parts[1] === 'add' && method === 'POST') return void this.apiAdd(req, res);
        if (parts[1] === 'torrents' && parts[2] && parts[3] && method === 'POST') {
          return void this.apiControl(res, decodeURIComponent(parts[2]), parts[3]);
        }
        res.writeHead(404); res.end('{}'); return;
      }

      if (parts[0] === 'watch' && parts[1] && parts[2] !== undefined) {
        return void this.watch(res, decodeURIComponent(parts[1]), Number(parts[2]));
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      log.error('Request failed', { error: String(e) });
      try { res.writeHead(500); res.end(); } catch { /* ignore */ }
    }
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(s);
  }

  private async readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = ''; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1_000_000) { req.destroy(); resolve(null); return; } data += c; });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  // ── API handlers ─────────────────────────────────────────────────────────

  private async apiState(res: http.ServerResponse): Promise<void> {
    const mgr = this.mgr();
    const downloads = await mgr.getDownloads();
    const stats = new Map(mgr.getStats().map((s) => [s.id, s]));
    const list = downloads
      .filter((d) => d.status !== 'removed')
      .map((d) => {
        const st = stats.get(d.id);
        return {
          id: d.id,
          name: d.name,
          status: st?.status ?? d.status,
          progress: st?.progress ?? d.progress,
          size: d.totalSize,
          down: st?.downSpeedBps ?? 0,
          up: st?.upSpeedBps ?? 0,
          peers: st?.peers ?? 0,
        };
      });
    this.json(res, 200, { downloads: list });
  }

  private async apiFiles(res: http.ServerResponse, id: string): Promise<void> {
    try {
      const files = (await this.mgr().getFiles(id)).map((f, index) => ({
        index, name: f.name, size: f.length, progress: f.progress,
      }));
      this.json(res, 200, { files });
    } catch (e) {
      this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async apiAdd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const magnet = body && typeof body.magnet === 'string' ? body.magnet.trim() : '';
    if (!/^magnet:\?/i.test(magnet)) { this.json(res, 400, { error: 'A magnet link is required' }); return; }
    try {
      const d = await this.mgr().addDownload({ sourceType: 'magnet', sourceUri: magnet });
      this.json(res, 200, { ok: true, id: d.id });
    } catch (e) {
      this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async apiControl(res: http.ServerResponse, id: string, action: string): Promise<void> {
    const mgr = this.mgr();
    try {
      switch (action) {
        case 'pause': await mgr.pauseDownload(id); break;
        case 'resume': await mgr.resumeDownload(id); break;
        case 'recheck': await mgr.recheckDownload(id); break;
        case 'remove': await mgr.removeDownload(id, false); break;
        default: this.json(res, 404, { error: 'unknown action' }); return;
      }
      this.json(res, 200, { ok: true });
    } catch (e) {
      this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Publish the file on the cast server and redirect the phone to its player. */
  private async watch(res: http.ServerResponse, id: string, fileIndex: number): Promise<void> {
    try {
      // Cast server runs in the torrent host; publish via the manager proxy.
      const out = await this.mgr().castPublish(id, fileIndex);
      if (!out || !out.url) { res.writeHead(503); res.end('no network address'); return; }
      res.writeHead(302, { Location: out.url }); res.end();
    } catch (e) {
      res.writeHead(400); res.end(String(e instanceof Error ? e.message : e));
    }
  }

  // ── Mobile SPA ─────────────────────────────────────────────────────────────

  private serveApp(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(MOBILE_APP_HTML);
  }
}

// Self-contained mobile control app. Reads ?k= from the URL and sends it as the
// X-TH-Token header on every API call; opens /watch/<id>/<idx>?k= for playback.
const MOBILE_APP_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Havvn Remote</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0e17;color:#e7e7ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
header{position:sticky;top:0;background:#0b0e17;border-bottom:1px solid #23232a;padding:14px 16px;display:flex;align-items:center;gap:10px;z-index:5}
header h1{font-size:16px;margin:0;font-weight:700;flex:1}
.add{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid #1a1a20}
.add input{flex:1;min-width:0;background:#15151c;border:1px solid #2a2a33;color:#e7e7ea;border-radius:10px;padding:10px 12px;font-size:14px}
.add button,.btn{background:#e7e7ea;color:#0b0e17;border:0;border-radius:10px;padding:10px 14px;font-weight:700;font-size:14px}
.list{padding:8px 12px 40px}
.card{background:#13131a;border:1px solid #23232a;border-radius:14px;padding:14px;margin:10px 0}
.name{font-size:14px;font-weight:600;word-break:break-word}
.meta{font-size:12px;color:#9a9aa2;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap}
.bar{height:6px;background:#23232a;border-radius:3px;overflow:hidden;margin:10px 0}
.fill{height:100%;background:#e7e7ea}
.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.row button{flex:1;background:#1c1c24;color:#e7e7ea;border:1px solid #2a2a33;border-radius:10px;padding:9px;font-size:13px;font-weight:600}
.row button.danger{color:#f87171;border-color:#3a2326}
.files{margin-top:10px;border-top:1px solid #23232a;padding-top:8px}
.file{display:flex;align-items:center;gap:8px;padding:8px 4px;font-size:13px;border-bottom:1px solid #1a1a20}
.file .fn{flex:1;word-break:break-word}
.file a{color:#0b0e17;background:#e7e7ea;border-radius:8px;padding:6px 10px;text-decoration:none;font-weight:700;font-size:12px}
.empty{color:#9a9aa2;text-align:center;padding:48px 16px;font-size:14px}
.s-downloading{color:#60a5fa}.s-seeding,.s-completed{color:#22c55e}.s-error{color:#f87171}.s-paused{color:#f59e0b}
</style></head><body>
<header><h1>Havvn Remote</h1></header>
<div class="add"><input id="mag" placeholder="magnet:?xt=…" inputmode="url"><button onclick="addMag()">Add</button></div>
<div class="list" id="list"><div class="empty">Loading…</div></div>
<script>
var K=new URLSearchParams(location.search).get('k')||'';
var openFiles={};
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'X-TH-Token':K},opts.headers||{});return fetch(path,opts);}
function fmtB(n){if(!n)return'0 B';var u=['B','KB','MB','GB','TB'],i=Math.floor(Math.log(n)/Math.log(1024));return (n/Math.pow(1024,i)).toFixed(1)+' '+u[i];}
function addMag(){var m=document.getElementById('mag');if(!m.value.trim())return;api('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({magnet:m.value.trim()})}).then(function(r){return r.json();}).then(function(j){if(j.error)alert(j.error);else{m.value='';refresh();}});}
function ctl(id,a){api('/api/torrents/'+encodeURIComponent(id)+'/'+a,{method:'POST'}).then(function(){setTimeout(refresh,300);});}
function rm(id){if(confirm('Remove this torrent?'))ctl(id,'remove');}
function toggleFiles(id){if(openFiles[id]){delete openFiles[id];render(LAST);return;}api('/api/files/'+encodeURIComponent(id)).then(function(r){return r.json();}).then(function(j){openFiles[id]=j.files||[];render(LAST);});}
var LAST={downloads:[]};
function render(state){LAST=state;var L=document.getElementById('list');var d=state.downloads||[];if(!d.length){L.innerHTML='<div class="empty">No downloads yet. Paste a magnet above.</div>';return;}
L.innerHTML=d.map(function(t){var pct=Math.round((t.progress||0)*100);var files=openFiles[t.id];
var fhtml=files?('<div class="files">'+(files.length?files.map(function(f){return '<div class="file"><span class="fn">'+esc(f.name)+'</span>'+(f.progress>=0.999?'<a href="/watch/'+encodeURIComponent(t.id)+'/'+f.index+'?k='+K+'">Watch</a>':'<span style="color:#9a9aa2;font-size:12px">'+Math.round((f.progress||0)*100)+'%</span>')+'</div>';}).join(''):'<div class="file">No files</div>')+'</div>'):'';
return '<div class="card"><div class="name">'+esc(t.name)+'</div>'+
'<div class="meta"><span class="s-'+t.status+'">'+t.status+'</span><span>'+pct+'%</span><span>'+fmtB(t.size)+'</span><span>↓'+fmtB(t.down)+'/s</span><span>↑'+fmtB(t.up)+'/s</span></div>'+
'<div class="bar"><div class="fill" style="width:'+pct+'%"></div></div>'+
'<div class="row"><button onclick="ctl(\\''+t.id+'\\',\\'pause\\')">Pause</button><button onclick="ctl(\\''+t.id+'\\',\\'resume\\')">Resume</button><button onclick="toggleFiles(\\''+t.id+'\\')">Files</button><button class="danger" onclick="rm(\\''+t.id+'\\')">Remove</button></div>'+
fhtml+'</div>';}).join('');}
function esc(s){return (s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function refresh(){api('/api/state').then(function(r){if(r.status===403){document.getElementById('list').innerHTML='<div class="empty">Access denied — open the link from the app again.</div>';throw 0;}return r.json();}).then(render).catch(function(){});}
refresh();setInterval(refresh,1500);
</script></body></html>`;

let instance: WebRemoteServer | null = null;
export function getWebRemoteServer(): WebRemoteServer {
  if (!instance) instance = new WebRemoteServer();
  return instance;
}
