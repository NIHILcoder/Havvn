// Actual React controls + App, production preload/IPC and durable settings journal.
// All windows use a disposable profile; room/engine services are local fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-working-profiles-'));
  const env = { ...process.env, HAVVN_WORKING_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1; const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-working-profiles-')) throw Error('Unexpected working-profile fixture');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = path.resolve(process.env.HAVVN_WORKING_SCRATCH || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-working-profiles-')) throw Error('Missing isolated working-profile fixture');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 90000), output = path.join(root, 'dist/working-profiles-ui');
  fs.mkdirSync(output, { recursive: true });
  app.whenReady().then(async () => {
    const compiled = path.join(root, 'dist/electron'), db = require(path.join(compiled, 'electron/db/store.js'));
    const portable = require(path.join(compiled, 'shared/interface-preferences.js'));
    const schema = require(path.join(compiled, 'shared/working-profile-schema.js'));
    const settings = db.readSettingsImportState(); let applyCalls = 0;
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/styles/appearance.css',
      'renderer/pages/DownloadsPage.css', 'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css',
      'renderer/components/CommandPalette.css', 'renderer/components/NumberInput.css', 'renderer/pages/DownloadViewsBar.css', 'renderer/layout/SidebarFavorites.css',
      'renderer/pages/settings/controls.css', 'renderer/pages/settings/shell.css', 'renderer/pages/SettingsPage.css',
      'renderer/components/ThemeSelector.css', 'renderer/components/GlassControls.css', 'renderer/pages/settings/sections/WorkingProfilesPanel.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(scratch, 'ui.html');
    fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}#profile-editor{position:fixed;inset:48px 12px 16px;z-index:150;max-width:940px;margin:auto;overflow:auto;background:var(--color-bg-primary)}</style><div id="root"></div></html>');
    const trusted = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, additionalArguments: ['--havvn-settings-recovery'], preload: path.join(compiled, 'electron/preload.js') } });
    require(path.join(compiled, 'electron/ipc/settings-transfer.js')).registerSettingsTransferIpc(() => trusted);
    ipcMain.handle('settings:get', () => db.getSettings());
    await trusted.loadFile(html);
    const win = new BrowserWindow({ show: false, width: 1180, height: 1080, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = [], checks = [];
    win.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error('Renderer:', message.message); } });
    const run = code => win.webContents.executeJavaScript(code), trustedRun = code => trusted.webContents.executeJavaScript(code);
    ipcMain.handle('fixture:settings', () => db.getSettings());
    ipcMain.handle('fixture:profile:apply', (_event, request) => { applyCalls++; return trustedRun(`window.api.applyWorkingProfile(${JSON.stringify(request)})`); });
    ipcMain.handle('fixture:profile:status', () => db.settingsTransfers.status());
    const check = async (label, predicate) => {
      for (let i = 0; i < 50; i++) { if (await predicate()) { checks.push(label); console.log('PASS ' + label); return; } await new Promise(resolve => setTimeout(resolve, 75)); }
      console.error(await run('({text:editor?.textContent.slice(-700),theme:document.documentElement.dataset.theme,view:views?.getSnapshot().catalog.activeId,panels:working?.workingProfiles.getSnapshot().panels,active:working?.workingProfiles.getSnapshot().catalog.activeId,sidebar:!!document.querySelector(".sidebar"),status:!!document.querySelector(".status-bar"),startPage:localStorage.getItem("startPage")})')); throw Error(label);
    };
    const capture = async name => {
      const [width, height] = win.getSize(); win.setSize(width + 1, height);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 180));
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await win.loadFile(html);
    await run('var fixtureRoot=' + JSON.stringify(root) + ',settingsFixture=' + JSON.stringify(settings) + `,testSavedViews=true;
      var ipc=require('electron').ipcRenderer;
      var fixtureApiOverrides={getSettings:()=>ipc.invoke('fixture:settings'),applyWorkingProfile:request=>ipc.invoke('fixture:profile:apply',request),getSettingsTransferStatus:()=>ipc.invoke('fixture:profile:status')};
      localStorage.setItem('havvn.download-views.v1',JSON.stringify({version:1,views:[{id:'v1',name:'Фильмы',pinned:true,conditions:{status:'all',name:'',path:''},sort:{by:'added',direction:'desc'},mode:'compact'}],activeId:'v1'}));
      localStorage.setItem('startPage','rooms');
      ` + fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8') + `
      var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel;
      var appSetLanguage=fixtureSetLanguage;
      fixtureRows[0]={...fixtureRows[0],status:'downloading'};model.updateDownloads(()=>fixtureRows);
      var working=load(path.join(fixtureRoot,'renderer/utils/working-profiles.ts')),views=load(path.join(fixtureRoot,'renderer/utils/download-views.ts')).downloadViews;
      var appearanceProfiles=load(path.join(fixtureRoot,'renderer/utils/appearance-profiles.ts'));
      var captureAppearance=load(path.join(fixtureRoot,'shared/appearance.ts')).DEFAULT_APPEARANCE;
      appearanceProfiles.saveAppearanceProfile({version:1,name:'Blue',appearance:{...captureAppearance,radii:{panels:12,cards:12,buttons:18,inputs:14}},theme:null,mode:'light',accent:'#3377aa',font:'inter',density:'compact',reduceMotion:true});
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/sections/WorkingProfilesPanel.tsx')).WorkingProfilesPanel;
      var Card=load(path.join(fixtureRoot,'renderer/pages/settings/controls.tsx')).SettingsCard;
      var Confirm=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      var setProfileLocked,refreshProfileSettings;
      function Screen(){var [settings,setSettings]=React.useState(settingsFixture.settings),[locked,setLocked]=React.useState(false);setProfileLocked=setLocked;
        refreshProfileSettings=()=>window.api.getSettings().then(setSettings);React.useEffect(()=>{var refresh=()=>void refreshProfileSettings();window.addEventListener(working.WORKING_PROFILE_EVENT,refresh);return()=>window.removeEventListener(working.WORKING_PROFILE_EVENT,refresh)},[]);
        React.useContext(fixtureTranslationContext);return React.createElement(Card,{title:t('working.title'),description:t('working.description'),icon:'layers'},React.createElement(Panel,{settings,locked}))}
      var editor=document.createElement('div');editor.id='profile-editor';document.body.append(editor);var editorTree=createRoot(editor);
      dom.flushSync(()=>editorTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Confirm,null,React.createElement(Screen)))));
      function button(key,scope=editor){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key))}
      function inputName(value){var field=editor.querySelector('input[aria-label="'+t('working.name')+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))}
      function openSelect(key){editor.querySelector('[aria-haspopup=listbox][aria-label="'+t(key)+'"]').click()}
      function option(text){var node=[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===text);if(!node)throw Error('Missing option '+text);node.click()}
      function toggle(key){editor.querySelector('[role=switch][aria-label="'+t(key)+'"]').click()}
      function closePreview(){button('common.cancel',document.querySelector('.working-preview')).click()}
      void 0;`);
    await check('Actual profile editor and App share one engine subscription', () => run(`!!button('working.save')&&statsSubscriptions===1`));
    await db.updateSettings({ enableSounds: false }); await run('refreshProfileSettings();void 0');
    await run(`toggle('working.sidebar');toggle('working.statusBar');void 0`);
    await check('Panel switches hide only UI while downloads and command access remain available', () => run(`!document.querySelector('.sidebar')&&!document.querySelector('.status-bar')&&!!document.querySelector('.titlebar-commands')&&model.store.getState().downloads[0].status==='downloading'&&statsSubscriptions===1`));
    await run(`inputName('Кино');void 0`); await run(`openSelect('working.appearance')`); await run(`option('Blue')`);
    await run(`button('working.save').click();void 0`);
    await check('Save captures the current set without applying it', () => run(`working.workingProfiles.getSnapshot().catalog.profiles.length===1&&document.documentElement.dataset.theme==='dark'`));
    assert.equal(applyCalls, 0);
    await run(`var profileId=working.workingProfiles.getSnapshot().catalog.profiles[0].id;localStorage.setItem('startPage','downloads');working.workingProfiles.setPanel('sidebar',true);working.workingProfiles.setPanel('statusBar',true);views.select(null);void 0`);
    await db.updateSettings({ enableSounds: true }); await run('refreshProfileSettings();void 0');
    await run(`button('working.preview').click();void 0`);
    await check('Preview lists all five changed groups without writing settings', () => run(`document.querySelectorAll('[data-working-difference]').length===5&&localStorage.getItem('startPage')==='downloads'&&!!document.querySelector('.sidebar')`));
    assert.equal((await db.getSettings()).enableSounds, true); assert.equal(applyCalls, 0);
    await capture('preview-wide.png');
    await run(`button('working.apply',document.querySelector('.working-preview')).click();button('working.apply',document.querySelector('.working-preview')).click();void 0`);
    await check('Production preload and IPC confirm the profile across both stores', async () => !(await db.getSettings()).enableSounds && await run(`working.workingProfiles.getSnapshot().catalog.activeId===profileId&&views.getSnapshot().catalog.activeId==='v1'&&!document.querySelector('.sidebar')&&!document.querySelector('.status-bar')&&document.documentElement.dataset.theme==='light'&&document.documentElement.dataset.density==='compact'&&!!document.documentElement.dataset.reduceMotion`));
    assert.equal(applyCalls, 1); assert.equal(db.settingsTransfers.status().recoveryNeeded, false);
    await check('Current profile matches and applying did not start room or transfer actions', () => run(`editor.textContent.includes(t('working.matches'))&&model.store.getState().downloads[0].status==='downloading'&&!calls.some(item=>['pauseAll','resumeAll','rooms.join','voice.join','share'].includes(item[0]))`));
    await run(`inputName('Черновик');void 0`);
    await check('Unsaved profile fields cannot silently apply the previously saved version', () => run(`button('working.preview').disabled&&button('working.previous').disabled&&editor.textContent.includes(t('working.profileDraft'))`));
    await run(`button('working.discardDraft').click();void 0`);
    await check('Discarding profile edits restores the saved fields and unlocks switching', () => run(`!button('working.preview').disabled&&editor.querySelector('input[aria-label="'+t('working.name')+'"]').value==='Кино'`));
    await run(`var allId=working.workingProfiles.save('All downloads',{...working.workingProfiles.getSnapshot().catalog.profiles[0].values,viewId:null});void 0`);
    await run(`openSelect('working.select')`); await run(`option('All downloads')`);
    await check('Selecting All downloads does not inherit the currently active saved view', () => run(`!button('working.preview').disabled&&editor.querySelector('[aria-haspopup=listbox][aria-label="'+t('working.view')+'"]').textContent.includes(t('working.noView'))`));
    await run(`openSelect('working.select')`); await run(`option('Кино')`); await run(`working.workingProfiles.remove(allId);void 0`);
    await check('An untrusted window cannot call the profile transaction directly', () => run(`ipc.invoke('settings:working-profile',{},{}).then(()=>false,error=>error.message.includes('Untrusted'))`));
    await run(`button('working.previous').click();void 0`);
    await check('Return also has a preview', () => run(`document.querySelectorAll('[data-working-difference]').length===5`));
    await run(`button('working.apply',document.querySelector('.working-preview')).click();void 0`);
    await check('Return restores the exact previous preferences while preserving the saved profile', async () => (await db.getSettings()).enableSounds && await run(`working.workingProfiles.getSnapshot().catalog.activeId===null&&working.workingProfiles.getSnapshot().catalog.profiles.length===1&&!!document.querySelector('.sidebar')&&!!document.querySelector('.status-bar')&&views.getSnapshot().catalog.activeId===null&&localStorage.getItem('startPage')==='downloads'&&document.documentElement.dataset.theme==='dark'`));
    await run(`button('working.preview').click();void 0`); await check('A new preview opens', () => run(`!!document.querySelector('.working-differences')`));
    await run(`localStorage.setItem('startPage','rooms');button('working.apply',document.querySelector('.working-preview')).click();void 0`);
    await check('Stale preview is rejected without partial writes', () => run(`editor.textContent.includes(t('working.error.stale'))&&!!document.querySelector('.sidebar')`));
    assert.equal((await db.getSettings()).enableSounds, true);
    await run(`closePreview();localStorage.setItem('startPage','downloads');setProfileLocked(true);void 0`);
    await check('Unsaved settings or an open appearance editor block profile changes', () => run(`button('working.preview').disabled&&button('working.update').disabled&&editor.textContent.includes(t('working.error.draft'))`));
    await run(`setProfileLocked(false);void 0`); await run(`button('working.preview').click();void 0`); await check('Profile can be reviewed after finishing editing', () => run(`!!document.querySelector('.working-differences')`));
    await run(`button('working.apply',document.querySelector('.working-preview')).click();void 0`);
    await check('Profile applies again', () => run(`!document.querySelector('.working-preview')&&working.workingProfiles.getSnapshot().catalog.activeId===profileId`));
    await run(`toggle('working.sidebar');void 0`);
    await check('Manual changes are labeled separately from the saved profile', () => run(`editor.textContent.includes(t('working.modified'))&&!!document.querySelector('.sidebar')`));
    const beforeDuplicate = applyCalls;
    await run(`button('working.duplicate').click();void 0`);
    await check('Duplicate copies the saved set without applying or replacing the active profile', () => run(`working.workingProfiles.getSnapshot().catalog.profiles.length===2&&working.workingProfiles.getSnapshot().catalog.activeId===profileId&&editor.querySelector('input[aria-label="'+t('working.name')+'"]').value.includes(t('working.copy'))`));
    assert.equal(applyCalls, beforeDuplicate);
    await run(`views.remove('v1');button('working.preview').click();void 0`);
    await check('A deleted view refuses application and leaves other UI usable', () => run(`editor.textContent.includes(t('working.error.missing'))&&!document.querySelector('.working-preview')`));
    await run(`openSelect('working.view')`); await run(`option(t('working.noView'))`); await run(`button('working.update').click();void 0`);
    await check('A missing view reference can be repaired by updating the selected profile', () => run(`working.workingProfiles.getSnapshot().catalog.profiles[1].values.viewId===null`));
    await run(`appearanceProfiles.removeAppearanceProfile('Blue');button('working.preview').click();void 0`);
    await check('A deleted appearance is reported instead of silently choosing another', () => run(`editor.textContent.includes(t('working.error.missing'))&&!document.querySelector('.working-preview')`));
    await run(`openSelect('working.appearance')`); await run(`option(t('working.keepAppearance'))`); await run(`button('working.update').click();void 0`);
    await check('Appearance reference can be repaired without changing the current appearance', () => run(`working.workingProfiles.getSnapshot().catalog.profiles[1].values.appearanceName===null&&document.documentElement.dataset.theme==='light'`));
    await run(`var cat=working.workingProfiles.getSnapshot().catalog;localStorage.setItem('havvn.working-profiles.v1',JSON.stringify({...cat,previous:{...cat.previous,values:{...cat.previous.values,viewId:'deleted-view'}}}));working.workingProfiles.refresh();void 0`);
    await check('An unavailable view in the return point offers an explicit repair', () => run(`!!button('working.repairPrevious')`));
    await run(`button('working.repairPrevious').click();void 0`);
    await check('Repair changes only the view in the return checkpoint', () => run(`working.workingProfiles.getSnapshot().catalog.previous.values.viewId===null&&working.workingProfiles.getSnapshot().catalog.previous.appearance.mode===cat.previous.appearance.mode`));
    await capture('wide.png'); win.setSize(520, 1100);
    await run(`editor.scrollTop=0;void 0`);
    await check('Long profile labels and buttons fit a narrow window', () => run(`editor.scrollWidth<=editor.clientWidth+1&&[...editor.querySelectorAll('.btn-label')].every(node=>node.scrollWidth<=node.clientWidth+1)`));
    await capture('narrow.png'); await run(`editor.scrollTop=editor.scrollHeight;void 0`); await capture('narrow-actions.png');
    // Verify durable recovery of a deliberately interrupted profile operation.
    const snapshot = await trustedRun(`Object.fromEntries(${JSON.stringify(portable.INTERFACE_KEYS)}.map(key=>[key,localStorage.getItem(key)]))`);
    const preferences = portable.validateInterfacePreferences({ version: 1, values: snapshot });
    const id = JSON.parse(snapshot[schema.WORKING_PROFILES_KEY]).profiles[1].id;
    const request = { id, expected: preferences, notifications: schema.readProfileNotifications(await db.getSettings()) };
    const transaction = db.settingsTransfers.planWorkingProfile(preferences, request); db.settingsTransfers.begin(transaction);
    await run(`localStorage.setItem('startPage','rooms');void 0`);
    await trustedRun('window.api.recoverSettingsTransfer()');
    const recovered = await trustedRun(`Object.fromEntries(${JSON.stringify(portable.INTERFACE_KEYS)}.map(key=>[key,localStorage.getItem(key)]))`);
    assert.deepEqual(recovered, snapshot); assert.equal(db.settingsTransfers.status().recoveryNeeded, false);
    checks.push('Production preload recovers an interrupted profile and its exact UI checkpoint');
    await run(`window.dispatchEvent(new Event('havvn:settings-transfer'));dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');void 0`);
    await check('English profile controls are translated', () => run(`editor.textContent.includes('Working profiles')&&!editor.textContent.includes('working.error.')`));
    // Exercise the actual SettingsPage/InterfaceSection wiring and controller draft guard.
    await run(`editorTree.unmount();editor.remove();dom.flushSync(()=>appSetLanguage('en'));
      var RealThemeSelector=load(path.join(fixtureRoot,'renderer/components/ThemeSelector.tsx')).ThemeSelector,fixtureSettingsContext;
      components.ThemeSelector=props=>{fixtureSettingsContext=load(path.join(fixtureRoot,'renderer/pages/settings/SettingsContext.tsx')).useSettings();return React.createElement(RealThemeSelector,props)};
      document.querySelector('[aria-label="'+t('commands.title')+'"]').click();void 0`);
    await check('Command palette still opens after hiding and restoring panels', () => run(`!!document.querySelector('[role=combobox]')`));
    await run(`dom.flushSync(()=>setQuery(t('working.title')));void 0`);
    await check('Profile settings are discoverable through the common registry', () => run(`!!document.querySelector('[data-command-id="setting:interface:working.title"]')`));
    await run(`document.querySelector('[data-command-id="setting:interface:working.title"]').click();void 0`);
    await check('Actual Interface settings receive profile controls and search focus', () => run(`!!document.querySelector('[data-settings-search-target][data-setting-label="'+t('working.title')+'"]')&&!!fixtureSettingsContext`));
    const beforeDraft = (await db.getSettings()).maxDownKbps;
    await run(`fixtureSettingsContext.setMaxDownKbps(1234);void 0`);
    await check('A real controller draft locks profile controls without saving or replacing the draft', () => run(`fixtureSettingsContext.hasChanges&&document.querySelector('[role=switch][aria-label="'+t('working.sidebar')+'"]').disabled&&fixtureSettingsContext.maxDownKbps===1234`));
    assert.equal((await db.getSettings()).maxDownKbps, beforeDraft);
    await run(`fixtureSettingsContext.handleReset();void 0`);
    await check('Cancelling the draft unlocks profile controls', () => run(`!fixtureSettingsContext.hasChanges&&!document.querySelector('[role=switch][aria-label="'+t('working.sidebar')+'"]').disabled`));
    assert.deepEqual(errors, []); await run('tree.unmount();void 0'); win.destroy(); trusted.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
