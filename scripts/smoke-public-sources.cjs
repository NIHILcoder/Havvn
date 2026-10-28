/* eslint-disable @typescript-eslint/no-require-imports -- Isolated public-network acceptance. */
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.once('exit', code => { process.exitCode = code ?? 1; }); child.once('error', error => { console.error(error); process.exitCode = 1; });
} else {
  const { app } = require('electron'), assert = require('node:assert/strict');
  app.on('window-all-closed', () => {});
  const output = path.resolve(__dirname, '../artifacts/one-pc-extended-20261106'); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(output, 'public-profile-')));
  const report = { startedAt: new Date().toISOString(), passed: false, observations: [], accountsUsed: false, autoDownloads: false };
  let rss, network;
  const deadline = setTimeout(() => { report.error = 'Public source deadline'; save(); app.exit(1); }, 90000);
  function save() { fs.writeFileSync(path.join(output, 'public-sources.json'), JSON.stringify(report, null, 2)); }
  app.whenReady().then(async () => {
    const db = require('../dist/electron/electron/db/store.js');
    const { RSSService } = require('../dist/electron/electron/services/rss-service.js');
    const { ProviderNetworkService } = require('../dist/electron/electron/services/provider-network.js');
    const { setProviderAccess } = require('../dist/electron/electron/services/provider-network-store.js');
    const { searchRuTracker } = require('../dist/electron/electron/services/rutracker-source.js');
    const { t } = require('../dist/electron/electron/i18n/index.js');
    await db.updateSettings({ autoDownloadRSS: false, autoLaunch: false, autoUpdate: false });
    rss = new RSSService();
    const feed = await db.addRSSFeed({ name: 'Public FOSS acceptance', url: 'https://fosstorrents.com/feed/torrents.xml', enabled: false, autoDownload: false, intervalMinutes: 60 });
    const started = Date.now();
    let items;
    try { items = await rss.checkFeed(feed.id); } catch (error) {
      const saved = (await db.getRSSFeeds()).find(f => f.id === feed.id);
      assert.equal(saved.lastStatus, 'failed'); assert.ok(saved.lastError); assert.ok(saved.consecutiveFailures >= 1);
      report.observations.push({ source: feed.url, status: 'unavailable', error: saved.lastError, failureRecorded: true, durationMs: Date.now()-started });
    }
    if (items) {
      const saved = (await db.getRSSFeeds()).find(f => f.id === feed.id);
      assert.ok(items.length > 0, 'A successful torrent feed should contain items');
      assert.ok(items.some(item => /^magnet:|\.torrent(?:$|\?)/i.test(item.link))); assert.equal(saved.lastStatus, 'ok');
      report.observations.push({ source: feed.url, status: 'available', items: items.length, durationMs: Date.now()-started });
      await rss.checkFeed(feed.id);
      const persisted = await db.getRSSItems(feed.id); assert.equal(new Set(persisted.map(item => item.guid)).size, persisted.length);
      report.observations.push({ source: feed.url, check: 'repeat-check-no-duplicate-downloads', status: 'passed' });
    }
    assert.equal((await db.getAllDownloads()).length, 0); rss.destroy();
    network = new ProviderNetworkService();
    const release = 'https://releases.ubuntu.com/24.04/';
    try {
      const response = await network.request('public-ubuntu', { mode:'direct' }, release, { allowedOrigins:['https://releases.ubuntu.com'], timeoutMs:12000, maxBytes:1024*1024 });
      assert.equal(response.status,200); assert.match(response.body.toString('utf8'), /\.torrent/);
      report.observations.push({ source:release, status:'available', publicTorrentLinks:true });
    } catch (error) { report.observations.push({ source:release, status:'unavailable', code:error.code, message:error.message }); }
    const provider = { id:'public-rutracker', name:'Public RuTracker acceptance', type:'rutracker', enabled:true, url:'https://rutracker.net/forum' };
    setProviderAccess(provider.id,{profileId:'direct',origins:['https://rutracker.net'],mirrors:[]});
    try {
      const page = await searchRuTracker(provider,'Ubuntu',0,AbortSignal.timeout(20000));
      report.observations.push({ source:provider.url, status:'available', searchResults:page.results.length });
    } catch (error) {
      const friendly = error.code ? t('search.network.'+error.code) : error.message;
      assert.ok(friendly && !/^search\.network\./.test(friendly));
      report.observations.push({ source:provider.url, status:['auth','captcha'].includes(error.code)?'requires-user-action':'unavailable', code:error.code, message:friendly });
    }
    assert.equal((await db.getAllDownloads()).length,0); report.passed=true;
  }).catch(error => { report.error=String(error.stack||error);console.error(error); }).finally(async () => {
    rss?.destroy(); await network?.reset('public-ubuntu'); await require('../dist/electron/electron/services/provider-network.js').providerNetwork.reset('public-rutracker');
    report.finishedAt=new Date().toISOString();save();clearTimeout(deadline);console.log(JSON.stringify(report));app.exit(report.passed?0:1);
  });
}
