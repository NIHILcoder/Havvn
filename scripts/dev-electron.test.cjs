const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { waitForRenderer } = require('./dev-electron.cjs');

test('waits for an HTTP 200 response, not just an open port', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { res.writeHead(++hits < 3 ? 503 : 200); res.end('ready'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await waitForRenderer(`http://127.0.0.1:${server.address().port}`, { timeout: 1000, interval: 5 });
    assert.equal(hits, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('times out cleanly when the renderer is unavailable', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(waitForRenderer(`http://127.0.0.1:${port}`, { timeout: 40, interval: 5 }), /did not become ready/);
});

test('interrupting startup cancels the wait', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForRenderer('http://127.0.0.1:1', { signal: controller.signal }), { name: 'AbortError' });
});
