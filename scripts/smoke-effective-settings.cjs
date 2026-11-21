/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron UI acceptance. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-effective-ui-'));
  const env = { ...process.env, HAVVN_EFFECTIVE_UI: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  let completed = false;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { if (String(data).includes('PASS no renderer errors')) completed = true; process.stdout.write(data); });
  child.stderr.on('data', data => process.stderr.write(data));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('close', code => {
    process.exitCode = code === 0 && completed ? 0 : 1;
    if (!completed) console.error('UI acceptance did not complete');
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-effective-ui-')) throw Error('Unexpected UI profile');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_EFFECTIVE_UI || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-effective-ui-')) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => { /* The fixture owns shutdown between windows. */ });
  const deadline = setTimeout(() => { console.error('Effective settings UI deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const output = path.join(root, 'artifacts/effective-settings-ui'); fs.mkdirSync(output, { recursive: true });
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    const { EffectiveSettingsController } = require(path.join(root, 'dist/electron/electron/services/effective-settings.js'));
    let lastApplied, calls = 0, unavailable = false;
    const controller = new EffectiveSettingsController({ readBase: db.getSettings, readScheduler: db.getScheduler,
      now: () => new Date(2026, 9, 26, 12), apply: async value => { lastApplied = value; } });
    await db.updateSettings({ maxDownKbps: 500, maxUpKbps: 100, altDownKbps: 0, altUpKbps: 0, altSpeedEnabled: false, networkProfilesEnabled: true });
    await db.updateScheduler({ enabled: true, schedules: [{ id: 'day', days: [1], startTime: '00:00', endTime: '23:59', speedLimit: 300 }] });
    const network = { id: 'phone', name: 'Мобильная сеть с очень длинным названием для проверки переноса текста', networkKey: 'test', overrides: { maxDownKbps: 150, maxUpKbps: 200 } };
    await controller.setNetwork(network);
    ipcMain.handle('settings:effective', async () => { calls++; if (unavailable) throw Error('Fixture unavailable'); return controller.getSnapshot(); });
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/settings/controls.css', 'renderer/pages/settings/EffectiveLimits.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'ui.html'); fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '#root{max-width:900px;margin:24px auto;padding:0 24px;box-sizing:border-box}</style><div id="root"></div></html>');
    const bridge = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, preload: path.join(root, 'dist/electron/electron/preload.js') } });
    await bridge.loadFile(page); assert.equal((await bridge.webContents.executeJavaScript('window.api.getEffectiveSettings()')).download.value, 150); bridge.destroy();
    console.log('PASS production preload exposes effective settings over IPC');
    const win = new BrowserWindow({ show: false, width: 940, height: 760, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', message => { if (message.level === 'error') errors.push(message.message); });
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(db.readSettingsImportState())};
      var fixtureApiOverrides={getEffectiveSettings:()=>require('electron').ipcRenderer.invoke('settings:effective')};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/EffectiveLimits.tsx')).EffectiveLimits;
      dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Panel))));true;`);
    const pause = () => new Promise(resolve => setTimeout(resolve, 80));
    const check = async (label, expression) => { for (let i = 0; i < 60; i++) { if (await run(expression)) { console.log('PASS ' + label); return; } await pause(); } throw Error(label); };
    const refresh = async () => { await run('document.dispatchEvent(new Event("visibilitychange"));true'); await pause(); };
    const capture = async name => {
      const [width, height] = win.getSize(); win.setSize(width + 1, height); await pause();
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      win.setSize(width, height); await pause();
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await check('UI shows intersected saved limits and the network source', `document.body.innerText.includes('150 КБ/с')&&document.body.innerText.includes('100 КБ/с')&&document.body.innerText.includes('Мобильная сеть')`);
    await db.updateSettings({ maxDownKbps: 60 }); await controller.refresh(); await refresh();
    await check('Editing the base during a policy updates the effective value', `document.querySelector('.effective-limits-item strong').textContent==='60 КБ/с'`);
    await controller.setNetwork(null); await refresh(); assert.equal(lastApplied.maxDownKbps, 60);
    await check('Leaving a network preserves the current manual base', `!document.body.innerText.includes('Мобильная сеть')&&document.querySelector('.effective-limits-item strong').textContent==='60 КБ/с'`);
    await controller.setNetwork(network); await db.updateSettings({ altSpeedEnabled: true }); await controller.refresh(); await refresh();
    await check('Alternative unlimited values remain bounded by active policies', `document.body.innerText.includes('Альтернативные скорости')&&document.querySelector('.effective-limits-item strong').textContent==='150 КБ/с'`);
    controller.setBlock('vpn', true); controller.setBlock('disk', true); await refresh();
    await check('Both protection reasons are explained', `document.querySelector('.effective-limits-block').textContent.includes('VPN')&&document.querySelector('.effective-limits-block').textContent.includes('диске')`);
    controller.setBlock('vpn', false); await refresh();
    await check('VPN recovery cannot clear disk protection', `!document.querySelector('.effective-limits-block').textContent.includes('VPN')&&document.querySelector('.effective-limits-block').textContent.includes('диске')`);
    await capture('wide-dark-ru.png');
    win.setSize(520, 900); await pause();
    await check('Long source names fit a narrow window', `document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.effective-limits-item')].every(n=>n.scrollWidth<=n.clientWidth+1)`);
    await capture('narrow-dark-ru.png');
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');document.documentElement.dataset.theme='light';true`); win.webContents.setZoomFactor(1.25); await pause();
    await check('English labels fit at 125 percent zoom', `document.body.innerText.includes('Effective limits')&&document.documentElement.scrollWidth<=innerWidth`);
    win.setSize(520, 1100); await capture('narrow-light-en-125.png');
    unavailable = true; await refresh(); await check('An IPC failure hides stale claims of effective limits', `document.body.innerText.includes('unavailable')&&!document.querySelector('.effective-limits-item')`);
    unavailable = false; await refresh(); await check('The next read recovers without resetting preferences', `!!document.querySelector('.effective-limits-item')`);
    await run('dom.flushSync(()=>tree.render(null));true'); const before = calls; await refresh(); assert.equal(calls, before); console.log('PASS unmount removes its refresh listener');
    assert.deepEqual(errors, []); console.log('PASS no renderer errors'); win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
