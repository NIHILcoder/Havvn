/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Windows NSIS acceptance. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const repository = path.resolve(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const output = path.join(plan.root, 'installer-acceptance.json');
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], limitations: plan.limitations };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
const check = (id, details = {}) => { report.checks.push({ id, passed: true, ...details }); save(); console.log('PASS', id); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function registry(key) {
  const result = spawnSync('reg.exe', ['query', key, '/s', '/reg:64'], { windowsHide: true, encoding: 'utf8' });
  if (result.status === 1) return null;
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function execute(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(Error('Installer timed out')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(Error(`Installer exited ${code}`)); });
  });
}
async function freePort() {
  const server = require('node:net').createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const env = { ...process.env, TH_INSTANCE: plan.instance, HAVVN_SMOKE_PROFILE: plan.profileBase,
  HAVVN_ENGINE: 'native', HAVVN_FILE_SYNC: '1', NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
function seedProfile(base, instance) {
  const isolatedEnv = { ...env, TH_INSTANCE: instance, HAVVN_SMOKE_PROFILE: base };
  fs.mkdirSync(path.join(base, 'downloads'), { recursive: true });
  const profile = `${base}-${instance}`;
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ defaultsSeeded: true, suggestedFeedSeeded: true,
    splitStoresMigrated: true, utpDefaultOnMigrated: true, vpnWarningDismissed: true }));
  const seed = spawnSync(require('electron'), [path.join(__dirname, 'smoke-packaged.cjs')], {
    env: isolatedEnv, windowsHide: true, timeout: 60000, stdio: 'pipe',
  });
  assert.equal(seed.status, 0, String(seed.stderr));
  return isolatedEnv;
}
async function appSession(version, body, sessionEnv = env) {
  const port = await freePort();
  const child = spawn(path.join(plan.installDirectory, plan.executable), [`--user-data-dir=${sessionEnv.HAVVN_SMOKE_PROFILE}`,
    '--havvn-start-hidden', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  { env: sessionEnv, windowsHide: true, stdio: 'pipe' });
  const log = fs.createWriteStream(path.join(plan.root, `installed-${version}.log`), { flags: 'a' });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let exited = false, socket, seq = 0; child.once('exit', () => { exited = true; });
  child.once('error', error => { exited = true; log.write(String(error)); });
  try {
    let page; const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !exited) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(p => p.type === 'page' && p.url.includes('/renderer/index.html')); } catch { /* Startup endpoint is not listening yet. */ }
      if (page) break; await delay(200);
    }
    assert.ok(page, 'Installed renderer unavailable'); socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const evaluate = expression => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(Error('Installed IPC timeout')); }, 45000);
      function receive(event) {
        const message = JSON.parse(event.data); if (message.id !== id) return;
        clearTimeout(timer); socket.removeEventListener('message', receive);
        if (message.error || message.result?.exceptionDetails) reject(Error(JSON.stringify(message)));
        else resolve(message.result.result.value);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    let ready = false;
    while (Date.now() < deadline && !exited) {
      try { ready = await evaluate("document.readyState === 'complete' && !!window.api && !!document.getElementById('root')?.childElementCount && !document.getElementById('th-splash')"); } catch (error) {
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      if (ready) break; await delay(200);
    }
    assert.ok(ready); assert.equal(await evaluate('window.api.getAppVersion()'), version);
    assert.equal(await evaluate('window.api.getRunningEngine()'), 'native');
    assert.equal(await evaluate("typeof window.require === 'undefined' && typeof window.process === 'undefined'"), true);
    await body(evaluate);
    socket.send(JSON.stringify({ id: ++seq, method: 'Runtime.evaluate', params: { expression: 'window.api.win.close()' } }));
    for (let i = 0; i < 100 && !exited; i++) await delay(100);
    assert.ok(exited, 'Installed app did not close normally');
  } finally {
    socket?.close();
    if (!exited && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    log.end();
  }
}
// This function runs inside the installed renderer through appSession.
async function settingsUi(phase, name, labels) {
  const query = selector => document.querySelector(selector);
  const textButton = (selector, label) => Array.from(document.querySelectorAll(selector)).find(node => node.textContent.trim() === label);
  async function wait(find, description) {
    const until = Date.now() + 6000;
    do {
      const value = find();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    const controls = Array.from(document.querySelectorAll('.working-actions button, .working-current, .stg-save-note, [role="alert"]'))
      .map(node => [node.textContent.trim().slice(0, 120), node.disabled ?? null]);
    throw Error('Settings UI: ' + description + ' ' + JSON.stringify(controls));
  }
  function input(node, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const binding = () => JSON.parse(localStorage.getItem('hotkeys') || '[]').find(h => h.id === 'open-settings')?.keys;
  const savedProfile = () => JSON.parse(localStorage.getItem('havvn.working-profiles.v1') || '{"profiles":[]}').profiles.find(p => p.name === name);
  document.querySelector('.first-chooser .modal-close, .first-chooser .modal-footer button')?.click();
  if (phase === 'seed' || phase === 'fresh') {
    (await wait(() => query('.sidebar-util-btn[aria-label="' + labels['nav.settings'] + '"]'), 'open settings from sidebar')).click();
  } else {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  }
  await wait(() => query('.stg-nav-search input'), 'open settings');
  if (phase === 'seed') {
    (await wait(() => textButton('.stg-nav-item', labels['settings.hotkeys']), 'hotkeys tab')).click();
    const row = await wait(() => Array.from(document.querySelectorAll('.hotkey-item')).find(n => n.textContent.includes(labels['hotkeys.openSettings'])), 'open-settings binding');
    row.querySelector('.hotkey-display').click();
    const recorder = await wait(() => query('.hotkey-recorder'), 'hotkey recorder');
    recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', code: 'KeyJ', ctrlKey: true, altKey: true, bubbles: true }));
    await wait(() => binding()?.join('+') === 'Ctrl+Alt+KeyJ', 'persist customized shortcut');
    textButton('.stg-nav-item', labels['settings.interface']).click();
    const field = await wait(() => query('.working-actions')?.closest('.stg-card')?.querySelector('input[aria-label="' + labels['working.name'] + '"]'), 'working profile editor');
    input(field, name);
    (await wait(() => textButton('.working-actions button:enabled', labels['working.save']), 'save working profile')).click();
    await wait(savedProfile, 'read saved working profile');
  } else {
    input(query('.stg-nav-search input'), 'download folder');
    await wait(() => query('.stg-nav-result > span')?.textContent === labels['settings.defaultDir'], 'rank default folder first');
    query('.stg-nav-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(() => document.activeElement?.getAttribute('data-setting-label') === labels['settings.defaultDir'], 'focus download folder from search');
  }
  return { binding: binding() ?? null, profile: savedProfile() ?? null, limit: (await window.api.getSettings()).maxDownKbps };
}
const settingsLabels = Object.fromEntries(['nav.settings', 'settings.hotkeys', 'settings.interface', 'hotkeys.openSettings',
  'working.name', 'working.save', 'settings.defaultDir'].map(key => [key, require('../renderer/i18n/en.json')[key]]));
const runSettingsUi = (evaluate, phase) => evaluate(`(${settingsUi.toString()})(${JSON.stringify(phase)}, ${JSON.stringify('Installer profile ' + plan.id)}, ${JSON.stringify(settingsLabels)})`);
(async () => {
  assert.equal(process.platform, 'win32');
  assert.match(plan.id, /^[a-f0-9]{6}$/);
  assert.equal(plan.namespace, `HavvnAcceptance${plan.id}`);
  assert.equal(path.resolve(plan.root), path.join(repository, 'release/installer-acceptance', plan.id));
  for (const field of ['installDirectory', 'profileBase', 'baselineInstaller', 'updatedInstaller']) {
    assert.ok(path.resolve(plan[field]).startsWith(plan.root + path.sep), 'Test path escapes private root');
  }
  assert.equal(plan.executable, plan.namespace + '.exe');
  assert.equal(plan.shortcutName, 'Havvn Acceptance ' + plan.id);
  const privateKey = `HKCU\\Software\\${plan.namespace}`;
  const resumeInstalled = process.argv.includes('--resume-installed-baseline');
  if (resumeInstalled) {
    assert.ok(registry(privateKey));
    assert.ok(fs.existsSync(path.join(plan.installDirectory, plan.executable)));
    report.resumedInstalledBaseline = true;
  } else {
    assert.equal(registry(privateKey), null, 'Acceptance identity already installed');
    assert.equal(fs.existsSync(plan.installDirectory), false, 'Acceptance install directory exists');
  }
  const productionKeys = ['HKCU\\Software\\Havvn', 'HKCU\\Software\\Classes\\magnet', 'HKCU\\Software\\Classes\\.torrent'];
  const before = productionKeys.map(registry), productionExe = 'D:/Havvn/Havvn.exe';
  const productionHash = fs.existsSync(productionExe) ? hash(productionExe) : null;
  report.installers = { baseline: hash(plan.baselineInstaller), updated: hash(plan.updatedInstaller) }; save();
  const folders = JSON.parse(spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "@{desktop=[Environment]::GetFolderPath('Desktop');menu=[Environment]::GetFolderPath('StartMenu')} | ConvertTo-Json -Compress"],
  { windowsHide: true, encoding: 'utf8' }).stdout);
  const shortcuts = [path.join(folders.desktop, plan.shortcutName + '.lnk'), path.join(folders.menu, 'Programs', plan.shortcutName + '.lnk')];
  const associationKeys = [`HKCU\\Software\\Classes\\.havvn-acceptance-${plan.id}`,
    `HKCU\\Software\\Classes\\${plan.namespace}.file`, `HKCU\\Software\\Classes\\havvn-acceptance-magnet-${plan.id}`];
  if (!resumeInstalled) await execute(plan.baselineInstaller, ['/S', '/currentuser', `/D=${plan.installDirectory}`]);
  assert.ok(fs.existsSync(path.join(plan.installDirectory, plan.executable)));
  for (const shortcut of shortcuts) assert.ok(fs.existsSync(shortcut), `Missing shortcut ${shortcut}`);
  for (const key of associationKeys) assert.ok(registry(key), `Missing private association ${key}`);
  const registration = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    '/s', '/f', plan.executable, '/d', '/reg:64'], { windowsHide: true, encoding: 'utf8' });
  const uninstallKeys = registration.stdout.split(/\r?\n/).filter(line => /^HKEY_CURRENT_USER\\.+Uninstall\\/.test(line));
  assert.equal(uninstallKeys.length, 1, 'Private uninstall registration is missing or ambiguous');
  const uninstallKey = uninstallKeys[0].trim();
  assert.ok(registry(uninstallKey).includes(plan.installDirectory));
  assert.ok(registry(privateKey)); check('fresh-nsis-install-private-shortcuts-and-associations');
  const asar = require('@electron/asar'), archive = path.join(plan.installDirectory, 'resources/app.asar');
  const entries = asar.listPackage(archive);
  assert.ok(entries.some(e => /dist[\\/]renderer[\\/]index.html$/.test(e)));
  assert.ok(entries.some(e => /room-document-worker\.js$/.test(e)));
  assert.equal(entries.some(e => /[\\/]dist[\\/](room-sync-|feature-tour-|windows11-glass)/.test(e)), false);
  report.baselineAsar = hash(archive); check('packaging-includes-runtime-excludes-test-profiles');
  if (plan.packages?.baseline) assert.equal(report.baselineAsar, plan.packages.baseline.asarSha256);
  const profile = `${plan.profileBase}-${plan.instance}`;
  seedProfile(plan.profileBase, plan.instance);
  const payload = path.join(plan.profileBase, 'downloads', 'installation-fixture.bin');
  fs.writeFileSync(payload, crypto.randomBytes(32768)); const payloadHash = hash(payload);
  const torrentSource = path.join(plan.root, 'source', 'paused-fixture.bin');
  fs.mkdirSync(path.dirname(torrentSource), { recursive: true });
  fs.writeFileSync(torrentSource, crypto.randomBytes(32768));
  const { default: createTorrent } = await import('create-torrent');
  const torrent = await new Promise((resolve, reject) => createTorrent(torrentSource, { announceList: [], private: true }, (error, bytes) => error ? reject(error) : resolve(bytes)));
  const torrentFile = path.join(plan.root, 'fixture.torrent'); fs.writeFileSync(torrentFile, torrent);
  let retained, settingsBefore;
  const baselineVersion = plan.packages?.baseline?.version || '3.2.0';
  const updatedVersion = plan.packages?.updated?.version || '3.2.1';
  report.versions = { baseline: baselineVersion, updated: updatedVersion };
  await appSession(baselineVersion, async evaluate => {
    if (plan.packages?.baseline) {
      settingsBefore = await runSettingsUi(evaluate, 'seed');
      assert.ok(settingsBefore.profile?.id);
      assert.deepEqual(settingsBefore.binding, ['Ctrl', 'Alt', 'KeyJ']);
      await evaluate('window.api.updateSettings({maxDownKbps:731})');
      settingsBefore.limit = await evaluate('(async () => (await window.api.getSettings()).maxDownKbps)()');
      assert.equal(settingsBefore.limit, 731);
      check('archived-ui-saves-custom-hotkey-and-working-profile');
      return;
    }
    retained = await evaluate(`(async () => {
      await window.api.updateSettings({maxDownKbps:731, closeToTray:false});
      const download=await window.api.addDownload(${JSON.stringify({ sourceType: 'torrent_file', sourceUri: torrentFile, savePath: path.dirname(payload), paused: true })});
      const room=await window.api.rooms.create('Installer retention',true,false);
      const view=await window.api.rooms.documents.view(room.roomId);
      const doc=await window.api.rooms.documents.create(room.roomId,'Retained document','markdown','# Survives update',[view.selfId]);
      const opened=await window.api.rooms.documents.open(room.roomId,doc.documentId);
      const snapshot=await window.api.rooms.documents.snapshot(room.roomId,opened.token,'Before update');
      await window.api.rooms.documents.close(room.roomId,opened.token);
      return {downloadId:download.id,roomId:room.roomId,documentId:doc.documentId,selfId:view.selfId,snapshotId:snapshot.id};
    })()`);
    assert.ok(retained.downloadId && retained.snapshotId); check('installed-baseline-real-engine-room-document-snapshot');
  });
  // A deleted upgrade shortcut must remain deleted. Only our private link is removed.
  fs.unlinkSync(shortcuts[0]);
  await execute(plan.updatedInstaller, ['/S', '/currentuser', `/D=${plan.installDirectory}`]);
  assert.equal(fs.existsSync(shortcuts[0]), false, 'Upgrade recreated declined desktop shortcut');
  assert.ok(fs.existsSync(shortcuts[1])); report.updatedAsar = hash(archive);
  assert.notEqual(report.baselineAsar, report.updatedAsar); check('same-guid-nsis-replacement-preserves-shortcut-choice');
  if (plan.packages?.updated) assert.equal(report.updatedAsar, plan.packages.updated.asarSha256);
  await appSession(updatedVersion, async evaluate => {
    if (settingsBefore) {
      assert.deepEqual(await runSettingsUi(evaluate, 'upgrade'), settingsBefore);
      check('upgrade-retains-profile-and-opens-settings-with-custom-hotkey-and-search');
      return;
    }
    await evaluate(`(async () => {
      const until=Date.now()+30000;
      while (Date.now()<until) {
        try { if ((await window.api.rooms.documents.view(${JSON.stringify(retained.roomId)})).enabled) return true; } catch {}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('Persisted room was not restored');
    })()`);
    const state = await evaluate(`(async () => {
      const settings=await window.api.getSettings(), downloads=await window.api.getDownloads();
      const view=await window.api.rooms.documents.view(${JSON.stringify(retained.roomId)});
      const opened=await window.api.rooms.documents.open(${JSON.stringify(retained.roomId)},${JSON.stringify(retained.documentId)});
      const history=await window.api.rooms.documents.history(${JSON.stringify(retained.roomId)},opened.token);
      await window.api.rooms.documents.close(${JSON.stringify(retained.roomId)},opened.token);
      return {limit:settings.maxDownKbps,dir:settings.defaultDownloadDir,downloads,selfId:view.selfId,state:opened.state,history};
    })()`);
    assert.equal(state.limit, 731); assert.equal(path.resolve(state.dir), path.dirname(payload));
    assert.ok(state.downloads.some(d => d.id === retained.downloadId && d.status === 'paused'));
    assert.equal(state.selfId, retained.selfId); assert.ok(state.history.some(h => h.id === retained.snapshotId));
    const Y = await import('yjs'), doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state.state, 'base64'));
    assert.equal(doc.getText('text').toString(), '# Survives update'); doc.destroy();
    assert.equal(hash(payload), payloadHash); check('updated-app-retains-settings-paused-download-room-identity-document-history');
    const editable = await evaluate(`window.api.rooms.documents.open(${JSON.stringify(retained.roomId)},${JSON.stringify(retained.documentId)})`);
    const edited = new Y.Doc(); Y.applyUpdate(edited, Buffer.from(editable.state, 'base64'));
    edited.getText('text').insert(edited.getText('text').length, '\nEdited after NSIS update');
    const encoded = Buffer.from(Y.encodeStateAsUpdate(edited)).toString('base64'); edited.destroy();
    const restored = await evaluate(`(async () => {
      await window.api.rooms.documents.update(${JSON.stringify(retained.roomId)},${JSON.stringify(editable.token)},${JSON.stringify(encoded)});
      const restored=await window.api.rooms.documents.restore(${JSON.stringify(retained.roomId)},${JSON.stringify(editable.token)},${JSON.stringify(retained.snapshotId)});
      await window.api.rooms.documents.close(${JSON.stringify(retained.roomId)},${JSON.stringify(editable.token)});
      return restored.state;
    })()`);
    const restoredDocument = new Y.Doc(); Y.applyUpdate(restoredDocument, Buffer.from(restored, 'base64'));
    assert.equal(restoredDocument.getText('text').toString(), '# Survives update'); restoredDocument.destroy();
    check('updated-packaged-crdt-worker-edits-and-restores-pre-update-snapshot');
  });
  fs.unlinkSync(shortcuts[1]);
  await execute(plan.updatedInstaller, ['/S', '/currentuser', '--updated', `/D=${plan.installDirectory}`]);
  for (const shortcut of shortcuts) assert.equal(fs.existsSync(shortcut), false, 'Updater recreated a deleted shortcut');
  check('updater-mode-keeps-deleted-desktop-and-menu-shortcuts-deleted');
  if (settingsBefore) await appSession(updatedVersion, async evaluate => {
    assert.deepEqual(await runSettingsUi(evaluate, 'restart'), settingsBefore);
    check('relaunch-retains-hotkey-profile-speed-limit-and-ranked-search');
  });
  const uninstaller = path.join(plan.installDirectory, `Uninstall ${plan.namespace}.exe`);
  assert.ok(fs.existsSync(uninstaller));
  await execute(uninstaller, ['/S', '/currentuser', `_?=${plan.installDirectory}`]);
  for (let i = 0; i < 100 && fs.existsSync(path.join(plan.installDirectory, plan.executable)); i++) await delay(100);
  assert.equal(fs.existsSync(path.join(plan.installDirectory, plan.executable)), false);
  for (const key of [privateKey, uninstallKey, ...associationKeys]) assert.equal(registry(key), null, 'Private registration survived uninstall');
  for (const shortcut of shortcuts) assert.equal(fs.existsSync(shortcut), false);
  assert.ok(fs.existsSync(path.join(profile, 'config.json'))); assert.equal(hash(payload), payloadHash);
  check('private-uninstall-removes-registrations-keeps-profile-and-download-bytes');
  if (settingsBefore) {
    const cleanEnv = seedProfile(path.join(plan.root, 'fresh-profile'), plan.instance + '-fresh');
    await execute(plan.updatedInstaller, ['/S', '/currentuser', `/D=${plan.installDirectory}`]);
    try {
      assert.equal(hash(archive), plan.packages.updated.asarSha256);
      await appSession(updatedVersion, async evaluate => {
        const fresh = await runSettingsUi(evaluate, 'fresh');
        assert.equal(fresh.profile, null);
        assert.equal(fresh.binding, null);
        assert.notEqual(fresh.limit, 731);
        check('clean-candidate-install-starts-with-fresh-settings-and-working-search');
      }, cleanEnv);
    } finally {
      await execute(uninstaller, ['/S', '/currentuser', `_?=${plan.installDirectory}`]);
    }
    for (const key of [privateKey, uninstallKey, ...associationKeys]) assert.equal(registry(key), null);
  }
  assert.deepEqual(productionKeys.map(registry), before);
  if (productionHash) assert.equal(hash(productionExe), productionHash);
  check('primary-havvn-executable-and-file-handlers-unchanged');
  report.passed = true; report.finishedAt = new Date().toISOString(); save();
  fs.copyFileSync(output, path.join(repository, 'dist/installer-acceptance-latest.json'));
  console.log(output);
})().catch(error => { report.error = String(error.stack || error); save(); console.error(error); process.exitCode = 1; });
