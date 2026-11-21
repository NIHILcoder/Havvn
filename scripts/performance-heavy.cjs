/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron profiling runner. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), metrics = require('./performance-baseline-metrics.cjs'), heavy = require('./performance-heavy-metrics.cjs');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
const graphOptions = { all: false, assets: true, chunks: true, chunkModules: true, nestedModules: true, dependentModules: true, groupModulesByAttributes: false, groupModulesByType: false, groupModulesByPath: false, groupModulesByCacheStatus: false, chunkModulesSpace: Infinity, nestedModulesSpace: Infinity };
if (!process.versions.electron) {
  const option = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
  const output = path.resolve(option('--output', path.join(root, 'artifacts/heavy-sections/current'))), runs = Number(option('--runs', 3)), cycles = Number(option('--cycles', 8)), verify = process.argv.includes('--verify'), reference = option('--compare', null);
  const cycleHoldMs = Number(option('--cycle-hold-ms', 0));
  const sections = option('--sections', 'rooms,documents,player,theme').split(',');
  if (new Set(sections).size !== sections.length || sections.some(section => !['rooms','documents','player','theme'].includes(section))) throw Error('Invalid section selection');
  const budgetMs = Math.max(240000, cycles * (cycleHoldMs + 1500) * sections.length + 120000);
  const beforeFile = option('--ui-before', null), before = beforeFile ? JSON.parse(fs.readFileSync(path.resolve(beforeFile), 'utf8')) : null;
  if (reference && path.dirname(path.resolve(reference)) === output) throw Error('Preserve the reference output');
  if (!Number.isInteger(runs) || runs < 1 || runs > 5 || !Number.isInteger(cycles) || cycles < 3 || cycles > 120
    || !Number.isInteger(cycleHoldMs) || cycleHoldMs < 0 || cycleHoldMs > 10000) throw Error('Invalid repeat count');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-heavy-'));
  const cleanup = () => { const target = path.resolve(scratch); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-heavy-')) throw Error('Unexpected profile'); fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  (async () => {
    const source = metrics.sourceSnapshot(root); write(path.join(output, 'source-manifest.json'), source);
    const config = require('../webpack.renderer.config.js')({}, { mode: 'production' });
    Object.assign(config, { context: root, mode: 'production', devtool: false, entry: path.join(__dirname, 'performance-heavy-entry.cjs'), plugins: [], output: { path: scratch, filename: 'bundle.js', publicPath: './' }, optimization: { minimize: false }, performance: { hints: false } });
    config.module.rules.find(rule => rule.use?.loader === 'ts-loader').use.options.transpileOnly = true;
    config.module.rules.unshift({ test: /\.tsx$/, enforce: 'pre', exclude: /node_modules/, use: path.join(__dirname, 'performance-heavy-loader.cjs') });
    const beforeRule = { test: /\.(tsx?)$/, enforce: 'pre', exclude: /node_modules/, use: { loader: path.join(__dirname, 'performance-heavy-before-loader.cjs'), options: { before: !!before, hashes: before?.hashes ?? {} } } };
    config.module.rules.unshift(beforeRule);
    const stats = await new Promise((resolve, reject) => require('webpack')(config, (error, result) => error || result.hasErrors() ? reject(error || Error(result.toString({ all: false, errors: true }))) : resolve(result)));
    const graph = stats.toJson(graphOptions);
    write(path.join(output, 'chunks.json'), graph);
    // Product graph has no fixture imports or module-evaluation instrumentation.
    const product = require('../webpack.renderer.config.js')({}, { mode: 'production' });
    product.context = root; product.devtool = false; product.plugins = []; product.mode = 'production'; product.optimization = { minimize: false };
    product.output = { path: path.join(scratch, 'product'), filename: '[name].js', publicPath: './' }; product.module.rules.find(rule => rule.use?.loader === 'ts-loader').use.options.transpileOnly = true;
    product.module.rules.unshift(beforeRule);
    const productStats = await new Promise((resolve, reject) => require('webpack')(product, (error, result) => error || result.hasErrors() ? reject(error || Error(result.toString({ all: false, errors: true }))) : resolve(result)));
    const productGraph = productStats.toJson(graphOptions); write(path.join(output, 'product-chunks.json'), productGraph);
    const bundleHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(scratch, 'bundle.js'))).digest('hex');
    cp.execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15', '-t', '20', '-c:v', 'libvpx', '-an', path.join(scratch, 'clip.webm')], { windowsHide: true, timeout: 30000 });
    const Y = require('yjs'), document = new Y.Doc(); document.clientID = 1; document.getText('text').insert(0, '# Measured document\n\n' + 'Local editor content.\n'.repeat(2000));
    const state = Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'); document.destroy();
    if (metrics.sourceSnapshot(root).sha256 !== source.sha256) throw Error('Sources changed during build');
    const results = [];
    for (let index = 1; index <= runs; index++) {
      const file = path.join(output, `run-${index}.json`), env = { ...process.env, HAVVN_HEAVY: JSON.stringify({ scratch, file, index, cycles, cycleHoldMs, sections, budgetMs, verify, syncWork: process.argv.includes('--with-sync-work'), nodeExecutable: process.execPath, document: state, source: source.sha256, bundleHash }) }; delete env.ELECTRON_RUN_AS_NODE;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' }), timeout = setTimeout(() => child.kill(), budgetMs);
        child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error('Heavy UI run failed: ' + code)); });
      });
      results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    const afterSource = metrics.sourceSnapshot(root);
    if (JSON.stringify(heavy.measurementInputs(afterSource)) !== JSON.stringify(heavy.measurementInputs(source))) throw Error('Measured sources changed during measurements');
    const auxiliarySourceChanges = [...new Set([...Object.keys(source.hashes), ...Object.keys(afterSource.hashes)])].filter(file => source.hashes[file] !== afterSource.hashes[file]);
    const harness = Object.fromEntries(['scripts/performance-heavy.cjs', 'scripts/performance-heavy-entry.cjs', 'scripts/performance-heavy-loader.cjs', 'scripts/performance-heavy-before-loader.cjs', 'scripts/performance-heavy-metrics.cjs', 'scripts/performance-renderer-entry.cjs', 'webpack.renderer.config.js', 'package-lock.json'].map(file => [file, source.hashes[file]]));
    const summary = { version: 1, source: source.sha256, sourceAfter: afterSource.sha256, auxiliarySourceChanges, bundleHash, harness, reconstructedBefore: before ? { manifest: path.resolve(beforeFile), source: before.sha256, files: ['renderer/components/index.ts', 'renderer/pages/WatchHistoryPage.tsx'].map(file => ({ file, sha256: before.hashes[file] })) } : null, product: heavy.chunks(productGraph), runs: results, assets: graph.assets.map(asset => ({ name: asset.name, bytes: asset.size })) };
    write(path.join(output, 'summary.json'), summary);
    if (reference) write(path.join(output, 'comparison.json'), heavy.compare(JSON.parse(fs.readFileSync(path.resolve(reference), 'utf8')), summary));
    console.log('PASS heavy sections: ' + output);
  })().catch(error => { console.error(error); write(path.join(output, 'failure.json'), { error: String(error), stack: error.stack }); process.exitCode = 1; }).finally(cleanup);
} else {
  const { app, BrowserWindow, powerMonitor } = require('electron'), assert = require('node:assert/strict'), input = JSON.parse(process.env.HAVVN_HEAVY);
  if (path.dirname(path.resolve(input.scratch)) !== path.resolve(os.tmpdir()) || !path.basename(input.scratch).startsWith('havvn-heavy-')) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(input.scratch, 'profile-' + input.index)); app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.commandLine.appendSwitch('mute-audio');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms)), deadline = setTimeout(() => app.exit(1), (input.budgetMs ?? 240000) - 10000);
  app.whenReady().then(async () => {
    let powerScheme = null; try { powerScheme = cp.execFileSync('powercfg', ['/getactivescheme'], { windowsHide: true, encoding: 'utf8' }).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0] ?? null; } catch { /* unavailable */ }
    const gpu = await app.getGPUInfo('basic').catch(() => null);
    const conditions = { electron: process.versions.electron, chrome: process.versions.chrome, os: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ram: os.totalmem(), onBattery: powerMonitor.isOnBatteryPower(), powerScheme, gpu: gpu?.gpuDevice?.map(device => ({ vendor: device.vendorId, device: device.deviceId, driver: device.driverVersion })) ?? null, viewport: [1200, 850], mode: 'unminified production React; actual UI; synthetic API; isolated hidden windows; forced GC retention diagnostic', effects: 'minimal; reduced motion', fixture: { downloads: 100, files: 1000, messages: 200, documentLines: 2002 }, cycles: input.cycles, cycleHoldMs: input.cycleHoldMs ?? 0, concurrentFilePreparation: input.syncWork ? '4x16MiB production snapshot queue during real video' : 'none' };
    const rows = [], errors = [], save = () => write(input.file, { index: input.index, source: input.source, bundleHash: input.bundleHash, conditions, rows, errors });
    for (const section of input.sections ?? ['rooms', 'documents', 'player', 'theme']) {
      console.log('Measuring heavy section: ' + section);
      const html = path.join(input.scratch, 'case.html'); fs.writeFileSync(html, '<html lang="en"><meta charset="utf-8"><div id="root"></div><script>window.__heavyInput=' + JSON.stringify({ document: input.document }) + '</script><script src="./bundle.js"></script></html>');
      const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
      win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file|data|blob):/.test(details.url) }));
      win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
      const run = code => win.webContents.executeJavaScript(code), until = async code => { const end = Date.now() + 15000; while (!await run(code)) { if (Date.now() > end) { save(); throw Error(section + ' UI deadline: ' + code + '; ' + await run('document.body.innerText.slice(0,1000)')); } await wait(20); } };
      win.webContents.debugger.attach('1.3'); const cdp = (method, args) => win.webContents.debugger.sendCommand(method, args);
      const at = performance.now(); await win.loadFile(html); await until('!!window.perfResult&&!!document.querySelector(".download-item")'); await wait(300);
      const startupMs = performance.now() - at, startupModules = await run('window.__heavyModules||[]');
      await run('perfAppearance("minimal")');
      if (section === 'documents') { await run('perfNavigate("rooms")'); await until('!!document.querySelector("[data-editor-open]")'); }
      const closed = section === 'rooms' ? '!document.querySelector(".rooms-page")' : section === 'documents' ? '!document.querySelector(".room-workarea-modal")' : section === 'player' ? '!document.querySelector("video")' : '!document.querySelector(".ted")';
      const open = async () => {
        if (section === 'rooms') { await run('perfNavigate("rooms")'); await until('!!document.querySelector(".room-file")'); }
        if (section === 'documents') { await run('document.querySelector("[data-editor-open]").click()'); await until('!!document.querySelector("[data-docs-open]")'); await run('document.querySelector("[data-docs-open]").click()'); await until('!!document.querySelector("[data-docs-document]")'); await run('document.querySelector("[data-docs-document]").click()'); await until('!!document.querySelector(".cm-content")'); }
        if (section === 'player') { await run('document.querySelector(".download-item button[title=Watch]").click()'); await until('document.querySelector("video")?.readyState>=3'); await run('document.querySelector("video").play()'); }
        if (section === 'theme') { await run('window.__heavyOpenTheme()'); await until('!!document.querySelector(".ted")'); await run('document.querySelector(".te-new").click()'); await until('!!document.querySelector(".ted-fields")'); }
        await run('new Promise(resolve=>setTimeout(()=>setTimeout(resolve,0),0))');
      };
      const close = async () => {
        if (section === 'rooms') await run('perfNavigate("downloads")');
        if (section === 'documents') await run('document.querySelector(".room-workarea-modal > .um-head .um-x").click()');
        if (section === 'player') await run('window.__heavyClosedVideo=new WeakRef(document.querySelector("video"));document.querySelector("video").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
        if (section === 'theme') await run('document.querySelector(".ted button[title=Close]").click()');
        await until(closed);
      };
      const snapshot = async () => { await wait(400); const media = await run('(()=>{const el=window.__heavyClosedVideo?.deref();return el?{paused:el.paused,src:el.getAttribute("src"),readyState:el.readyState,networkState:el.networkState}:null})()'); await cdp('HeapProfiler.collectGarbage'); await wait(60); await cdp('HeapProfiler.collectGarbage'); await wait(40); return { media, heap: await cdp('Runtime.getHeapUsage'), dom: await cdp('Memory.getDOMCounters'), ui: await run('perfResult()'), sessions: await run('window.__heavySessions') }; };
      const first = performance.now(); await open(); const coldOpenMs = performance.now() - first;
      let concurrentSync = null;
      if (section === 'player') {
        const from = await run('document.querySelector("video").currentTime'); await wait(200);
        assert(await run('document.querySelector("video").currentTime') > from, 'Real video advances');
        if (input.syncWork) {
          const sample = () => run('(()=>{const v=document.querySelector("video"),q=v.getVideoPlaybackQuality();return {time:v.currentTime,paused:v.paused,total:q.totalVideoFrames,dropped:q.droppedVideoFrames}})()');
          const before = await sample(), began = Date.now(), options = { jobs: 4, mib: 16, runs: 1 };
          const work = await new Promise((resolve, reject) => {
            const child = cp.spawn(input.nodeExecutable, [path.join(root, 'scripts/measure-sync-work.cjs'), '--worker'], {
              env: { ...process.env, HAVVN_SYNC_MEASURE: JSON.stringify(options) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Concurrent sync deadline')); }, 90000);
            child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(Error(err || 'Concurrent sync failed')); else try { resolve(JSON.parse(out)); } catch (error) { reject(error); } });
          });
          const after = await sample();
          assert(after.time > before.time && !after.paused, 'Real video keeps playing during file preparation');
          concurrentSync = { options, began, ended: Date.now(), before, after, work };
        }
      }
      await close();
      // Two complete warm cycles precede retained-memory measurements.
      for (let i = 0; i < 2; i++) { await open(); await close(); }
      const warmed = await snapshot(), cycles = [];
      for (let i = 0; i < input.cycles; i++) {
        const began = performance.now(); await open(); const openMs = performance.now() - began;
        if (input.cycleHoldMs) await wait(input.cycleHoldMs);
        const closing = performance.now(); await close();
        const after = await snapshot(); cycles.push({ openMs, closeMs: performance.now() - closing, ...after });
        assert.deepEqual(after.ui.subscriptions, warmed.ui.subscriptions, 'Subscriptions return after ' + section);
        assert.equal(after.sessions.active, 0, 'Document sessions released');
        if (input.cycleHoldMs && (i + 1) % 10 === 0) console.log(section + ': ' + (i + 1) + '/' + input.cycles + ' cycles, subscriptions and sessions released');
      }
      const beforeIdle = await run('perfResult().calls'); await wait(850); const afterIdle = await run('perfResult().calls');
      if (section === 'documents') assert.equal(afterIdle['rooms.documents.poll'], beforeIdle['rooms.documents.poll'], 'Closed editor stops polling');
      if (section === 'theme') assert(await run('!document.documentElement.dataset.teDock'), 'Theme editor releases dock reservation');
      const row = { section, startupMs, startupModules, coldOpenMs, warmed, cycles, concurrentSync, modules: await run('window.__heavyModules||[]'), resources: await cdp('Page.getResourceTree') }; row.retention = heavy.retention(row); rows.push(row); save();
      if (input.verify) {
        assert.equal(startupModules.length, 0, 'Heavy modules stay out of startup');
        assert(row.retention.growthMiB < 2 && row.retention.slopeMiBPerCycle < .25, section + ' retained heap grows after warming');
        // Responsive virtualization changes background row counts after docking.
        // Verify the closed surface itself, rather than a global node total.
        assert(await run(closed), section + ' surface remains mounted');
        if (section === 'documents') assert(await run('!document.querySelector(".cm-editor")'), 'Closed document retains editor DOM');
        if (section === 'rooms') assert(await run('!document.querySelector(".room-file")'), 'Closed room retains file portals');
      }
      assert.equal(powerMonitor.isOnBatteryPower(), conditions.onBattery, 'Power source changed');
      await win.destroy();
    }
    assert.deepEqual(errors, []); save(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
