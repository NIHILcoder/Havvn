// Explicit, read-only site probe. Uses an existing Havvn source session without
// exporting cookies, submitting login forms, or starting torrent downloads.
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  const fs = require('node:fs'), path = require('node:path');
  const profile = process.argv[2];
  if (!profile || !path.isAbsolute(profile) || !fs.existsSync(path.join(profile, 'search.json'))) throw Error('Specify an existing Havvn profile');
  const providers = JSON.parse(fs.readFileSync(path.join(profile, 'search.json'), 'utf8')).searchProviders;
  const settings = JSON.parse(fs.readFileSync(path.join(profile, 'search-connections.json'), 'utf8'));
  const source = providers.find(p => p.type === 'rutracker') || providers.find(p => settings.access[p.id]?.origins?.some(o => /^https:\/\/rutracker\.(org|net|nl)$/.test(o)));
  if (!source) throw Error('No configured RuTracker session');
  const access = settings.access[source.id];
  const connection = ['direct', 'system'].includes(access.profileId) ? { mode: access.profileId } : settings.profiles.find(p => p.id === access.profileId)?.connection;
  if (!connection) throw Error('Missing configured route');
  const out = path.resolve(__dirname, '../artifacts/rutracker-live-20261028'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const report = { date: new Date().toISOString(), transport: 'real Electron provider browser', session: 'existing configured source', connectionMode: connection.mode, checks: [] };
  const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const deadline = setTimeout(() => { report.deadline = true; save(); app.exit(1); }, 100000);
  app.whenReady().then(async () => {
    const root = path.resolve(__dirname, '../dist/electron');
    // Keep route hints in memory; never rewrite the user's source configuration.
    const store = require.resolve(path.join(root, 'electron/services/provider-network-store'));
    const route = { connection, origins: access.origins, mirrors: access.mirrors || [] };
    require.cache[store] = { id: store, filename: store, loaded: true, exports: { getProviderRoute: () => route, rememberProviderMirror: () => {} } };
    const { readProviderPage } = require(path.join(root, 'electron/services/provider-browser'));
    const { searchRuTracker, resolveRuTracker } = require(path.join(root, 'electron/services/rutracker-source'));
    const { checkRuTrackerPage } = require(path.join(root, 'shared/rutracker'));
    const bases = [...new Set([...(access.mirrors || []), 'https://rutracker.net/forum'])];
    for (const base of bases.slice(0, 2)) {
      const origin = new URL(base).origin;
      route.origins = [...new Set([...access.origins, origin])]; route.mirrors = [];
      const provider = { id: source.id, name: 'RuTracker', type: 'rutracker', url: base, enabled: true };
      const check = async (name, action) => {
        const start = Date.now();
        try { const details = await action(); report.checks.push({ base, name, ok: true, ms: Date.now() - start, ...details }); }
        catch (e) { report.checks.push({ base, name, ok: false, ms: Date.now() - start, code: e.code || 'error', status: e.status }); }
        save(); console.log(JSON.stringify(report.checks.at(-1)));
      };
      await check('login-page', async () => {
        const page = await readProviderPage(source.id, connection, base + '/login.php', route.origins, AbortSignal.timeout(15000));
        const html = page.body.toString('utf8'); let classification = 'recognized';
        try { checkRuTrackerPage(html); } catch (e) { classification = e.code; }
        return { classification, loginForm: /name\s*=\s*["']login_username["']/i.test(html), bytes: page.body.length };
      });
      let first;
      await check('search-latin', async () => { first = await searchRuTracker(provider, 'ubuntu'); return { count: first.results.length, nextPage: first.nextOffset !== undefined }; });
      if (first?.results.length) {
        await check('search-cyrillic', async () => { const result = await searchRuTracker(provider, 'линукс'); return { count: result.results.length }; });
        if (first.nextOffset !== undefined) await check('pagination', async () => { const result = await searchRuTracker(provider, 'ubuntu', first.nextOffset); return { count: result.results.length, overlap: result.results.filter(r => first.results.some(a => a.deferredSource === r.deferredSource)).length }; });
        await check('resolve-first-topic-no-download', async () => { const result = await resolveRuTracker(provider, first.results[0].detailsUrl); return { hasMagnet: !!result.magnetUri, hasTorrentUrl: !!result.torrentUrl }; });
        break;
      }
    }
    clearTimeout(deadline); save(); app.exit(0);
  }).catch(e => { report.fatal = e.code || e.name; save(); clearTimeout(deadline); app.exit(1); });
}
