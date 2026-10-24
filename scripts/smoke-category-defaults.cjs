// Real main store/proxy/RSS + isolated Classic/Native engines. No external peers.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-category-smoke-'));
  const env = { ...process.env, HAVVN_CATEGORY_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-category-smoke-')) throw Error('Unexpected category fixture');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_CATEGORY_SCRATCH || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-category-smoke-')) throw Error('Missing isolated category profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Category smoke deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const compiled = path.join(root, 'dist/electron');
    require(path.join(compiled, 'electron/torrent/host/env.js')).setHostEnv({ version: app.getVersion(), isPackaged: false, tempDir: scratch,
      userDataDir: app.getPath('userData'), downloadsDir: scratch, engine: 'webtorrent', engineBinary: null, engineStateDir: path.join(scratch, 'daemon') });
    const db = require(path.join(compiled, 'electron/db/store.js'));
    const proxy = require(path.join(compiled, 'electron/torrent/host/manager-proxy.js')).getTorrentManager();
    const bridge = require(path.join(compiled, 'electron/torrent/host/db-bridge.js'));
    bridge.wireDbBridge(msg => Promise.resolve().then(() => db[msg.fn](...msg.args)).then(
      value => bridge.resolveDbResponse(msg.id, true, value), error => bridge.resolveDbResponse(msg.id, false, undefined, String(error), error.code)));
    const { default: createTorrent } = await import('create-torrent');
    let serial = 0, dispatches = 0;
    const torrent = async () => {
      const source = path.join(scratch, `source-${++serial}.bin`); fs.writeFileSync(source, require('node:crypto').randomBytes(32768));
      const bytes = await new Promise((resolve, reject) => createTorrent(source, { announceList: [] }, (error, result) => error ? reject(error) : resolve(Buffer.from(result))));
      const file = source + '.torrent'; fs.writeFileSync(file, bytes); return file;
    };
    const { default: WebTorrent } = await import('webtorrent');
    const { default: FSChunkStore } = await import('fs-chunk-store');
    const { downloadPieceCache } = require(path.join(compiled, 'electron/torrent/piece-cache.js'));
    const { TorrentManager } = require(path.join(compiled, 'electron/torrent/manager.js'));
    const { NativeTorrentManager } = require(path.join(compiled, 'electron/torrent/native/native-manager.js'));
    const { TransmissionSidecar } = require(path.join(compiled, 'electron/torrent/native/transmission-sidecar.js'));
    const { RSSService } = require(path.join(compiled, 'electron/services/rss-service.js'));
    const checks = [], pass = label => { checks.push(label); console.log('PASS ' + label); };
    for (const engine of ['webtorrent', 'native']) {
      let client, sidecar, manager;
      try {
        const settings = await db.updateSettings({ defaultDownloadDir: path.join(scratch, engine, 'global'), defaultSeedRatioLimit: 2, defaultSeedTimeLimitMinutes: 60, maxActiveDownloads: 3 });
        if (engine === 'webtorrent') {
          client = new WebTorrent({ dht: false, tracker: false, lsd: false, webSeeds: false, natUpnp: false, natPmp: false, utp: false });
          manager = new TorrentManager();
          Object.assign(manager, { client, initDone: Promise.resolve(), cachedStore: downloadPieceCache.store(FSChunkStore), maxActiveDownloads: 3, defaultDownloadDir: settings.defaultDownloadDir });
        } else {
          sidecar = new TransmissionSidecar({ binaryPath: path.join(root, 'vendor/transmission', process.platform === 'win32' ? 'win32-x64/transmission-daemon.exe' : 'linux-x64/transmission-daemon'),
            configDir: path.join(scratch, 'daemon'), downloadDir: scratch,
            settingsOverrides: { 'dht-enabled': false, 'pex-enabled': false, 'lpd-enabled': false, 'utp-enabled': false, 'port-forwarding-enabled': false,
              'bind-address-ipv4': '127.0.0.1', 'bind-address-ipv6': '::1', preallocation: 0 } });
          manager = new NativeTorrentManager(); Object.assign(manager, { ready: Promise.resolve(), rpc: await sidecar.start(), settings });
        }
        proxy.rpc = async (method, args) => { dispatches++; return manager[method](...args); };
        const category = await db.addCategory({ name: 'Category ' + engine, icon: 'film', color: '#ff6600',
          downloadDefaults: { savePath: path.join(scratch, engine, 'category'), paused: true, seedRatioLimit: 0, seedTimeLimitMinutes: 0, sequentialDownload: true } });
        const manual = await proxy.addDownload({ sourceType: 'torrent_file', sourceUri: await torrent(), categoryId: category.id });
        assert.equal(manual.status, 'paused'); assert.equal(manual.savePath, category.downloadDefaults.savePath);
        assert.equal(manual.seedRatioLimit, 0); assert.equal(manual.seedTimeLimitMinutes, 0); assert.equal(manual.sequentialDownload, true);
        const stored = await db.getDownloadById(manual.id); assert.equal(stored.seedRatioLimit, 0); assert.equal(stored.sequentialDownload, true);
        if (engine === 'native') {
          const [live] = await sidecar.rpc.torrentGet(['status', 'seedRatioLimit', 'seedRatioMode', 'downloadDir', 'sequential_download'], manual.infoHash);
          assert.equal(live.status, 0); assert.equal(live.seedRatioMode, 2); assert.equal(live.sequential_download, true);
        }
        pass(engine + ': category options are durable before any start');
        const chosen = path.join(scratch, engine, 'chosen');
        const search = await proxy.addDownload({ sourceType: 'torrent_file', sourceUri: await torrent(), categoryId: category.id, savePath: chosen, paused: false, seedRatioLimit: 4, sequentialDownload: false });
        assert.equal(search.savePath, chosen); assert.equal(search.seedRatioLimit, 4); assert.equal(search.sequentialDownload, false);
        assert.notEqual(search.status, 'paused');
        if (engine === 'webtorrent') {
          for (let n = 0; n < 100 && !manager.managedTorrents.get(search.id)?.torrent?.ready; n++) await new Promise(resolve => setTimeout(resolve, 30));
          assert.equal(manager.managedTorrents.get(search.id).torrent.strategy, 'rarest');
        }
        await manager.pauseDownload(search.id); pass(engine + ': explicit path, active state and options win');
        const feed = await db.addRSSFeed({ name: 'Feed', url: 'https://fixture.invalid/rss', enabled: false, autoDownload: false, intervalMinutes: 30,
          categoryId: category.id, savePath: path.join(scratch, engine, 'feed') });
        const rule = await db.addRSSRule({ name: 'Rule', enabled: false, feedIds: [feed.id], mode: 'wildcard', include: '*', categoryId: category.id });
        const item = { guid: engine + '-item', feedId: feed.id, title: 'RSS fixture', link: await torrent() };
        await db.saveRSSItems([item]);
        const service = new RSSService(); assert.deepEqual(await service.downloadForRule(rule, feed, [item]), [item.guid]);
        const rss = (await db.getAllDownloads()).find(download => download.sourceUri === item.link);
        assert(rss); assert.equal(rss.savePath, feed.savePath); assert.equal(rss.seedRatioLimit, 0); assert.equal(rss.status, 'paused');
        assert((await db.getRSSItems(feed.id)).find(i => i.guid === item.guid).downloaded);
        pass(engine + ': RSS feed destination precedes category and inherits the other options');
        const newCategory = await db.addCategory({ name: 'Elsewhere', icon: 'folder', color: '#ffffff', downloadDefaults: { savePath: path.join(scratch, 'elsewhere'), seedRatioLimit: 9 } });
        await db.setDownloadCategory(manual.id, newCategory.id);
        assert.equal((await db.getDownloadById(manual.id)).savePath, manual.savePath); assert.equal((await db.getDownloadById(manual.id)).seedRatioLimit, 0);
        pass(engine + ': recategorizing never moves files or changes saved limits');
        const blocked = path.join(scratch, engine, 'blocked'); fs.writeFileSync(blocked, 'do not change');
        const before = dispatches;
        await assert.rejects(proxy.addDownload({ sourceType: 'torrent_file', sourceUri: await torrent(), categoryId: category.id, savePath: blocked }), /unavailable/);
        assert.equal(dispatches, before); assert.equal(fs.readFileSync(blocked, 'utf8'), 'do not change');
        pass(engine + ': unavailable destination fails before engine dispatch');
        const id = category.id; await db.updateCategory(id, { id: 'forbidden-replacement', downloadDefaults: {} });
        assert((await db.getCategories()).some(c => c.id === id));
        await db.deleteCategory(id);
        assert.equal((await db.getRSSFeeds()).find(f => f.id === feed.id).categoryId, undefined);
        assert.equal((await db.getRSSRules()).find(r => r.id === rule.id).categoryId, undefined);
        pass(engine + ': category identity stays stable and deletion clears RSS references');
      } finally {
        if (engine === 'native') await manager?.destroy();
        await sidecar?.stop();
        if (client) await new Promise(resolve => client.destroy(() => resolve()));
      }
    }
    fs.mkdirSync(path.join(root, 'dist/category-defaults'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/category-defaults/report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
