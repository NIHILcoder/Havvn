/* eslint-disable @typescript-eslint/no-require-imports -- Isolated native Electron UI acceptance. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/dp04/ui');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-device-ui-')), children = [];
  fs.mkdirSync(output, { recursive: true });
  const checks = [], check = (ok, name) => { assert(ok, name); checks.push(name); console.log('PASS ' + name); };
  const pause = ms => new Promise(r => setTimeout(r, ms));
  async function launch(name, stage = 'ui') {
    const env = { ...process.env, HAVVN_DEVICE_UI: scratch, HAVVN_DEVICE_NAME: name, HAVVN_DEVICE_STAGE: stage }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    child.stdout.on('data', b => process.stdout.write(b)); child.stderr.on('data', b => process.stderr.write(b));
    child.done = new Promise(resolve => child.once('exit', resolve));
    let seq = 0; const pending = new Map();
    child.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error)) : p.resolve(m.value); } });
    child.request = (kind, code) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error('Native UI request timed out: ' + kind)); }, 30000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); child.send({ id, kind, code }); });
    if (stage === 'initialize') { assert.equal(await child.done, 0); return; }
    for (let i = 0; i < 300; i++) { if (child.exitCode !== null) throw Error('Native UI exited'); try { if (await child.request('ready')) return child; } catch { /* startup */ } await pause(100); }
    throw Error('UI startup timeout');
  }
  const run = (c, code) => c.request('evaluate', code), state = c => run(c, 'window.api.devices.state()');
  const click = (c, labels) => run(c, `(()=>{const labels=${JSON.stringify(labels)};const b=[...document.querySelectorAll('button')].find(b=>labels.includes(b.textContent.trim()));if(!b||b.disabled)throw Error('Missing enabled action '+labels.join('/'));b.click();return true})()`);
  async function until(fn) { const end = Date.now() + 30000; while (!await fn()) { if (Date.now() > end) throw Error('Native UI state timed out'); await pause(100); } }
  async function stop(c) { if (c.exitCode === null) { await c.request('quit'); assert.equal(await c.done, 0); } }
  (async () => {
    try {
      await launch('a', 'initialize'); await launch('b', 'initialize');
      let a = await launch('a'), b = await launch('b');
      check((await state(a)).status === 'off' && !fs.existsSync(path.join(scratch, 'a', 'devices')), 'ordinary startup leaves feature off without a vault');
      check(await a.request('untrusted'), 'another sandbox renderer cannot read device state through production IPC');
      check(await run(a, `window.api.devices.command({kind:'enable',enabled:true,unknown:'field'}).then(()=>false,()=>true)`) && (await state(a)).status === 'off', 'invalid IPC request is rejected before enabling or creating a key');
      for (const c of [a, b]) {
        await run(c, `document.querySelector('[role="switch"]').click()`);
        await until(async () => (await state(c)).status === 'unpaired');
        // Production UI uses fixed explicit ports; select a free local port through the same validated service.
        await run(c, `window.api.devices.command({kind:'configure',listen:{host:'127.0.0.1',port:0},remote:null,scopes:['preferences']})`);
      }
      await click(a, ['Создать приглашение', 'Create invitation']);
      await until(async () => (await state(a)).status === 'inviting');
      const invitation = await run(a, `document.querySelector('textarea[readonly]').value`);
      const qrLabels = ['ru', 'en'].map(lang => JSON.parse(fs.readFileSync(path.join(root, 'renderer/i18n/' + lang + '.json'), 'utf8'))['devices.invite.showQr']);
      await click(a, qrLabels); await until(async () => await run(a, 'document.querySelector("canvas")?.width===560'));
      const qr = require('qrcode').create(invitation, { errorCorrectionLevel: invitation.length > 230 ? 'L' : 'M' }).modules;
      const pixels = await run(a, '(()=>{const c=document.querySelector("canvas");return [...c.getContext("2d").getImageData(0,0,c.width,c.height).data]})()');
      let sameQr = true, mismatches = 0; const scale = 560 / (qr.size + 2);
      for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) {
        const pixel = pixels[(Math.round((y + 1.5) * scale) * 560 + Math.round((x + 1.5) * scale)) * 4];
        if ((pixel < 128 ? 1 : 0) !== qr.data[y * qr.size + x]) { sameQr = false; mismatches++; }
      }
      if (!sameQr) console.error('QR comparison', { length: invitation.length, size: qr.size, mismatches, currentTextMatches: await run(a, `document.querySelector('textarea[readonly]').value===${JSON.stringify(invitation)}`) });
      check(sameQr, 'native QR encodes exactly the real backend invitation accepted by the second device');
      await a.request('screenshot', 'invitation-qr.png');

      await run(b, `(()=>{const f=document.querySelector('textarea:not([readonly])');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,${JSON.stringify(invitation)});f.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
      await pause(150); await click(b, ['Подключить устройство', 'Connect device']);
      await until(async () => !!(await state(b)).confirmation);
      const bp = (await state(b)).confirmation, as = await state(a);
      check(bp.peer === as.self && bp.self !== bp.peer, 'production consent modal shows distinct complete peer fingerprints');
      await until(async () => await run(b, `!!document.querySelector('[role="dialog"] [role="switch"]')`));
      await b.request('screenshot', 'fingerprints-en.png');
      for (const c of [b, a]) {
        await until(async () => !!(await state(c)).confirmation);
        await until(async () => await run(c, `!!document.querySelector('[role="dialog"] [role="switch"]')`));
        await run(c, `(()=>{const d=document.querySelector('[role="dialog"]');d.querySelector('[role="switch"]').click();return true})()`);
        await pause(100); await click(c, ['Связать устройства', 'Pair devices']);
      }
      await until(async () => (await state(a)).status === 'online' && (await state(b)).status === 'online');
      check(!(await state(a)).approved && !(await state(b)).approved && await run(b, `localStorage.getItem('density')===null`), 'pairing alone does not approve or apply the first exchange');
      const approve = async c => { await click(c, ['Проверить и разрешить обмен', 'Review and approve exchange']); await pause(150); await click(c, ['Разрешить выбранные данные', 'Approve selected data']); await until(async () => (await state(c)).approved); };
      await approve(a); await until(async () => (await state(b)).pending > 0);
      check(await run(b, `localStorage.getItem('density')===null`), 'incoming changes wait for approval on the receiving device');
      await approve(b);
      await until(async () => await run(b, `localStorage.getItem('density')==='compact' && document.documentElement.dataset.density==='compact'`));
      await until(async () => (await state(a)).outbox === 0);
      check(true, 'real sandbox preload applies preferences live and ACK follows local materialization');
      await pause(16000);
      check((await state(a)).status === 'online' && (await state(b)).status === 'online', 'authenticated heartbeats keep an idle connection alive past the wire timeout');
      await a.request('screenshot', 'devices-ru.png');
      await run(b, `localStorage.setItem('uiScale','110');window.dispatchEvent(new Event('havvn:device-local'));true`);
      await until(async () => await run(a, `localStorage.getItem('uiScale')==='110'`));
      check(true, 'ordinary local preference events publish bidirectionally');
      await until(async () => (await state(a)).outbox === 0 && (await state(b)).outbox === 0);
      const route = (await state(b)).config;
      await run(b, `window.api.devices.command(${JSON.stringify({ kind: 'configure', listen: route.listen, remote: { ...route.remote, port: 65534 }, scopes: route.scopes })})`);
      await run(a, `localStorage.setItem('uiScale','90');window.dispatchEvent(new Event('havvn:device-local'));true`);
      await run(b, `localStorage.setItem('uiScale','125');window.dispatchEvent(new Event('havvn:device-local'));true`);
      await until(async () => (await state(a)).outbox > 0 && (await state(b)).outbox > 0);
      await run(b, `window.api.devices.command(${JSON.stringify({ kind: 'configure', listen: route.listen, remote: route.remote, scopes: route.scopes })})`);
      await until(async () => (await state(a)).conflicts > 0 && (await state(b)).conflicts > 0);
      await until(async () => await run(a, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Оставить текущее локальное значение')`));
      await click(a, ['Оставить текущее локальное значение', 'Keep current local value']);
      await until(async () => await run(a, `!!document.querySelector('[role="dialog"] pre')`));
      await a.request('screenshot', 'conflict-preview-ru.png');
      await click(a, ['Применить эту версию', 'Apply this version']);
      await until(async () => (await state(a)).conflicts === 0 && (await state(b)).conflicts === 0 && await run(b, `localStorage.getItem('uiScale')==='90'`));
      check(true, 'offline concurrent edits remain a conflict until a reviewed UI choice resolves them causally');
      const before = await state(a); await stop(a); a = await launch('a');
      await until(async () => (await state(a)).status === 'online');
      check((await state(a)).self === before.self && (await state(a)).approved, 'fresh main process restores identity, consent and saved listener route');
      await b.request('quit'); await b.done;
      await click(a, ['Отозвать доступ', 'Revoke access']);
      await until(async () => (await state(a)).status === 'revoked');
      check((await state(a)).outbox === 0, 'offline revoke commits through production UI and clears old outbox');
      await a.request('screenshot', 'revoked-ru.png');
      b = await launch('b'); await pause(1200);
      check((await state(b)).status !== 'online', 'stale peer cannot reconnect after offline revocation');
      const overflow = await run(a, `(()=>{const root=document.querySelector('[data-devices-section]');return root.scrollWidth>root.clientWidth+1||[...root.querySelectorAll('.btn')].some(b=>b.scrollWidth>b.clientWidth+1)})()`);
      check(!overflow, 'Russian controls and fingerprints fit the actual rendered page');
      await a.request('resize', { width: 640, height: 900 });
      await pause(200);
      check(await run(a, `document.querySelector('[data-devices-section]').scrollWidth<=document.querySelector('[data-devices-section]').clientWidth+1`), 'narrow layout wraps long fingerprints without horizontal overflow');
      await a.request('screenshot', 'devices-narrow-ru.png');
      const oldIdentity = (await state(a)).self;
      await click(a, ['Архивировать состояние устройств', 'Archive device state']);
      await until(async () => await run(a, `!!document.querySelector('[role="dialog"] input')`));
      await run(a, `(()=>{const f=document.querySelector('[role="dialog"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(f,'RESET');f.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
      await pause(100); await click(a, ['Архивировать и выключить', 'Archive and turn off']);
      await until(async () => (await state(a)).status === 'off');
      const archive = fs.readdirSync(path.join(scratch, 'a')).find(f => f.startsWith('devices-archive-'));
      assert(archive && !fs.existsSync(path.join(scratch, 'a', 'devices')));
      assert(!fs.readFileSync(path.join(scratch, 'a', archive, 'device-state.json'), 'utf8').includes('PRIVATE KEY'));
      await until(async () => await run(a, `!document.querySelector('[role="dialog"]')`));
      await run(a, `document.querySelector('[role="switch"]').click()`);
      await until(async () => (await state(a)).status === 'unpaired');
      check((await state(a)).self !== oldIdentity && await run(a, `localStorage.getItem('uiScale')==='90'`), 'explicit RESET archives encrypted state, keeps preferences and requires a fresh identity');
      await stop(b); await stop(a);
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ stage: 'DP-04', date: new Date().toISOString(), checks, physicalDevices: false }, null, 2) + '\n');
    } finally {
      for (const c of children) if (c.exitCode === null) { c.kill(); await c.done; }
      const target = path.resolve(scratch);
      if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-device-ui-')) throw Error('Unsafe scratch path');
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
  const scratch = path.resolve(process.env.HAVVN_DEVICE_UI || ''), name = process.env.HAVVN_DEVICE_NAME;
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-device-ui-') || !['a', 'b'].includes(name)) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, name)); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  assert(app.requestSingleInstanceLock());
  let win, service;
  process.on('message', async m => {
    try {
      let value;
      if (m.kind === 'ready') value = !!win && !win.isDestroyed() && await win.webContents.executeJavaScript(`!!document.querySelector('[data-devices-section]')`);
      else if (m.kind === 'untrusted') {
        const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, 'dist/electron/electron/preload.js') } });
        try { await other.loadURL('data:text/html,<html><body>Untrusted IPC probe</body></html>'); value = await other.webContents.executeJavaScript('window.api.devices.state().then(()=>false,()=>true)'); } finally { other.destroy(); }
      }
      else if (m.kind === 'resize') { assert(m.code.width >= 600 && m.code.width <= 1500); win.setSize(m.code.width, m.code.height); value = true; }
      else if (m.kind === 'evaluate') value = await win.webContents.executeJavaScript(m.code);
      else if (m.kind === 'screenshot') { assert.equal(path.basename(m.code), m.code); await win.webContents.executeJavaScript('document.getAnimations().forEach(a=>a.finish());true'); await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await new Promise(r => setTimeout(r, 300)); fs.writeFileSync(path.join(output, m.code), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); value = true; }
      else if (m.kind === 'quit') { await service.close(); process.send({ id: m.id, value: true }); app.quit(); return; }
      process.send({ id: m.id, value });
    } catch (e) { process.send({ id: m.id, error: e.message }); }
  });
  app.whenReady().then(async () => {
    if (process.env.HAVVN_DEVICE_STAGE === 'initialize') { assert(safeStorage.isEncryptionAvailable()); safeStorage.encryptString('native-ui-initialization'); app.quit(); return; }
    win = new BrowserWindow({ show: false, width: 1080, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(root, 'dist/electron/electron/preload.js') } });
    win.webContents.on('did-finish-load', () => { void win.webContents.insertCSS('body{margin:0;padding:24px;box-sizing:border-box}#root{max-width:940px;margin:auto}'); });
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    ipcMain.handle('categories:get', () => db.getCategories());
    service = require(path.join(root, 'dist/electron/electron/ipc/devices.js')).registerDeviceUi(win, { deviceFiles: async () => [] }, { activeTargets: () => [] });
    await win.loadFile(path.join(root, 'dist/device-ui/index.html'));
    // Seed only the source; no localStorage setters are exposed by the production preload.
    if (name === 'a' && !fs.existsSync(path.join(app.getPath('userData'), 'seeded'))) { await win.webContents.executeJavaScript(`localStorage.setItem('language','ru');localStorage.setItem('density','compact');true`); fs.writeFileSync(path.join(app.getPath('userData'), 'seeded'), '1'); await win.reload(); }
    await win.webContents.insertCSS('body{margin:0;padding:24px;box-sizing:border-box}#root{max-width:940px;margin:auto}');
  }).catch(e => { console.error(e); app.exit(1); });
}
