/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron profiling fixture. */
// Usage: node scripts/performance-idle-renderer.cjs [label] [output.json] [--verify-idle]
// Actual App, normal motion, visible hardware-accelerated window, synthetic IPC.
// Does not load the user's profile or start torrents/room/network services.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const passiveSelectors = '.status-dot-connected,.room-nav-live,.presence-dot,.status-voice-dot';
if (!process.versions.electron) {
  const output = path.resolve((process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '') ||
    path.join(root, 'artifacts/performance-idle', (process.argv[2] || 'current') + '.json'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-idle-perf-'));
  const config = require('../webpack.renderer.config.js')({}, { mode: 'production' });
  config.context = root; config.mode = 'production'; config.devtool = false;
  config.entry = path.join(__dirname, 'performance-renderer-entry.cjs'); config.plugins = [];
  config.output = { path: scratch, filename: 'bundle.js', publicPath: './' };
  config.optimization = { minimize: false }; config.performance = { hints: false };
  config.resolve.alias['react-dom/client$'] = require.resolve('react-dom/profiling');
  config.module.rules.unshift({ test: /\.tsx$/, enforce: 'pre', exclude: /node_modules/,
    use: { loader: path.join(__dirname, 'performance-renderer-loader.cjs'), options: {} } });
  config.module.rules[1].use.options.transpileOnly = true;
  const hashes = Object.fromEntries(['renderer/styles/base.css', 'renderer/styles/layout.css', 'renderer/styles/components.css', 'renderer/App.tsx'].map(file =>
    [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const cleanup = () => {
    const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-idle-perf-')) throw Error('Unexpected scratch path');
    fs.rmSync(target, { recursive: true, force: true });
  };
  require('webpack')(config, (error, stats) => {
    if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; cleanup(); return; }
    fs.writeFileSync(path.join(scratch, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.__perfIdle=true</script><script src="./bundle.js"></script></body></html>');
    const env = { ...process.env, HAVVN_IDLE_SCRATCH: scratch, HAVVN_IDLE_OUTPUT: output,
      HAVVN_IDLE_LABEL: process.argv[2] || 'current', HAVVN_IDLE_HASHES: JSON.stringify(hashes),
      HAVVN_IDLE_VERIFY: process.argv.includes('--verify-idle') ? '1' : '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => child.kill(), 150000);
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { clearTimeout(timeout); cleanup(); process.exitCode = code ?? 1; });
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const scratch = process.env.HAVVN_IDLE_SCRATCH;
  app.setPath('userData', path.join(scratch, 'profile'));
  const timeout = setTimeout(() => app.exit(1), 140000);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: true, width: 1200, height: 850, title: 'Havvn — проверка простоя',
      // The diagnostic window may be covered by the user's foreground app.
      // Keep the compositor awake in this fixture only, so occlusion cannot
      // silently turn a visible-window rendering test into a hidden-window one.
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', d => { if (d.level === 'error') errors.push(d.message); });
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file|data|blob):/.test(d.url) }));
    await win.loadFile(path.join(scratch, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code);
    const until = async code => { const end = Date.now() + 15000; while (!await run(code)) { if (Date.now() > end) throw Error('UI deadline: ' + code); await wait(50); } };
    await until(`document.querySelector('.download-item') && document.querySelector('.status-dot-connected')`);
    win.showInactive();
    await wait(2000);
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    const rows = [];
    async function sample(name, setup) {
      await run(setup); await wait(1500); await run('perfReset()');
      const animations = await run(`document.getAnimations().map(a=>({name:a.animationName||'',state:a.playState,target:a.effect?.target?.className,frames:a.effect?.getKeyframes().map(k=>Object.keys(k).filter(n=>!['offset','computedOffset','easing','composite'].includes(n)))}))`);
      const cpu = []; app.getAppMetrics();
      const complete = new Promise(resolve => {
        const onMessage = (_event, method, params) => {
          if (method === 'Tracing.tracingComplete') { win.webContents.debugger.removeListener('message', onMessage); resolve(params); }
        };
        win.webContents.debugger.on('message', onMessage);
      });
      await cdp('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing', transferMode: 'ReturnAsStream' });
      const started = Date.now();
      for (let i = 0; i < 6; i++) { await wait(1000); cpu.push(app.getAppMetrics().map(m=>({ role: m.type, percent: m.cpu.percentCPUUsage }))); }
      const durationMs = Date.now() - started;
      await cdp('Tracing.end');
      const { stream } = await complete;
      let data = '';
      while (true) { const chunk = await cdp('IO.read', { handle: stream }); data += chunk.data; if (chunk.eof) break; }
      await cdp('IO.close', { handle: stream });
      const trace = JSON.parse(data), counts = {}, totalsMs = {};
      for (const event of trace.traceEvents) {
        if (event.ph === 'M') continue;
        counts[event.name] = (counts[event.name] || 0) + 1;
        if (event.dur) totalsMs[event.name] = (totalsMs[event.name] || 0) + event.dur / 1000;
      }
      const ui = await run('perfResult()');
      const windowState = { visible: win.isVisible(), minimized: win.isMinimized(),
        renderer: await run(`({visibility:document.visibilityState,focused:document.hasFocus(),size:[innerWidth,innerHeight]})`) };
      rows.push({ name, durationMs, animations, counts, totalsMs, cpu, ui, windowState });
      console.log(name + ': ' + JSON.stringify({ frames: counts.DrawFrame || 0, paints: counts.Paint || 0,
        commits: ui.commits.length, animations: animations.map(a=>a.name), windowState,
        cpu: cpu.map(sample=>sample.filter(m=>m.role==='GPU').reduce((sum,m)=>sum+m.percent,0)) }));
    }
    const suppression = `var style=document.getElementById('idle-experiment'); if(!style){style=document.createElement('style');style.id='idle-experiment';document.head.append(style)};`;
    await sample('downloads-solid', `perfAppearance('minimal')`);
    await sample('downloads-liquid', `perfAppearance('aero')`);
    await sample('downloads-liquid-passive-disabled', suppression + `style.textContent=${JSON.stringify(passiveSelectors + '{animation:none!important}')} `);
    await run(`document.getElementById('idle-experiment').remove();document.querySelector('.pillar-btn:last-child').click()`);
    await until(`document.querySelector('.room-workspace') || document.querySelector('.room-file')`);
    await sample('rooms-liquid', `perfAppearance('aero')`);
    await sample('rooms-liquid-passive-disabled', suppression + `style.textContent=${JSON.stringify(passiveSelectors + '{animation:none!important}')} `);
    if (process.env.HAVVN_IDLE_VERIFY === '1') {
      for (const row of rows) {
        assert(row.windowState.visible && row.windowState.renderer.visibility === 'visible', row.name + ': window must stay visible');
        assert((row.counts.DrawFrame || 0) <= 4, row.name + ': unexpected idle frame stream');
        assert((row.counts.Paint || 0) <= 8, row.name + ': unexpected idle painting');
        assert(!row.animations.some(a => a.state === 'running'), row.name + ': unexpected continuous animation');
      }
      // Check all passive markers with real compiled product styles, including
      // presence/call states absent from the idle fixture's single-member room.
      assert(await run(`(() => {
        document.getElementById('idle-experiment')?.remove();
        return ${JSON.stringify(passiveSelectors)}.split(',').every(selector => {
          const marker=document.createElement('span'); marker.className=selector.slice(1); document.body.append(marker);
          const css=getComputedStyle(marker), okay=css.animationName==='none' && css.boxShadow!=='none';
          marker.remove(); return okay;
        });
      })()`), 'Passive indicators keep their glow without a loop');
      await run(`document.querySelector('.pillar-btn:first-child').click();perfSetStatus('0','downloading')`);
      await until(`document.querySelector('.download-st-downloading')`);
      // StatusBadge emits badge-downloading, while the existing animated CSS
      // rule is status-badge-downloading. Probe that real CSS separately instead
      // of pretending the current row mounts a pseudo-element animation.
      await run(`var probe=document.createElement('span');probe.id='motion-probe';probe.className='status-badge status-badge-downloading';document.body.append(probe)`);
      assert.equal(await run(`getComputedStyle(document.getElementById('motion-probe'),'::before').animationIterationCount`), 'infinite', 'Pseudo-element fixture starts its animation');
      await run(`document.documentElement.setAttribute('data-reduce-motion','')`); await wait(100);
      const reduced = await run(`(() => {const css=getComputedStyle(document.getElementById('motion-probe'),'::before');return {duration:parseFloat(css.animationDuration),iterations:css.animationIterationCount}})()`);
      assert(reduced.duration < .001 && reduced.iterations === '1', 'Reduced motion also stops pseudo-element loops');
      await run(`document.documentElement.removeAttribute('data-reduce-motion')`); await wait(100);
      assert.equal(await run(`getComputedStyle(document.getElementById('motion-probe'),'::before').animationIterationCount`), 'infinite', 'Turning reduced motion off restores pseudo-element motion');
      await run(`document.getElementById('motion-probe').remove();perfSetStatus('0','paused');document.querySelector('.status-graph-btn').click()`);
      await until(`!document.querySelector('.download-st-downloading') && document.querySelectorAll('.download-st-paused').length===3`);
      await until(`document.querySelector('.status-bar-graph canvas')?.width>0`);
      await run(`document.querySelector('.status-graph-btn').click()`);
      assert(!await run(`!!document.querySelector('.status-bar-graph')`), 'Graph controls remain responsive');
      console.log('Idle frame regression, passive markers, reduced-motion pseudo-elements and live controls: PASS');
    }
    if (errors.length) throw Error(errors.join('\n'));
    const result = { label: process.env.HAVVN_IDLE_LABEL, at: new Date().toISOString(), electron: process.versions.electron,
      mode: 'production React profiling; synthetic IPC; visible window; normal motion; hardware acceleration enabled; backgroundThrottling false ONLY in fixture to avoid native occlusion; CDP tracing',
      verified: process.env.HAVVN_IDLE_VERIFY === '1',
      hardware: { cpus: os.cpus().length, cpu: os.cpus()[0].model }, gpuStatus: app.getGPUFeatureStatus(),
      gpuInfo: await app.getGPUInfo('complete'), sourceHashes: JSON.parse(process.env.HAVVN_IDLE_HASHES), rows };
    fs.mkdirSync(path.dirname(process.env.HAVVN_IDLE_OUTPUT), { recursive: true });
    fs.writeFileSync(process.env.HAVVN_IDLE_OUTPUT, JSON.stringify(result, null, 2));
    console.log('Idle results: ' + process.env.HAVVN_IDLE_OUTPUT);
    win.destroy(); clearTimeout(timeout); app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1)});
}
