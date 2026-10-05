const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { startRenderer } = require('./dev-renderer.cjs');

function request(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers, method }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout'))); req.end();
  });
}

test('serves a cold renderer, rejects external origins and emits HMR after edits', { timeout: 30000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'havvn-dev-renderer-'));
  const entry = path.join(dir, 'entry.js');
  await fs.writeFile(entry, 'console.log("fixture-first");');
  await fs.writeFile(path.join(dir, 'startup.js'), 'console.log("startup");');
  const config = {
    context: path.resolve(__dirname, '..'), mode: 'development', target: 'web',
    entry: { startup: path.join(dir, 'startup.js'), bundle: { import: entry, dependOn: 'startup' } },
    output: { path: path.join(dir, 'output'), filename: '[name].js', publicPath: '/' },
    plugins: [new HtmlWebpackPlugin({ templateContent: '<html><body>renderer fixture</body></html>', chunks: ['startup','bundle'] })],
  };
  let app, stream;
  try {
    app = await startRenderer({ config, port: 0, logger: { log() {}, error() {} } });
    const page = await request(app.url);
    assert.equal(page.status, 200); assert.match(page.body, /renderer fixture/);
    assert.match(page.body, /startup.js/); assert.match(page.body, /bundle.js/);
    const bundle = await request(app.url + '/bundle.js');
    assert.equal(bundle.status, 200); assert.match(bundle.body, /fixture-first/);
    assert.equal((await request(app.url + '/room/local', { Accept: 'text/html' })).status, 200);
    assert.equal((await request(app.url + '/missing.js')).status, 404);
    assert.equal((await request(app.url, { Host: 'untrusted.example' })).status, 403);
    assert.equal((await request(app.url, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await request(app.url, {}, 'POST')).status, 405);
    const changed = new Promise((resolve, reject) => {
      let previous, pending = '';
      stream = http.get(app.url + '/__webpack_hmr', res => {
        res.on('error', reject);
        res.on('data', chunk => {
          pending += chunk;
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            if (!['sync', 'built'].includes(event.action)) continue;
            if (!previous) {
              previous = event.hash;
              fs.writeFile(entry, 'console.log("fixture-second");').catch(reject);
            } else if (event.action === 'built' && event.hash !== previous) {
              if (event.errors?.length) reject(new Error(event.errors.join('\n'))); else resolve();
            }
          }
        });
      });
      stream.on('error', reject);
      stream.setTimeout(15000, () => stream.destroy(new Error('HMR timeout')));
    });
    await changed;
    assert.match((await request(app.url + '/bundle.js')).body, /fixture-second/);
    // Shutdown must close the long-lived update connection and the compiler watch.
    await app.close(); await app.close(); app = null;
  } finally {
    stream?.destroy(); await app?.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('havvn-dev-renderer-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
