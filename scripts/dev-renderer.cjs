const http = require('node:http');
const path = require('node:path');
const webpack = require('webpack');
const devMiddleware = require('webpack-dev-middleware');
const hotMiddleware = require('webpack-hot-middleware');

// Only compile and serve renderer assets. No filesystem browsing or HTTP proxy.
async function startRenderer({ config, port = 3000, logger = console } = {}) {
  config ??= require('../webpack.renderer.config.js')({}, { mode: 'development' });
  const client = 'webpack-hot-middleware/client?path=/__webpack_hmr&timeout=20000&reload=true';
  const imports = typeof config.entry.bundle.import === 'string'
    ? [config.entry.bundle.import] : config.entry.bundle.import;
  config = {
    ...config, mode: 'development',
    entry: { ...config.entry, bundle: { ...config.entry.bundle, import: [client, ...imports] } },
    plugins: [...(config.plugins ?? []), new webpack.HotModuleReplacementPlugin()],
  };
  const compiler = webpack(config);
  const assets = devMiddleware(compiler, { publicPath: '/', stats: 'errors-warnings' });
  const updates = hotMiddleware(compiler, { path: '/__webpack_hmr', log: message => logger.log(message) });
  const server = http.createServer((req, res) => {
    const ownPort = server.address()?.port;
    const localHost = value => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
          && Number(url.port || 80) === ownPort && !url.username && !url.password;
      } catch { return false; }
    };
    if (!localHost(`http://${req.headers.host}`) || req.headers.origin && !localHost(req.headers.origin)) {
      res.writeHead(403); res.end('Local renderer requests only'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const fail = error => {
      if (res.headersSent) { res.destroy(error); return; }
      res.writeHead(error ? 500 : 404); res.end(error ? 'Renderer middleware failed' : 'Not found');
    };
    updates(req, res, error => {
      if (error) { fail(error); return; }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // Application navigation uses the in-memory index, never stale dist files.
      if (pathname !== '/' && !path.posix.extname(pathname) && req.headers.accept?.includes('text/html')) {
        req.url = '/index.html';
      }
      assets(req, res, fail);
    });
  });
  let closing;
  const close = () => closing ??= (async () => {
    updates.close();
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => assets.close(resolve));
    await new Promise(resolve => compiler.close(resolve));
  })();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) { await close(); throw error; }
  server.on('error', error => logger.error(error));
  const url = `http://127.0.0.1:${server.address().port}`;
  logger.log(`[dev] Renderer running at ${url}/ (watch + HMR)`);
  return { url, compiler, close };
}

if (require.main === module) {
  startRenderer().then(app => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      app.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    });
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { startRenderer };
