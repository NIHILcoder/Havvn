import http from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { httpFetch } from './http-fetch';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});
async function endpoint(handle: http.RequestListener): Promise<string> {
  const server = http.createServer(handle);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('HTTP response trust boundaries', () => {
  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('rejects a small %s response that expands beyond the caller limit', async (encoding, compress) => {
    const body = compress(Buffer.alloc(256 * 1024, 65));
    expect(body.length).toBeLessThan(1024);
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': encoding }); res.end(body);
    });
    await expect(httpFetch(url, { maxBytes: 64 * 1024 }).then(result => result.body.length)).rejects.toThrow('Response too large');
  });

  it('still decodes an ordinary compressed feed and tolerates an incorrect encoding header', async () => {
    const body = Buffer.from('<rss>Привет</rss>');
    const url = await endpoint((req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end(req.url === '/plain' ? body : gzipSync(body));
    });
    expect((await httpFetch(url, { maxBytes: 1024 })).body).toEqual(body);
    expect((await httpFetch(url + '/plain', { maxBytes: 1024 })).body).toEqual(body);
  });
});
