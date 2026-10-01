// Real Electron, isolated stores and loopback sources/proxy; no public trackers.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const http = require('node:http'), assert = require('node:assert/strict');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-http-mirrors-'));
  fs.mkdirSync(path.join(profile, 'temp')); app.setPath('userData', profile); app.setPath('temp', path.join(profile, 'temp'));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Mirror smoke deadline'); app.exit(1); }, 45000);
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const torrent = Buffer.from('d4:infod6:lengthi0e4:name4:test12:piece lengthi16384e6:pieces0:ee');
  app.whenReady().then(async () => {
    const { SearchService } = require('../dist/electron/electron/services/search-service');
    const db = require('../dist/electron/electron/db/store');
    const store = require('../dist/electron/electron/services/provider-network-store');
    const { providerNetwork } = require('../dist/electron/electron/services/provider-network');
    const { readHttpMirrors } = require('../dist/electron/electron/services/provider-mirrors');
    const hits = [], proxyHits = [];
    let primaryStatus = 503, mirrorStatus = 200;
    function respond(req, res, side) {
      hits.push({ side, url: req.url, cookie: req.headers.cookie || '' });
      const url = new URL(req.url, 'http://test');
      if (url.pathname.endsWith('/stall')) return;
      const status = side === 'primary' ? primaryStatus : mirrorStatus;
      if (status !== 200) { res.writeHead(status, status === 429 ? { 'Retry-After': '60' } : {}); res.end('Unavailable'); return; }
      if (url.pathname.endsWith('/torrent')) { res.setHeader('Content-Type', 'application/x-bittorrent'); res.end(torrent); return; }
      if (url.searchParams.get('t') === 'caps') { res.setHeader('Content-Type', 'application/xml'); res.end('<caps><searching><search available="yes"/></searching><categories/></caps>'); return; }
      if (side === 'mirror' && !req.headers.cookie?.includes('mirror-session=test')) { res.writeHead(401); res.end('Sign in'); return; }
      if (url.pathname.includes('/torznab')) {
        res.setHeader('Content-Type', 'application/xml');
        res.end('<rss><channel><item><title>Example release</title><link>torrent?id=test-token</link></item></channel></rss>');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(url.pathname.includes('/jackett') ? { Results: [{ Title: 'Example release', Link: 'torrent?id=test-token' }] } : { results: [{ title: 'Example release', torrentUrl: 'torrent?id=test-token', media: { audioLanguages: ['ENG'], subtitleLanguages: ['RUS'] } }] }));
      }
    }
    const primary = http.createServer((req, res) => respond(req, res, 'primary'));
    const mirror = http.createServer((req, res) => respond(req, res, 'mirror'));
    const primaryBase = 'http://127.0.0.1:' + await listen(primary);
    const mirrorBase = 'http://localhost:' + await listen(mirror);
    const proxy = http.createServer((req, res) => {
      const target = new URL(req.url); proxyHits.push(req.url);
      if (![primaryBase, mirrorBase].includes(target.origin)) { res.writeHead(403); res.end(); return; }
      const upstream = http.request(target, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => upstream.destroy()); req.pipe(upstream);
    });
    const proxyPort = await listen(proxy);
    const network = store.saveSearchNetworkProfile({ name: 'Test proxy', connection: { mode: 'proxy', protocol: 'http', host: '127.0.0.1', port: proxyPort } });
    const service = new SearchService(); const providers = [];
    const search = async provider => {
      const events = []; let done;
      const finished = new Promise(resolve => { done = resolve; });
      await service.start('example', undefined, event => { events.push(event); if (event.done) done(); }, { providerId: provider.id, refresh: true });
      await finished; return events;
    };
    try {
      for (const type of ['custom', 'jackett', 'torznab']) {
        const provider = await db.addSearchProvider({ name: type, type, enabled: true, url: primaryBase + (type === 'custom' ? '/search?q={query}&test=one%2Btwo' : '/' + type), apiKey: '' }); providers.push(provider);
        const alias = mirrorBase + (type === 'custom' ? '/copy' : '/copy/' + type);
        store.setProviderAccess(provider.id, { profileId: network.id, origins: [], mirrors: [alias] });
        const lease = await providerNetwork.acquireSession(provider.id, network.connection);
        await lease.session.cookies.set({ url: mirrorBase, name: 'mirror-session', value: 'test', httpOnly: true }); lease.release();
        if (type !== 'custom') assert.equal((await service.testProvider(provider.id)).success, true);
        const started = Date.now(), events = await search(provider);
        const result = events.flatMap(e => e.results || [])[0];
        assert.ok(result?.sourceRefs?.length); assert.equal(result.torrentUrl, undefined);
        assert.ok(result.checkedAt >= started && result.checkedAt <= Date.now());
        if (type === 'custom') assert.deepEqual(result.media, { audioLanguages: ['en'], subtitleLanguages: ['ru'] });
        assert.equal(events.find(e => e.stat)?.stat.state, 'ok');
        assert.equal(store.getSearchNetworkSettings().access[provider.id].lastWorkingMirror, alias);
        const resolved = await service.resolveSource(result.sourceRefs);
        assert.deepEqual(fs.readFileSync(resolved.sourceUri), torrent);
        assert.ok(proxyHits.some(url => url.startsWith(alias + '/') && url.includes('/torrent?id=test-token')));
        assert.ok(hits.filter(hit => hit.side === 'mirror' && !hit.url.includes('t=caps')).every(hit => hit.cookie.includes('mirror-session=test')));
        assert.ok(hits.filter(hit => hit.side === 'primary').every(hit => !hit.cookie.includes('mirror-session')));
        console.log('PASS', type, 'proxy, caps/search, mirror preference, cookies and torrent retrieval');
      }
      const provider = providers[0], alias = mirrorBase + '/copy';
      const [result] = (await search(provider)).flatMap(e => e.results || []);
      mirrorStatus = 503; primaryStatus = 200;
      const restored = await service.resolveSource(result.sourceRefs);
      assert.deepEqual(fs.readFileSync(restored.sourceUri), torrent);
      assert.equal(store.getSearchNetworkSettings().access[provider.id].lastWorkingMirror, undefined);
      console.log('PASS: primary recovery uses the registered result context');
      mirrorStatus = 200; primaryStatus = 403;
      let count = hits.length;
      const forbidden = await search(provider);
      assert.equal(forbidden.find(e => e.stat)?.stat.state, 'failed'); assert.equal(hits.length - count, 1); assert.equal(hits.at(-1).side, 'primary');
      primaryStatus = 429; count = hits.length; await search(provider); await search(provider);
      assert.equal(hits.length - count, 1);
      console.log('PASS: 403/429 stop mirror retries and Retry-After is respected');
      await providerNetwork.reset(provider.id); primaryStatus = 503;
      const controller = new AbortController(); count = hits.filter(hit => hit.side === 'mirror').length;
      const pending = readHttpMirrors(provider, primaryBase + '/stall', r => r.text(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 80); await assert.rejects(pending, error => error.code === 'cancelled');
      assert.equal(hits.filter(hit => hit.side === 'mirror').length, count);
      console.log('PASS: cancellation does not contact the next mirror');
      proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); count = hits.length;
      const blocked = await search(provider); assert.equal(blocked.find(e => e.stat)?.stat.state, 'failed'); assert.equal(hits.length, count);
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      console.log('PASS: unavailable mandatory proxy never falls back to direct');
    } finally {
      for (const provider of providers) await providerNetwork.reset(provider.id, true);
      for (const server of [primary, mirror, proxy]) { server.closeAllConnections(); server.close(); }
    }
    clearTimeout(deadline); console.log('Isolated profile:', profile); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
