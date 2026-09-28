import http from 'node:http';
import crypto from 'node:crypto';
import type { ExternalMediaRead } from '../../shared/external-player';

/** One revocable, loopback-only URL for exactly one file. No idle token expiry:
 * buffering and long pauses must not invalidate the player's later seeks. */
export class ExternalStream {
  private readonly token = crypto.randomBytes(32).toString('hex');
  private readonly server: http.Server;
  private readonly responses = new Set<http.ServerResponse>();
  private closed = false;
  private requests = 0;
  constructor(private readonly length: number, private readonly read: (start: number, max: number) => Promise<ExternalMediaRead>, private readonly invalid: () => void) {
    this.server = http.createServer((req, res) => { void this.handle(req, res).catch(() => { this.invalid(); res.destroy(); }); });
    this.server.requestTimeout = 0;
  }
  async url(): Promise<string> {
    if (this.closed) throw new Error('Stream closed');
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); }); });
    if (this.closed) { this.server.close(); throw new Error('Stream closed'); }
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}/media?k=${this.token}`;
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const res of this.responses) res.destroy(); this.responses.clear();
    this.server.closeAllConnections(); this.server.close();
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.on('error', () => {});
    const url = new URL(req.url || '', 'http://127.0.0.1');
    if (this.closed || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') || req.headers.origin || url.searchParams.get('k') !== this.token) { res.writeHead(403); res.end(); return; }
    if (url.pathname !== '/media' || [...url.searchParams.keys()].some(k => k !== 'k')) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (this.requests >= 16) { res.writeHead(503); res.end(); return; }
    let start = 0, end = this.length - 1;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (m && (m[1] || m[2])) {
        if (!m[1]) { const suffix = Number(m[2]); start = suffix > 0 ? Math.max(0, this.length - suffix) : this.length; }
        else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end; }
      } else start = this.length;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= this.length) { res.writeHead(416, { 'Content-Range': `bytes */${this.length}` }); res.end(); return; }
    res.writeHead(req.headers.range ? 206 : 200, {
      'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      'Content-Length': end - start + 1, ...(req.headers.range ? { 'Content-Range': `bytes ${start}-${end}/${this.length}` } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    res.flushHeaders(); this.requests++; this.responses.add(res);
    try {
      while (!this.closed && !res.destroyed && start <= end) {
        const result = await this.read(start, Math.min(256 * 1024, end - start + 1));
        if (this.closed || res.destroyed) return;
        if ('reason' in result) { this.invalid(); return; }
        if ('wait' in result) { await new Promise<void>(r => setTimeout(r, 300)); continue; }
        const data = Buffer.from(result.data, 'base64');
        if (!data.length || data.length > Math.min(256 * 1024, end - start + 1)) { this.invalid(); return; }
        start += data.length;
        if (!res.write(data)) await new Promise<void>(resolve => {
          const finish = () => { res.removeListener('drain', finish); res.removeListener('close', finish); resolve(); };
          res.once('drain', finish); res.once('close', finish);
          if (res.destroyed) finish();
        });
      }
      if (!res.destroyed) res.end();
    } finally { this.requests--; this.responses.delete(res); }
  }
}
