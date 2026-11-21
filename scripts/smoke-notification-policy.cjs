// Isolated real settings/room/event stores, policy batching, production preload and actual React settings.
// OS popups and audio are captured at the delivery boundary; no desktop notification or sound is emitted.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-notifications-'));
  const env = { ...process.env, HAVVN_NOTIFICATION_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-notifications-')) throw Error('Unexpected notification fixture');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_NOTIFICATION_SCRATCH || ''), output = path.join(root, 'dist/notification-policy');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-notifications-')) throw Error('Missing isolated notification profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Notification smoke deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true }); const compiled = path.join(root, 'dist/electron');
    const db = require(path.join(compiled, 'electron/db/store.js'));
    const { DEFAULT_NOTIFICATION_POLICY } = require(path.join(compiled, 'shared/notification-policy.js'));
    const { NotificationCenter } = require(path.join(compiled, 'electron/services/notification-center.js'));
    const { getAppEvents } = require(path.join(compiled, 'electron/services/app-events.js'));
    const { AppEventSources } = require(path.join(compiled, 'electron/services/app-event-sources.js'));
    const { t } = require(path.join(compiled, 'electron/i18n/index.js'));
    const policy = () => ({ ...structuredClone(DEFAULT_NOTIFICATION_POLICY), summaries: { enabled: false, windowSeconds: 2 } });
    let clock = new Date(2026, 9, 23, 12), sounds = 0, seq = 0;
    const popups = [], checks = [], pass = label => { checks.push(label); console.log('PASS ' + label); };
    const center = new NotificationCenter({ read: async context => db.readNotificationEnvironments([context])[0], readMany: async contexts => db.readNotificationEnvironments(contexts),
      popup: message => popups.push(message), sound: () => sounds++, privateMessage: () => ({ title: t('notify.private.title'), body: t('notify.private.body') }),
      summary: (kind, count) => ({ title: t('notify.summary.' + kind), body: t('notify.summary.body', { count }) }) }, () => clock);
    const notice = context => ({ title: 'PRIVATE TITLE', body: 'PRIVATE BODY', context });
    const record = category => db.createDownload({ name: 'PRIVATE download ' + (++seq), sourceType: 'magnet', sourceUri: 'magnet:PRIVATE' + seq, savePath: scratch, status: 'error', category });
    await db.updateSettings({ enableNotifications: false, enableSounds: false, notificationPolicy: policy() });
    const failed = await record(null), history = getAppEvents(), sources = new AppEventSources(history);
    sources.download({ id: failed.id, status: 'error', lastError: 'EACCES PRIVATE_PATH' });
    await center.notify(notice({ kind: 'download-error', downloadId: failed.id }));
    assert.equal(popups.length, 0); assert.equal(sounds, 0); assert(history.isActive('download-error', { kind: 'download', id: failed.id }));
    pass('Muted output keeps the active download problem in the real encrypted event store');
    await db.updateSettings({ enableNotifications: true, notificationPolicy: { ...policy(), showContent: false } });
    await center.notify(notice({ kind: 'download-error', downloadId: failed.id }));
    assert.equal(popups.length, 1); assert(!JSON.stringify(popups).includes('PRIVATE'));
    assert(!fs.readFileSync(path.join(scratch, 'profile/events.json'), 'utf8').includes(failed.id));
    pass('Hidden native title/body contain no object names and event storage remains protected');
    await db.updateSettings({ enableNotifications: false, enableSounds: true });
    await center.notify(notice({ kind: 'download-error', downloadId: failed.id })); assert.equal(popups.length, 1); assert.equal(sounds, 1);
    pass('Sound can be enabled without a system popup');
    await db.updateSettings({ enableNotifications: true, notificationPolicy: policy() });
    const a = await db.addCategory({ name: 'Category A', icon: 'folder', color: '#ffffff', notificationRule: { popups: false, sound: false } });
    const b = await db.addCategory({ name: 'Category B', icon: 'folder', color: '#ffffff' });
    const da = await record(a.id), dbb = await record(b.id); const beforeCategory = popups.length;
    await center.notify(notice({ kind: 'download-error', downloadId: da.id })); await center.notify(notice({ kind: 'download-error', downloadId: dbb.id }));
    assert.equal(popups.length, beforeCategory + 1); pass('A category rule leaves neighboring categories unaffected');
    for (const id of ['room-a', 'room-b']) db.savePersistedRoom({ roomId: id, name: id === 'room-a' ? 'Room A' : 'Room B', code: 'PRIVATE_ROOM_CODE_' + id, folder: path.join(scratch, id), createdAt: 1 });
    db.setRoomNotificationRule('room-a', { popups: false, sound: false }, 'all');
    const beforeRoom = popups.length;
    await center.notify(notice({ kind: 'room-message', roomId: 'room-a' })); await center.notify(notice({ kind: 'room-message', roomId: 'room-b' }));
    assert.equal(popups.length, beforeRoom + 1); pass('A local room rule leaves a neighboring room unaffected');
    db.setRoomNotificationRule('room-b', {}, 'mentions');
    await center.notify(notice({ kind: 'room-message', roomId: 'room-b' })); assert.equal(popups.length, beforeRoom + 1);
    await center.notify(notice({ kind: 'room-message', roomId: 'room-b', urgent: true })); assert.equal(popups.length, beforeRoom + 2);
    db.setRoomNotificationRule('room-b', {}, 'off'); await center.notify(notice({ kind: 'room-message', roomId: 'room-b', urgent: true })); assert.equal(popups.length, beforeRoom + 2);
    pass('Mention-only mode works and urgent mentions cannot bypass a room mute');
    const quiet = policy(); quiet.quietHours.enabled = true; await db.updateSettings({ notificationPolicy: quiet }); clock = new Date(2026, 9, 23, 23);
    const beforeQuiet = popups.length; await center.notify(notice({ kind: 'system' })); clock = new Date(2026, 9, 24, 12);
    assert.equal(popups.length, beforeQuiet); pass('Local quiet hours suppress output without replay after the clock changes');
    const grouped = policy(); grouped.summaries.enabled = true; await db.updateSettings({ notificationPolicy: grouped });
    const beforeSummary = popups.length, beforeSounds = sounds;
    for (let n = 0; n < 3; n++) {
      const d = await record(b.id); await db.updateDownloadStatus(d.id, 'completed'); sources.complete(d.id);
      await center.notify(notice({ kind: 'download-complete', downloadId: d.id }));
    }
    await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(popups.length, beforeSummary + 1); assert(popups.at(-1).body.includes('3')); assert.equal(sounds, beforeSounds + 1);
    assert.equal(history.list().items.filter(item => item.code === 'download-complete').length, 3);
    pass('A completion burst delivers one counted summary and keeps each history event');
    await center.notify(notice({ kind: 'system', group: 'privacy-change' }));
    await db.updateSettings({ notificationPolicy: { ...grouped, showContent: false } });
    await new Promise(resolve => setTimeout(resolve, 2200)); assert(!JSON.stringify(popups.at(-1)).includes('PRIVATE'));
    pass('A policy change during the grouping window redacts the queued notification');
    const bad = structuredClone((await db.getSettings()).notificationPolicy);
    await assert.rejects(db.updateSettings({ notificationPolicy: { showContent: 'invalid' } }), /Invalid notification/);
    assert.deepEqual((await db.getSettings()).notificationPolicy, bad);
    const portable = require(path.join(compiled, 'shared/settings-transfer.js')).createSettingsExport(db.readSettingsImportState());
    assert(portable.settings.notificationPolicy); assert(portable.categories.find(c => c.id === a.id).notificationRule); assert(!JSON.stringify(portable).includes('PRIVATE_ROOM_CODE'));
    pass('Rules validate before storage; transfer includes category/global policy and excludes rooms'); center.dispose();

    let window; const { registerNotificationRulesIpc } = require(path.join(compiled, 'electron/ipc/notification-rules.js'));
    registerNotificationRulesIpc(() => window, async (id, rule, mode) => { db.setRoomNotificationRule(id, rule, mode); return { ok: true }; });
    const ipcPage = path.join(scratch, 'ipc.html'); fs.writeFileSync(ipcPage, '<!doctype html><body>Notification preload fixture</body>');
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(compiled, 'electron/preload.js') } });
    await window.loadFile(ipcPage); let run = code => window.webContents.executeJavaScript(code);
    assert((await run(`window.api.rooms.setNotificationRule('room-a',{showContent:false},'mentions')`)).ok);
    assert.equal(db.getPersistedRoom('room-a').notifyMode, 'mentions'); assert.equal(db.getPersistedRoom('room-b').notifyMode, 'off');
    await run(`window.soundSignals=0;window.offSound=window.api.onNotificationSound(()=>window.soundSignals++);true;`);
    window.webContents.send('app:notificationSound'); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await run('soundSignals'), 1);
    await run('offSound();true;'); window.destroy(); pass('Production preload saves a local rule through trusted IPC and carries content-free sound signals');

    await db.updateSettings({ notificationPolicy: policy(), enableNotifications: true, enableSounds: true });
    const fixture = db.readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/settings/controls.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css',
      'renderer/components/NumberInput.css', 'renderer/components/DownloadDefaultsPreview.css', 'renderer/pages/settings/sections/NotificationPolicyPanel.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const changed = () => window.webContents.send('fixture:categories');
    ipcMain.handle('fixture:getCategories', () => db.getCategories());
    ipcMain.handle('fixture:updateCategory', async (_event, id, rule) => { const result = await db.updateCategory(id, rule); changed(); return result; });
    ipcMain.handle('fixture:updateSettings', (_event, patch) => db.updateSettings(patch));
    ipcMain.handle('fixture:rooms', () => db.getPersistedRooms().map(room => ({ roomId: room.roomId, name: room.name, notificationRule: room.notificationRule, notifyMode: room.notifyMode, notifyMuted: room.notifyMuted })));
    const page = path.join(scratch, 'ui.html'); fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{max-width:960px;margin:16px auto;padding:0 16px;height:calc(100vh - 32px);overflow:auto;box-sizing:border-box}</style><div id="root"></div></html>');
    window = new BrowserWindow({ show: false, width: 1060, height: 1100, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; window.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error('Renderer:', message.message); } });
    await window.loadFile(page); run = code => window.webContents.executeJavaScript(code);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(fixture)},testSavedViews=true,testCategoryDefaults=true;
      var ipc=require('electron').ipcRenderer,fixtureApiOverrides={getCategories:()=>ipc.invoke('fixture:getCategories'),updateCategory:(id,c)=>ipc.invoke('fixture:updateCategory',id,c),updateSettings:patch=>ipc.invoke('fixture:updateSettings',patch),
        onCategoriesChanged:fn=>{var listener=()=>fn();ipc.on('fixture:categories',listener);return()=>ipc.removeListener('fixture:categories',listener)}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      window.api.rooms={...window.api.rooms,list:()=>ipc.invoke('fixture:rooms'),setNotificationRule:(id,rule,mode)=>ipc.invoke('rooms:setNotificationRule',id,rule,mode)};
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/sections/NotificationPolicyPanel.tsx')).NotificationPolicyPanel;
      function Screen(){var [settings,setSettings]=React.useState(settingsFixture.settings);return React.createElement(Panel,{settings,onSaved:setSettings})}
      dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Screen))));
      function button(key){return [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
      function toggle(key){document.querySelector('[role=switch][aria-label="'+t(key)+'"]').click();}
      function openSelect(key){document.querySelector('[aria-haspopup=listbox][aria-label="'+t(key)+'"]').click();}
      function option(text){[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===text).click();}
      function inputTime(key,value){var field=document.querySelector('input[aria-label="'+t(key)+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));}
      true;`);
    const check = async (label, predicate) => {
      for (let n = 0; n < 80; n++) { if (await predicate()) { pass(label); return; } await new Promise(resolve => setTimeout(resolve, 70)); }
      console.error(await run('document.body.innerText')); throw Error(label);
    };
    await check('Actual settings panel renders separate popup/sound/content preview', () => run(`!!document.querySelector('[data-notification-popup]')&&!!document.querySelector('[role=switch][aria-label="'+t('notifications.showContent')+'"]')`));
    await check('Both preview actions focus the draft preview', () => run(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === t('notifications.openPreview'));
      return buttons.length === 2 && buttons.every(button => {
        button.click();
        const preview = document.getElementById(button.getAttribute('aria-controls'));
        return preview === document.activeElement && !!preview.querySelector('.notification-preview');
      });
    })()`));
    await run(`toggle('notifications.showContent')`);
    await check('Privacy draft removes sample content from the preview', () => run(`document.querySelector('[data-notification-content]').dataset.notificationContent==='false'&&document.querySelector('.notification-preview').textContent.includes(t('notifications.privateBody'))`));
    await run(`button('notifications.savePolicy').click()`);
    await check('Global policy saves through the real store', async () => (await db.getSettings()).notificationPolicy.showContent === false);
    await check('Saved policy has a confirmed UI result', () => run(`document.body.textContent.includes(t('notifications.policySaved'))`));
    await run(`dom.flushSync(()=>toggle('notifications.quiet'));true;`);
    await run(`dom.flushSync(()=>inputTime('notifications.from','00:00'));true;`);
    await run(`dom.flushSync(()=>inputTime('notifications.to','00:00'));true;`);
    await check('An all-day quiet interval suppresses both outputs in the preview', () => run(`document.querySelector('[data-notification-popup]').dataset.notificationPopup==='false'&&document.querySelector('[data-notification-sound]').dataset.notificationSound==='false'`));
    await run(`toggle('notifications.quiet')`);
    await run(`openSelect('notifications.scope')`); await run(`option(t('notifications.scope.category'))`);
    await run(`openSelect('notifications.target')`); await run(`option('Category B')`);
    await run(`openSelect('notifications.rule.sound')`); await run(`option(t('common.no'))`);
    await run(`button('notifications.saveRule').click()`);
    await check('Category sound rule saves without changing its neighbor', async () => (await db.getCategories()).find(c => c.id === b.id).notificationRule?.sound === false && (await db.getCategories()).find(c => c.id === a.id).notificationRule?.popups === false);
    await run(`openSelect('notifications.scope')`); await run(`option(t('notifications.scope.room'))`);
    await run(`openSelect('notifications.target')`); await run(`option('Room B')`);
    await run(`openSelect('notifications.roomMode')`); await run(`option(t('notifications.roomMode.all'))`);
    await run(`openSelect('notifications.rule.popups')`); await run(`option(t('common.no'))`);
    await run(`button('notifications.saveRule').click()`);
    await check('Room rule and mode save together through production IPC', async () => db.getPersistedRoom('room-b').notificationRule?.popups === false && db.getPersistedRoom('room-b').notifyMode === 'all');
    await check('Saving a rule does not claim that an unrelated policy draft was saved', () => run(`document.body.textContent.includes(t('notifications.ruleSaved'))&&document.body.textContent.includes(t('notifications.unsavedPolicy'))`));
    const capture = async name => {
      const [width, height] = window.getSize(); window.setSize(width + 1, height);
      await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); window.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await capture('wide.png'); window.setSize(520, 1100);
    await check('Notification settings fit a narrow window', () => run('document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById("root").scrollWidth<=document.getElementById("root").clientWidth+1')); await capture('narrow.png');
    await run('var scrollRoot=document.getElementById("root");scrollRoot.scrollTop=scrollRoot.scrollHeight;true;');
    await check('Rules and preview remain reachable by scrolling the narrow settings panel', () => run('document.getElementById("root").scrollTop>0&&document.querySelector(".notification-preview").getBoundingClientRect().bottom<=innerHeight'));
    await capture('narrow-preview.png');
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');true;`);
    await check('English policy labels render without raw translation keys', () => run(`document.body.textContent.includes('Quiet hours and privacy')&&!document.body.textContent.includes('notifications.reason.')`));
    assert.deepEqual(errors, []); await run('tree.unmount();true;'); window.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
