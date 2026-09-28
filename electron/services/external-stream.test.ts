import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { ExternalStream } from './external-stream';
const streams: ExternalStream[] = [];
afterEach(() => { for (const s of streams.splice(0)) s.close(); });
function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
}
async function fixture() {
  const s = new ExternalStream(10, async (start, max) => ({ data: Buffer.from('0123456789').subarray(start, start + max).toString('base64') }), () => s.close());
  streams.push(s); return { s, url: await s.url() };
}
it('supports exact, suffix, clamped and open ranges, HEAD and complete GET', async () => {
  const { url } = await fixture();
  for (const [range, body, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-20', '89', 'bytes 8-9/10'], ['bytes=7-', '789', 'bytes 7-9/10']]) {
    const r = await request(url, { Range: range }); expect(r.status).toBe(206); expect(r.body).toBe(body); expect(r.headers['content-range']).toBe(contentRange); expect(Number(r.headers['content-length'])).toBe(body.length);
  }
  expect((await request(url)).body).toBe('0123456789');
  const head = await request(url, {}, 'HEAD'); expect(head.status).toBe(200); expect(head.body).toBe(''); expect(head.headers['content-length']).toBe('10');
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=999999999999999999999-']) { const r = await request(url, { Range: range }); expect(r.status).toBe(416); expect(r.headers['content-range']).toBe('bytes */10'); }
});
it('scopes a secret to one file and rejects cross-origin, rebinding and unsupported methods', async () => {
  const { url } = await fixture();
  expect((await request(url.replace(/k=.*/, 'k=wrong'))).status).toBe(403);
  expect((await request(url, { Origin: 'https://evil.test' })).status).toBe(403);
  expect((await request(url, { Host: 'evil.test' })).status).toBe(403);
  expect((await request(url.replace('/media?', '/other?'))).status).toBe(404);
  expect((await request(url + '&file=another')).status).toBe(404);
  expect((await request(url, {}, 'POST')).status).toBe(405);
});
it('keeps the requested full range open at a hole and continues when verified bytes arrive', async () => {
  let available = 2, received = '', release!: () => void;
  const first = new Promise<void>(r => release = r);
  const s = new ExternalStream(10, async (start, max) => start >= available ? { wait: true } : { data: Buffer.from('0123456789').subarray(start, Math.min(start + max, available)).toString('base64') }, () => s.close()); streams.push(s);
  const url = await s.url();
  const completed = new Promise<void>((resolve, reject) => {
    http.get(url, res => { expect(res.statusCode).toBe(200); expect(res.headers['content-length']).toBe('10'); res.on('data', c => { received += c; release(); }); res.on('end', resolve); res.on('error', reject); }).on('error', reject);
  });
  await first; expect(received).toBe('01');
  await new Promise(r => setTimeout(r, 350)); expect(received).toBe('01');
  available = 10; await completed; expect(received).toBe('0123456789');
  expect((await request(url, { Range: 'bytes=8-9' })).body).toBe('89');
});
it('revocation aborts an active wait and refuses further connections', async () => {
  const s = new ExternalStream(10, async () => ({ wait: true }), () => s.close()); streams.push(s); const url = await s.url();
  await new Promise<void>((resolve, reject) => {
    http.get(url, res => { res.once('close', resolve); res.on('error', () => {}); s.close(); }).on('error', reject);
  });
  await expect(request(url)).rejects.toThrow(); await expect(s.url()).rejects.toThrow('closed');
});
