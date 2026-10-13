/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Electron/Node harness and webpack configuration. */
// Usage: node scripts/performance-renderer.cjs label [output.json] [--ui-from-head]
// Rebuilds a profiling bundle from current product source and samples isolated Electron.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const label = process.argv[2] || 'current';
  const output = path.resolve(process.argv[3] || path.join(root, 'artifacts/performance', label + '.json'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-perf-'));
  const config = require('../webpack.renderer.config.js')({}, { mode: 'production' });
  config.context = root; config.mode = 'production'; config.devtool = false;
  config.entry = path.join(__dirname, 'performance-renderer-entry.cjs'); config.plugins = [];
  config.output = { path: scratch, filename: 'bundle.js', publicPath: './' };
  config.optimization = { minimize: false }; config.performance = { hints: false };
  config.resolve.alias['react-dom/client$'] = require.resolve('react-dom/profiling');
  let baseline;
  const sourceHashes = {};
  const files = ['renderer/App.tsx', 'renderer/pages/DownloadsPage.tsx', 'renderer/pages/DownloadItem.tsx', 'renderer/pages/SearchPage.tsx', 'renderer/components/MediaBufferStatus.tsx'];
  if (process.argv.includes('--ui-from-head')) { baseline = path.join(scratch, 'source'); fs.mkdirSync(baseline); }
  for (const file of files) {
    const source = baseline ? require('node:child_process').execFileSync('git', ['show', 'HEAD:' + file], { cwd: root }) : fs.readFileSync(path.join(root, file));
    sourceHashes[file] = require('node:crypto').createHash('sha256').update(source).digest('hex');
    if (baseline) fs.writeFileSync(path.join(baseline, path.basename(file)), source);
  }
  config.module.rules.unshift({ test: /\.tsx$/, enforce: 'pre', exclude: /node_modules/, use: { loader: path.join(__dirname, 'performance-renderer-loader.cjs'), options: { baseline } } });
  config.module.rules[1].use.options.transpileOnly = true;
  require('webpack')(config, (error, stats) => {
    if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; cleanup(); return; }
    fs.writeFileSync(path.join(scratch, 'index.html'), '<html><head><meta charset="utf-8"></head><div id="root"></div><script src="./bundle.js"></script></html>');
    require('node:child_process').execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15', '-t', '40', '-c:v', 'libvpx', '-an', path.join(scratch, 'clip.webm')], { windowsHide: true, timeout: 20000 });
    const env = { ...process.env, HAVVN_PERF_SCRATCH: scratch, HAVVN_PERF_OUTPUT: output, HAVVN_PERF_LABEL: label, HAVVN_PERF_HASHES: JSON.stringify(sourceHashes) }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    const deadline = setTimeout(() => child.kill(), 170000);
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { clearTimeout(deadline); cleanup(); process.exitCode = code ?? 1; });
  });
  const cleanup = () => {
    const target = path.resolve(scratch), parent = path.resolve(os.tmpdir());
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('havvn-perf-')) throw Error('Unexpected scratch path');
    fs.rmSync(target, { recursive: true, force: true });
  };
} else {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const scratch = process.env.HAVVN_PERF_SCRATCH;
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.commandLine.appendSwitch('mute-audio');
  const deadline = setTimeout(() => app.exit(1), 160000);
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') { errors.push(d.message); console.error(d.message); } });
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file|data|blob):/.test(d.url) }));
    await win.loadFile(path.join(scratch, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async code => { const end = Date.now() + 12000; while (!await run(code)) { if (Date.now() > end) throw Error('UI deadline: ' + code); await wait(50); } };
    await until(`document.querySelectorAll('.download-item').length>0`);
    await run('perfTick()'); await wait(1500);
    const rows = [];
    async function sample(scenario, tickCode) {
      await run('perfReset()');
      const memory = [], cpu = [], lag = [], heap = []; let expected = Date.now() + 25;
      win.webContents.debugger.attach('1.3');
      app.getAppMetrics(); // Prime CPU counters before the measurement window.
      const lagTimer = setInterval(() => { const now = Date.now(); lag.push(Math.max(0, now - expected)); expected = now + 25; }, 25);
      // Warmed 12 seconds, matching the real 750ms stats cadence.
      for (let i = 0; i < 16; i++) {
        await run(tickCode); await wait(750);
        const metrics = app.getAppMetrics();
        memory.push(metrics.map(m => ({ role: m.type, pid: m.pid, workingSetKiB: m.memory.workingSetSize, privateKiB: m.memory.privateBytes || 0 })));
        cpu.push(metrics.map(m => ({ role: m.type, percent: m.cpu.percentCPUUsage })));
        heap.push({ main: process.memoryUsage(), renderer: await win.webContents.debugger.sendCommand('Runtime.getHeapUsage') });
      }
      clearInterval(lagTimer);
      win.webContents.debugger.detach();
      const ui = await run('perfResult()');
      rows.push({ scenario, memory, cpu, heap, mainLagMs: lag, ui });
      console.log(scenario + ': ' + JSON.stringify({ renders: ui.renders, statsListeners: ui.listeners, rows: ui.rows }));
    }
    await sample('downloads-1000', 'perfTick()');
    await run(`document.querySelector('.pillar-btn:last-child').click()`);
    await until(`document.querySelector('.room-file') || document.querySelector('.room-workspace')`); await wait(2000);
    await sample('rooms-torrent-stats-only', 'perfTick()');
    await sample('rooms-1000-files-200-chat', 'perfTick(); if (__perf.tick % 2 === 0) perfRoomTick()');
    await run(`document.querySelector('.pillar-btn:first-child').click()`); await until(`document.querySelector('.download-item')`);
    await run(`document.querySelector('.download-item button[title="Watch"]').click()`);
    await until(`document.querySelector('video')?.readyState>=3`);
    await run(`document.querySelector('video').loop=true; document.querySelector('video').play()`); await wait(1500);
    const start = await run(`document.querySelector('video').currentTime`);
    await sample('video-and-1000-downloads', 'perfTick()');
    assert(await run(`document.querySelector('video').currentTime`) > start, 'Actual video advances');
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await wait(200);
    assert.equal(await run(`!!document.querySelector('video')`), false, 'Player releases video');
    // Real controls: live sort, status counts/filter, page remount retains stats.
    await run(`document.querySelectorAll('.sort-chip')[3].click(); perfTick()`); await wait(150);
    assert((await run(`document.querySelector('.download-item').textContent`)).includes('Fixture 0000'), 'Live speed sort');
    await run(`perfSetStatus('0', 'paused')`); await wait(150);
    await run(`document.querySelectorAll('.nav-subitem')[3].click()`); await wait(150);
    assert.equal(await run(`document.querySelectorAll('.download-item').length`), 1, 'Paused filter');
    await run(`document.querySelector('.pillar-btn:last-child').click()`); await wait(150);
    await run(`document.querySelector('.pillar-btn:first-child').click()`); await wait(150);
    assert((await run(`document.querySelector('.download-item').className`)).includes('download-st-paused'), 'Status survives remount');
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.dirname(process.env.HAVVN_PERF_OUTPUT), { recursive: true });
    fs.writeFileSync(process.env.HAVVN_PERF_OUTPUT, JSON.stringify({ label: process.env.HAVVN_PERF_LABEL, sourceHashes: JSON.parse(process.env.HAVVN_PERF_HASHES), at: new Date().toISOString(), electron: process.versions.electron, platform: process.platform, hardware: { cpus: os.cpus().length, cpu: os.cpus()[0].model, ramBytes: os.totalmem() }, mode: 'production React profiling; synthetic IPC; software GPU; hidden window', rows }, null, 2));
    console.log('Performance results: ' + process.env.HAVVN_PERF_OUTPUT);
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
