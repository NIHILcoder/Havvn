// Real production startup entry under CSP, with a synthetic isolated profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), evidenceBase = process.env.HAVVN_STARTUP_EVIDENCE || os.tmpdir();
  fs.mkdirSync(evidenceBase, { recursive: true });
  const out = fs.mkdtempSync(path.join(evidenceBase, 'havvn-startup-'));
  app.setPath('userData', path.join(out, 'profile'));
  const deadline = setTimeout(() => app.exit(1), 45000);
  let preferences = {}, logsOpened = 0;
  const windowActions = { minimize: 0, maximize: 0, close: 0 };
  ipcMain.on('startup:preferences', event => { event.returnValue = preferences; });
  ipcMain.handle('startup:logs', () => { logsOpened++; });
  ipcMain.on('startup:window', (_event, action) => { if (Object.hasOwn(windowActions, action)) windowActions[action]++; });
  app.whenReady().then(async () => {
    const source = fs.readFileSync(path.join(root, 'dist/renderer/index.html'), 'utf8');
    assert(source.includes('startup.js') && source.indexOf('startup.js') < source.indexOf('bundle.js'));
    assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(source), 'No inline startup script');
    const html = source.replace(/<script\b[^>]*\bsrc=["']?\.\/bundle\.js["']?[^>]*>\s*<\/script>/gi, '')
      .replace(/(<script\b[^>]*\bsrc=)["']?\.\/startup\.js["']?/gi, '$1"' + pathToFileURL(path.join(root, 'dist/renderer/startup.js')).href + '"')
      .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'">`);
    const page = path.join(out, 'startup.html'), preload = path.join(out, 'preload.cjs');
    fs.writeFileSync(page, html);
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron'); localStorage.clear(); for(const [k,v] of Object.entries(ipcRenderer.sendSync('startup:preferences')))localStorage.setItem(k,v);contextBridge.exposeInMainWorld('api',{openLogsFolder:()=>ipcRenderer.invoke('startup:logs'),win:{minimize:()=>ipcRenderer.send('startup:window','minimize'),toggleMaximize:()=>ipcRenderer.send('startup:window','maximize'),close:()=>ipcRenderer.send('startup:window','close')}});`);
    const win = new BrowserWindow({ width: 1200, height: 780, frame: false, show: false,
      webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const run = code => win.webContents.executeJavaScript(code);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const capture = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); }
        catch (error) { if (attempt === 2) throw error; await wait(200); }
      }
    };
    const screenshot = async name => {
      await capture(); await wait(160);
      fs.writeFileSync(path.join(out, name + '.png'), (await capture()).toPNG());
    };
    const inspect = () => run(`({lang:document.documentElement.lang,mode:document.documentElement.dataset.theme,glass:document.getElementById('th-splash').dataset.glass,backdrop:document.getElementById('th-splash').dataset.backdrop,status:document.getElementById('th-splash-status').textContent,theme:document.getElementById('th-splash-theme-name').textContent,accent:getComputedStyle(document.documentElement).getPropertyValue('--color-accent-primary').trim(),bg:getComputedStyle(document.getElementById('th-splash')).backgroundColor,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,splashScrollWidth:document.getElementById('th-splash').scrollWidth,splashClientWidth:document.getElementById('th-splash').clientWidth,surfaceWidth:document.querySelector('.th-splash-window').getBoundingClientRect().width,steps:[...document.querySelectorAll('.th-splash-steps li')].map(step=>step.dataset.state),animation:getComputedStyle(document.querySelector('.th-splash-track'),'::after').animationName})`);
    const load = async prefs => { preferences = prefs; await win.loadFile(page); await wait(120); return inspect(); };
    const dark = await load({ theme: 'dark', language: 'en' });
    assert.equal(dark.glass, 'false'); assert.equal(dark.status, 'Loading settings'); await screenshot('havvn');
    assert.equal(dark.surfaceWidth, dark.width); assert.deepEqual(dark.steps, ['active', 'pending', 'pending']);
    for (const action of ['minimize', 'maximize', 'close']) await run(`document.getElementById('th-splash-${action}').click()`);
    await wait(50); assert.deepEqual(windowActions, { minimize: 1, maximize: 1, close: 1 });
    await load({ theme: 'dark', language: 'ru' }); await screenshot('dark-ru');
    const light = await load({ theme: 'light', language: 'ru', reduceMotion: '1' });
    assert.equal(light.mode, 'light'); assert.equal(light.status, 'Загрузка настроек'); assert.equal(light.animation, 'none');
    assert.notEqual(light.bg, dark.bg, 'Built-in light mode is restored by the early entry');
    await screenshot('light');
    const { DEFAULT_APPEARANCE } = require(path.join(root, 'dist/electron/shared/appearance.js'));
    // Deliberately self-contained: no user's personal theme or image is required.
    const appearance = { ...DEFAULT_APPEARANCE, background: 'aero' };
    const theme = { version: 1, id: 'startup-fixture', name: 'Aero fixture', base: 'light',
      light: { '--color-accent-primary': '#075fb6', '--color-text-primary': '#103450', '--color-bg-primary': '#ecfaff', '--color-bg-secondary': '#d5f2ff', '--color-logo': '#075fb6' },
      dark: {}, glass: { material: 'liquid', intensity: 85, opacity: 68, blur: 22, tint: 8, highlight: 78, depth: 22,
        quality: 'full', motion: false, scopes: [...DEFAULT_APPEARANCE.scopes], radii: { panels: 24, cards: 22, buttons: 14, inputs: 14 } } };
    // Match the validated portable schema; the fixture must actually be accepted.
    const { validateTheme } = require(path.join(root, 'dist/electron/shared/theme.js'));
    const validated = validateTheme(theme); assert(validated.ok, JSON.stringify(validated));
    const aeroPrefs = { theme: 'light', language: 'ru', 'havvn.theme.active': theme.id,
      'havvn.theme.library': JSON.stringify([theme]), 'havvn.appearance.v1': JSON.stringify(appearance) };
    const aero = await load(aeroPrefs);
    assert.equal(aero.glass, 'true'); assert.equal(aero.backdrop, 'aero'); assert.equal(aero.accent, '#075fb6');
    assert.equal(aero.theme, theme.name); assert.equal(aero.animation, 'none'); await screenshot('aero');
    win.setSize(320, 540); await wait(100);
    const narrow = await inspect(); assert.equal(narrow.width, narrow.scrollWidth); assert.equal(narrow.splashClientWidth, narrow.splashScrollWidth); await screenshot('narrow');
    const corrupt = await load({ theme: 'dark', 'havvn.theme.library': '{invalid', 'havvn.appearance.v1': '{invalid' });
    assert.equal(corrupt.glass, 'false'); assert.equal(corrupt.backdrop, 'none');
    await wait(6200);
    assert.equal(await run(`document.getElementById('th-splash-slow').hidden`), false);
    assert.equal(await run(`!!document.getElementById('th-splash')`), true, 'A failed mount retains recovery controls');
    const recoveryVisible = await run(`(() => {const button=document.getElementById('th-splash-reload');button.focus();button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;})()`);
    assert.equal(recoveryVisible, true, 'Recovery controls remain reachable in a short narrow window');
    await screenshot('slow-recovery');
    await run(`document.getElementById('th-splash-logs').click()`); await wait(100); assert.equal(logsOpened, 1);
    assert.deepEqual(errors, []);
    const result = { passed: true, output: out, checks: ['CSP', 'early dark/light/theme restore', 'full-window surface', 'milestones', 'window controls', 'glass', 'locale', 'reduced motion', 'narrow layout', 'corrupt prefs', 'failed mount recovery', 'logs'], dark, light, aero, narrow };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    win.destroy(); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
