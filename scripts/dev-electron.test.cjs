const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
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

test('keeps one request open while the initial build takes more than two seconds', async () => {
  let hits = 0;
  let prematureCloses = 0;
  const server = http.createServer(async (_req, res) => {
    hits++;
    res.on('close', () => { if (!res.writableFinished) prematureCloses++; });
    await delay(2200);
    if (!res.destroyed) res.end('ready');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await waitForRenderer(`http://127.0.0.1:${server.address().port}`, { timeout: 10000, interval: 5 });
    assert.equal(hits, 1);
    assert.equal(prematureCloses, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('does not start Electron when an HTTP 200 body is cut short', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    if (++hits === 1) {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('partial');
      setImmediate(() => res.destroy());
    } else res.end('ready');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await waitForRenderer(`http://127.0.0.1:${server.address().port}`, { timeout: 1000, interval: 5 });
    assert.equal(hits, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('enforces the startup deadline even if an unfinished response keeps sending data', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write('building');
    const timer = setInterval(() => res.write('.'), 5);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      waitForRenderer(`http://127.0.0.1:${server.address().port}`, { timeout: 80, interval: 5 }),
      /did not become ready/,
    );
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('interrupting startup closes the pending build request', async () => {
  const controller = new AbortController();
  let received;
  const pendingRequest = new Promise(resolve => { received = resolve; });
  const server = http.createServer((_req, res) => {
    res.write('building');
    received();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const wait = waitForRenderer(`http://127.0.0.1:${server.address().port}`, { timeout: 10000, signal: controller.signal });
    const rejected = assert.rejects(wait, { name: 'AbortError' });
    await pendingRequest;
    controller.abort();
    await rejected;
  } finally { await new Promise(resolve => server.close(resolve)); }
});
