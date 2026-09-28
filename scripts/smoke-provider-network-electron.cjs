// Isolated profile, no real sites, no user credentials. Run after build:electron.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.env.HAVVN_TEST_ELECTRON || require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const http = require('node:http'), assert = require('node:assert/strict');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-provider-test-')));
  const deadline = setTimeout(() => { console.error('Smoke deadline exceeded'); app.exit(1); }, 25000);
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  app.whenReady().then(async () => {
    const { ProviderNetworkService } = require('../dist/electron/electron/services/provider-network');
    const service = new ProviderNetworkService();
    const hits = [];
    const origin = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/login') { res.setHeader('Set-Cookie', ['session=test; Path=/; HttpOnly', 'strict=test; Path=/; HttpOnly; SameSite=Strict', 'lax=test; Path=/; HttpOnly; SameSite=Lax']); res.end('ok'); }
      else if (req.url === '/cookies') { res.end(req.headers.cookie || ''); }
      else if (req.url === '/browser-only') {
        if (req.headers['sec-fetch-mode'] !== 'navigate') { res.writeHead(403, { 'cf-mitigated': 'challenge' }); res.end('challenge'); }
        else if (!req.headers.cookie?.includes('session=test')) { res.writeHead(401); res.end('login required'); }
        else { res.setHeader('Content-Type', 'text/html; charset=windows-1251'); res.end(Buffer.concat([Buffer.from('<html><body>'), Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]), Buffer.from('</body></html>')])); }
      }
      else if (req.url === '/challenge-page') { res.writeHead(403, { 'Content-Type': 'text/html' }); res.end('<html>cf-chl-challenge</html>'); }
      else if (req.url === '/ua') { res.end(req.headers['user-agent']); }
      else if (req.url === '/private') { res.statusCode = req.headers.cookie?.includes('session=test') ? 200 : 401; res.end('private'); }
      else if (req.url === '/redirect') { res.writeHead(302, { Location: '/private' }); res.end(); }
      else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
      else if (req.url === '/external') { res.writeHead(302, { Location: 'http://localhost:1/private' }); res.end(); }
      else if (req.url === '/body-stall') { res.writeHead(200); res.write('start'); }
      else if (req.url === '/slow') { /* deliberate stall */ }
      else if (req.url === '/large') { res.end('x'.repeat(4096)); }
      else { res.end('direct'); }
    });
    const originPort = await listen(origin);
    const base = 'http://127.0.0.1:' + originPort;
    let proxyHits = 0;
    const proxy = http.createServer((req, res) => {
      proxyHits++; res.end('proxied');
    });
    const proxyPort = await listen(proxy);
    const direct = { mode: 'direct' };
    const opts = { allowedOrigins: [base] };
    const fetch = (id, route, p, extra = {}) => { console.log('CHECK', id, route.mode, p); return service.request(id, route, base + p, { ...opts, ...extra }); };
    try {
      const { readProviderPage } = require('../dist/electron/electron/services/provider-browser');
      const { providerNetwork } = require('../dist/electron/electron/services/provider-network');
      const browserSignal = new AbortController();
      await providerNetwork.request('browser-test', direct, base + '/login', opts);
      await assert.rejects(providerNetwork.request('browser-test', direct, base + '/browser-only', opts), e => e.code === 'captcha');
      const browserResult = await readProviderPage('browser-test', direct, base + '/browser-only', [base], browserSignal.signal);
      assert.ok(browserResult.body.toString('utf8').includes('\u041f\u0440\u0438\u0432\u0435\u0442'), 'Browser HTML preserves Cyrillic');
      await assert.rejects(readProviderPage('browser-test', direct, base + '/challenge-page', [base], browserSignal.signal), e => e.code === 'captcha');
      await assert.rejects(readProviderPage('browser-test', direct, base + '/external', [base], browserSignal.signal), e => e.code === 'redirect');
      await assert.rejects(readProviderPage('browser-test', direct, base + '/browser-only', [base], browserSignal.signal, 8), e => e.code === 'too-large');
      const browserCancel = new AbortController();
      const browserPending = readProviderPage('browser-test', direct, base + '/slow', [base], browserCancel.signal);
      setTimeout(() => browserCancel.abort(), 80);
      await assert.rejects(browserPending, e => e.code === 'cancelled');
      assert.equal(require('electron').BrowserWindow.getAllWindows().length, 0, 'Browser requests leave no windows');
      console.log('PASS: browser navigation, session, Cyrillic, challenges, redirect policy, size and cancellation');
      const lease = await service.acquireSession('window-login', direct);
      const { BrowserWindow } = require('electron');
      const loginWindow = new BrowserWindow({ show: false, webPreferences: { session: lease.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await loginWindow.loadURL(base + '/login');
        const cookies = (await fetch('window-login', direct, '/cookies')).text();
        assert.ok(cookies.includes('strict=test'), 'Strict cookies must reach authenticated search');
        assert.ok(cookies.includes('lax=test'), 'Lax cookies must reach authenticated search');
        const browserUA = await loginWindow.webContents.executeJavaScript('navigator.userAgent');
        const networkUA = await fetch('window-login', direct, '/ua', { headers: { 'user-agent': 'Legacy Python UA' } });
        assert.equal(networkUA.text(), browserUA, 'Search must use the same User-Agent as sign-in');
        assert.equal((await fetch('window-login', direct, '/private')).text(), 'private');
        await assert.rejects(fetch('other-window', direct, '/private'), e => e.code === 'auth');
        await service.reset('window-login', true);
        assert.equal(lease.signal.aborted, true);
        await assert.rejects(fetch('window-login', direct, '/private'), e => e.code === 'auth');
      } finally { loginWindow.destroy(); lease.release(); }
      console.log('PASS: BrowserWindow sign-in shares cookies with search, isolation and logout');
      assert.equal((await fetch('a', direct, '/')).text(), 'direct');
      await fetch('a', direct, '/login');
      assert.equal((await fetch('a', direct, '/redirect')).text(), 'private');
      await assert.rejects(fetch('b', direct, '/private'), e => e.code === 'auth');
      await assert.rejects(fetch('a', direct, '/loop'), e => e.code === 'redirect');
      await assert.rejects(fetch('a', direct, '/external'), e => e.code === 'redirect');
      await assert.rejects(fetch('a', direct, '/large', { maxBytes: 16 }), e => e.code === 'too-large');
      await assert.rejects(fetch('a', direct, '/slow', { timeoutMs: 80 }), e => e.code === 'timeout');
      await assert.rejects(fetch('a', direct, '/body-stall', { timeoutMs: 80 }), e => e.code === 'timeout');
      const cancel = new AbortController();
      const pending = fetch('a', direct, '/slow', { signal: cancel.signal });
      setTimeout(() => cancel.abort(), 40);
      await assert.rejects(pending, e => e.code === 'cancelled');
      const route = { mode: 'proxy', protocol: 'http', host: '127.0.0.1', port: proxyPort };
      assert.equal((await fetch('a', route, '/')).text(), 'proxied');
      assert.equal(proxyHits, 1);
      assert.equal((await fetch('a', direct, '/')).text(), 'direct');
      proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
      const before = hits.length;
      await assert.rejects(fetch('a', route, '/', { timeoutMs: 1500 }), e => ['proxy', 'network', 'timeout'].includes(e.code));
      assert.equal(hits.length, before, 'failed proxy must never fall back to direct');
      // A synthetic SOCKS5 server proves remote DNS: the .invalid host is
      // received as a domain in CONNECT, rather than resolved by the client.
      let socksHost = '';
      const socks = require('node:net').createServer(socket => {
        let phase = 0, buffered = Buffer.alloc(0);
        socket.on('data', data => {
          buffered = Buffer.concat([buffered, data]);
          if (phase === 0) {
            if (buffered.length < 2 + buffered[1]) return;
            buffered = buffered.subarray(2 + buffered[1]);
            socket.write(Buffer.from([5, 0])); phase = 1;
          }
          if (phase === 1) {
            if (buffered.length < 5) return;
            const type = buffered[3];
            const bytes = type === 3 ? 7 + buffered[4] : type === 1 ? 10 : 22;
            if (buffered.length < bytes) return;
            socksHost = type === 3 ? buffered.subarray(5, 5 + buffered[4]).toString() : 'ip';
            buffered = buffered.subarray(bytes);
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); phase = 2;
          }
          if (phase === 2 && buffered.includes(Buffer.from('\r\n\r\n'))) {
            phase = 3; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nsocks');
          }
        });
        socket.on('error', () => {});
      });
      const socksPort = await listen(socks);
      try {
        const remote = 'http://havvn-network-test.invalid';
        const result = await service.request('socks-source', { mode: 'proxy', protocol: 'socks5', host: '127.0.0.1', port: socksPort }, remote, { allowedOrigins: [remote] });
        assert.equal(result.text(), 'socks');
        assert.equal(socksHost, 'havvn-network-test.invalid');
      } finally { socks.close(); }
      console.log('PASS: SOCKS5 and remote DNS');
      const certificate = await require('selfsigned').generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, days: 1 });
      const tlsServer = require('node:https').createServer({ key: certificate.private, cert: certificate.cert }, (_req, res) => res.end('untrusted'));
      const tlsPort = await listen(tlsServer);
      try {
        const target = 'https://127.0.0.1:' + tlsPort;
        await assert.rejects(service.request('tls-source', direct, target, { allowedOrigins: [target] }), error => error.code === 'tls');
      } finally { tlsServer.closeAllConnections(); tlsServer.close(); }
      console.log('PASS: untrusted TLS certificates are rejected');
      const { openProviderNetworkBridge } = require('../dist/electron/electron/services/provider-network-bridge');
      const bridge = await openProviderNetworkBridge('python-source', direct, [base]);
      try {
        const denied = await globalThis.fetch(bridge.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
        assert.equal(denied.status, 403);
        if (process.env.HAVVN_TEST_PYTHON) {
          const { promisify } = require('node:util');
          const run = promisify(require('node:child_process').execFile);
          await run(process.env.HAVVN_TEST_PYTHON, ['-c', "import sys; from havvn_network import request, browser_html; request(sys.argv[1]+'/login'); assert request(sys.argv[1]+'/private') == b'private'; assert '\u041f\u0440\u0438\u0432\u0435\u0442' in browser_html(sys.argv[1]+'/browser-only')", base], {
            windowsHide: true, timeout: 8000,
            env: { ...process.env, PYTHONPATH: path.join(__dirname, '../docs/search-plugins'), HAVVN_NETWORK_URL: bridge.url, HAVVN_NETWORK_TOKEN: bridge.token },
          });
          console.log('PASS: Python SDK login and authenticated request share the Chromium cookie jar');
        }
        const forbidden = await globalThis.fetch(bridge.url, { method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token }, body: JSON.stringify({ method: 'GET', url: 'http://localhost:1/secret' }) });
        assert.equal(forbidden.status, 502);
        assert.equal((await forbidden.json()).error, 'redirect');
      } finally { await bridge.close(); }
      await assert.rejects(globalThis.fetch(bridge.url, { method: 'POST', body: '{}' }));
      await service.reset('a', true); await service.reset('b', true);
      console.log('PASS: direct, session cookies, isolation, redirects, size limit, timeout, cancellation, proxy, route change, no direct fallback');
      clearTimeout(deadline); app.exit(0);
    } finally { origin.closeAllConnections(); origin.close(); proxy.closeAllConnections(); proxy.close(); }
  }).catch(error => { console.error(error); app.exit(1); });
}
