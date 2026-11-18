// Actual settings page and React handlers; all OS/network writes stay in this fixture.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-settings-usability-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_SETTINGS_USABILITY: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw Error('Unexpected fixture directory');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = path.resolve(process.env.HAVVN_SETTINGS_USABILITY || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing isolated profile');
  const output = path.join(root, 'dist/settings-usability');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Settings usability deadline'); app.exit(1); }, 120000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const state = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    state.scheduler = { enabled: true, schedules: [{ id: 'night', days: [1], startTime: '22:00', endTime: '06:00', speedLimit: 100 }] };
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/styles/appearance.css',
      'renderer/pages/SettingsPage.css','renderer/pages/settings/shell.css','renderer/pages/settings/controls.css','renderer/pages/settings/SettingsNav.css','renderer/pages/settings/SpeedLimitField.css','renderer/pages/settings/EffectiveLimits.css',
      'renderer/components/Modal.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css','renderer/components/HotkeySettings.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const file = path.join(scratch, 'ui.html');
    fs.writeFileSync(file, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '#root{height:100vh}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show:false,width:1200,height:850,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false} });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer: ' + event.message); });
    await win.loadFile(file);
    const run = code => win.webContents.executeJavaScript(code), pause = (ms=75) => new Promise(resolve => setTimeout(resolve, ms));
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(state)},initialFixture=structuredClone(settingsFixture);
      var settingsCalls=[],schedulerCalls=[],holdSettings=false,settingsJobs=[],failSettings=false,failScheduler=false,failLoad=false,failSideEffect=false,osAutoLaunch=false,privacyJobs=[],holdPrivacy=false,failPrivacyLoad=false;
      var fixtureApiOverrides={
        getSettings:async()=>{if(failLoad)throw Error('Fixture load failure');return structuredClone(settingsFixture.settings);},
        getScheduler:async()=>structuredClone(settingsFixture.scheduler),
        updateSettings:async patch=>{settingsCalls.push(structuredClone(patch));if(holdSettings)await new Promise(resolve=>settingsJobs.push(resolve));if(failSettings){failSettings=false;throw Error('Fixture save failure');}Object.assign(settingsFixture.settings,patch);return structuredClone(settingsFixture.settings);},
        updateScheduler:async patch=>{schedulerCalls.push(structuredClone(patch));if(failScheduler){failScheduler=false;throw Error('Fixture scheduler failure');}Object.assign(settingsFixture.scheduler,patch);return structuredClone(settingsFixture.scheduler);},
        getAutoLaunch:async()=>osAutoLaunch,setAutoLaunch:async value=>{if(failSideEffect)throw Error('Fixture OS failure');osAutoLaunch=value;settingsFixture.settings.autoLaunch=value;},
        setWatchFolder:async(p,on,del)=>Object.assign(settingsFixture.settings,{watchFolderPath:p,watchFolderEnabled:on,watchFolderDeleteAfterAdd:del}),
        getEffectiveSettings:async()=>({...load(path.join(fixtureRoot,'shared/effective-settings.ts')).resolveEffectiveSettings(settingsFixture.settings,{scheduler:settingsFixture.scheduler}),applied:true}),
        getIpInfo:async()=>({ip:'',vpnDetected:false}),getVpnBindStatus:async()=>null,isEncryptionAvailable:async()=>true,
        getPrivacyConfig:async()=>{if(failPrivacyLoad)throw Error('Fixture privacy load failure');return structuredClone(settingsFixture.privacyConfig);},
        updatePrivacyConfig:async patch=>{if(holdPrivacy)await new Promise((resolve,reject)=>privacyJobs.push({patch,resolve,reject}));Object.assign(settingsFixture.privacyConfig,patch);return structuredClone(settingsFixture.privacyConfig);},
        getCategories:async()=>[],
        automation:{get:async()=>({config:{schema:1,revision:0,rules:[]},storage:'ready',history:[]})},
      };
      ${fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')}
      Object.assign(components,...['CategorySelect','QRCode','ThemeSelector','HotkeySettings','Identicon','Avatar','Modal','Tabs','AppStatistics'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var settingsModule=load(path.join(fixtureRoot,'renderer/pages/settings/SettingsContext.tsx')),originalSettingsHook=settingsModule.useSettings;
      settingsModule.useSettings=()=>{var value=originalSettingsHook();window.ctx=value;return value;};
      var Settings=load(path.join(fixtureRoot,'renderer/pages/SettingsPage.tsx')).default,ThemeProvider=load(path.join(fixtureRoot,'renderer/components/ThemeEditorContext.tsx')).ThemeEditorProvider;
      function mount(loadError=false){dom.flushSync(()=>tree.render(null));settingsFixture=structuredClone(initialFixture);settingsCalls=[];schedulerCalls=[];settingsJobs=[];holdSettings=false;failSettings=false;failScheduler=false;failLoad=loadError;failSideEffect=false;osAutoLaunch=false;privacyJobs=[];holdPrivacy=false;failPrivacyLoad=false;
        dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(ThemeProvider,null,React.createElement(Settings)))));}
      function btn(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
      function nav(id){dom.flushSync(()=>btn('settings.'+id,document.querySelector('.stg-nav')).click());}
      function row(key){return [...document.querySelectorAll('.stg-row')].find(node=>node.dataset.settingLabel===t(key));}
      function input(node,value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));}
      true;`);
    const checks=[],failures=[];
    const wait=async expression=>{for(let i=0;i<45;i++){if(await run(expression))return;await pause();}throw Error(expression);};
    const scenario=async(name,test)=>{try{await test();checks.push(name);console.log('PASS '+name);}catch(error){failures.push({name,error:String(error)});console.error('FAIL '+name+': '+error);}};
    const mount=async(section='general')=>{await run('mount();true;');await wait('!!document.querySelector(".stg-nav")');await run(`nav(${JSON.stringify(section)});true;`);await pause();};
    await scenario('Failed engine change retains unrelated numeric and scheduler drafts',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'777');dom.flushSync(()=>ctx.handleAddSchedule());failSettings=true;void ctx.selectEngine('webtorrent');true;`);await pause(250);
      assert.equal(await run('ctx.maxDownKbps'),777);assert.equal(await run('ctx.schedules.length'),2);assert.equal(await run('ctx.hasChanges'),true);
    });
    await scenario('Save completion preserves edits made while waiting',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'777');holdSettings=true;void ctx.handleSave();true;`);await wait('settingsJobs.length===1');
      await run(`input(row('settings.downSpeed').querySelector('input'),'888');holdSettings=false;settingsJobs.shift()();true;`);await wait('!ctx.saving');
      assert.equal(await run('settingsFixture.settings.maxDownKbps'),777);assert.equal(await run('ctx.maxDownKbps'),888);assert.equal(await run('ctx.hasChanges'),true);
    });
    await scenario('Schedule edits made during a save remain pending and Cancel restores the submitted version',async()=>{
      await mount('scheduler');await run(`dom.flushSync(()=>ctx.handleAddSchedule());holdSettings=true;dom.flushSync(()=>ctx.setMaxDownKbps(123));void ctx.handleSave();true;`);await wait('settingsJobs.length===1');
      await run('dom.flushSync(()=>ctx.handleAddSchedule());holdSettings=false;settingsJobs.shift()();true;');await wait('!ctx.saving');
      assert.equal(await run('ctx.schedules.length'),3);assert.equal(await run('ctx.schedulerConfig.schedules.length'),2);assert.equal(await run('ctx.hasChanges'),true);
      await run('dom.flushSync(()=>ctx.handleReset());true;');assert.equal(await run('ctx.schedules.length'),2);
    });
    await scenario('Repeated save clicks share one pending submission',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'777');holdSettings=true;void ctx.handleSave();void ctx.handleSave();void ctx.handleSave();true;`);await wait('settingsJobs.length===1');
      assert.equal(await run('settingsCalls.length'),1);await run('holdSettings=false;settingsJobs.shift()();true;');await wait('!ctx.saving');assert.equal(await run('settingsCalls.length'),1);
    });
    await scenario('Schedule-only save does not rewrite unrelated app settings',async()=>{
      await mount('scheduler');await run('dom.flushSync(()=>ctx.handleAddSchedule());dom.flushSync(()=>{void ctx.handleSave();});true;');await wait('!ctx.saving');
      assert.equal(await run('settingsCalls.length'),0);assert.equal(await run('settingsFixture.scheduler.schedules.length'),2);
    });
    await scenario('Retry after partial save repeats only the failed part',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'777');dom.flushSync(()=>ctx.handleAddSchedule());failScheduler=true;dom.flushSync(()=>{void ctx.handleSave();});true;`);await wait('!ctx.saving');
      assert.equal(await run('ctx.settings.maxDownKbps'),777);assert.equal(await run('ctx.schedules.length'),2);
      await run('dom.flushSync(()=>{void ctx.handleSave();});true;');await wait('!ctx.saving');assert.equal(await run('settingsCalls.length'),1);assert.equal(await run('settingsFixture.scheduler.schedules.length'),2);
    });
    await scenario('Failed OS auto-launch change does not persist a false enabled status',async()=>{
      await mount();await run(`failSideEffect=true;row('settings.autoLaunch').querySelector('[role=switch]').click();true;`);await pause(250);
      assert.equal(await run('osAutoLaunch'),false);assert.equal(await run('ctx.autoLaunch'),false);assert.equal(await run('settingsFixture.settings.autoLaunch'),false);
    });
    await scenario('Watch enable saves the chosen path and updates its baseline consistently',async()=>{
      await mount('downloads');await run(`dom.flushSync(()=>ctx.setWatchFolderPath('D:/FixtureWatch'));void ctx.applyWatchFolder(true,false);true;`);await pause(200);
      assert.equal(await run('settingsFixture.settings.watchFolderPath'),'D:/FixtureWatch');assert.equal(await run('ctx.settings.watchFolderPath'),'D:/FixtureWatch');assert.equal(await run('ctx.watchFolderEnabled'),true);assert.equal(await run('ctx.hasChanges'),false);
    });
    await scenario('Numeric field can be cleared and replaced without restoring a default mid-edit',async()=>{
      await mount('connection');await run(`input(row('settings.port').querySelector('input'),'');true;`);assert.equal(await run(`row('settings.port').querySelector('input').value`),'');
      await run(`input(row('settings.port').querySelector('input'),'51413');true;`);assert.equal(await run('ctx.portMin'),51413);
    });
    await scenario('Failed encryption change preserves drafts',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'777');failSettings=true;void ctx.selectEncryption('required');true;`);await pause(200);
      assert.equal(await run('ctx.maxDownKbps'),777);assert.equal(await run('ctx.encryption'),state.settings.encryption);
    });
    await scenario('Rapid toggle clicks persist in order and leave the last intent active',async()=>{
      await mount('connection');await run(`holdSettings=true;void ctx.applyToggle(false,ctx.setEnableDHT,{enableDHT:false});void ctx.applyToggle(true,ctx.setEnableDHT,{enableDHT:true});true;`);await wait('settingsJobs.length===1');
      await run('settingsJobs.shift()();true;');await wait('settingsJobs.length===1');await run('holdSettings=false;settingsJobs.shift()();true;');await pause(150);
      assert.equal(await run('ctx.enableDHT'),true);assert.equal(await run('settingsFixture.settings.enableDHT'),true);assert.deepEqual(await run('settingsCalls.map(p=>p.enableDHT)'),[false,true]);
    });
    await scenario('Loading failure shows a retry instead of editable default settings',async()=>{
      await run('mount(true);true;');await wait('!ctx.loading');assert.equal(await run('!!document.querySelector(".stg-nav")'),false);
      assert.equal(await run('!!document.querySelector("[role=alert]")'),true);await run(`failLoad=false;btn('common.retry').click();true;`);await wait('!!document.querySelector(".stg-nav")');
    });
    await scenario('Privacy failure rolls back one switch without reverting another saved choice',async()=>{
      await mount('privacy');await run(`holdPrivacy=true;row('privacy.vpnDetection').querySelector('[role=switch]').click();true;`);await wait('privacyJobs.length===1');
      await run(`row('privacy.clearOnExit').querySelector('[role=switch]').click();true;`);await pause();
      await run(`privacyJobs.shift().reject(Error('Fixture privacy failure'));true;`);await wait('privacyJobs.length===1');
      await run('holdPrivacy=false;privacyJobs.shift().resolve();true;');await pause(150);
      assert.equal(await run(`row('privacy.clearOnExit').querySelector('[role=switch]').getAttribute('aria-checked')`),'true');assert.equal(await run('settingsFixture.privacyConfig.clearDataOnExit'),true);
    });
    await scenario('Recommended privacy preset does not claim success when DHT save fails',async()=>{
      await mount('privacy');await run(`failSettings=true;btn('privacy.preset.apply').click();true;`);await pause(200);
      assert.equal(await run('ctx.message.type'),'error');assert.equal(await run('ctx.message.text'),await run(`t('privacy.preset.failed')`));
    });
    await scenario('Unavailable privacy configuration disables guessed values and can be retried',async()=>{
      await mount();await run(`failPrivacyLoad=true;nav('privacy');true;`);await pause(150);
      assert.equal(await run(`row('privacy.vpnDetection').querySelector('[role=switch]').disabled`),true);
      await run(`failPrivacyLoad=false;btn('common.retry').click();true;`);await pause(150);assert.equal(await run(`row('privacy.vpnDetection').querySelector('[role=switch]').disabled`),false);
    });
    await scenario('Narrow layout leaves a usable settings content area',async()=>{
      await mount('connection');win.setSize(620,780);await pause(180);
      const dimensions=await run(`({main:document.querySelector('.stg-main').getBoundingClientRect().height,top:document.querySelector('.stg-main').getBoundingClientRect().top,bottom:document.querySelector('.stg-main').getBoundingClientRect().bottom,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth})`);
      assert.ok(dimensions.main>350&&dimensions.top<dimensions.height*0.4&&dimensions.bottom<=dimensions.height+1,JSON.stringify(dimensions));assert.equal(dimensions.overflow,false);
    });
    win.setSize(1200,850);
    await scenario('Settings search jumps to the real control using Enter',async()=>{
      await mount();await run(`input(document.querySelector('.stg-nav-search input'),t('settings.port'));true;`);await pause();
      await run(`document.querySelector('.stg-nav-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;`);await pause(200);
      assert.equal(await run('ctx.activeCategory'),'connection');assert.equal(await run('!!document.querySelector("[data-settings-search-target]")'),true);
    });
    await scenario('Russian search shows the best hit first and opens the matching setting',async()=>{
      await mount();
      await run(`input(document.querySelector('.stg-nav-search input'),'уведомления');true;`);
      assert.equal(await run(`document.querySelector('.stg-nav-result > span').textContent`),await run(`t('settings.grp.notifications')`));
      await run(`input(document.querySelector('.stg-nav-search input'),'папка загрузок');true;`);
      assert.equal(await run(`document.querySelector('.stg-nav-result > span').textContent`),await run(`t('settings.defaultDir')`));
      await run(`document.querySelector('.stg-nav-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;`);
      await wait(`row('settings.defaultDir')?.hasAttribute('data-settings-search-target')`);
      assert.equal(await run('ctx.activeCategory'),'downloads');
    });
    await scenario('Settings search opens the collapsed category editor at the matching field',async()=>{
      await mount('downloads');
      assert.equal(await run(`document.querySelector('.category-editor').open`),false);
      await run(`input(document.querySelector('.stg-nav-search input'),t('category.defaults.name'));document.querySelector('.stg-nav-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;`);
      await wait(`document.querySelector('.category-editor').open&&row('category.defaults.name')?.hasAttribute('data-settings-search-target')`);
    });
    await scenario('Connection links to the single DHT control in Privacy',async()=>{
      await mount('connection');
      assert.equal(await run(`!!row('settings.dht').querySelector('[role=switch]')`),false);
      await run(`btn('settings.dht.openPrivacy').click();true;`);
      await wait(`ctx.activeCategory==='privacy'&&row('privacy.dht')?.hasAttribute('data-settings-search-target')`);
      assert.equal(await run(`!!row('privacy.dht').querySelector('[role=switch]')`),true);
    });
    await scenario('Switching settings sections starts at the top',async()=>{
      await mount('sharing');
      const before=await run(`(()=>{const pane=document.querySelector('.stg-scroll');pane.scrollTo({top:400,behavior:'instant'});return pane.scrollTop;})()`);
      assert.ok(before>0);
      await run(`nav('interface');true;`);
      assert.equal(await run(`document.querySelector('.stg-scroll').scrollTop`),0);
    });
    await scenario('Editing a hotkey focuses the recorder and returns focus to the edited action',async()=>{
      await mount('hotkeys');
      await run(`localStorage.removeItem('hotkeys');document.querySelector('.hotkey-display').click();true;`);
      await wait(`document.activeElement.classList.contains('hotkey-recorder')`);
      await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',code:'F10',bubbles:true}));true;`);
      await wait(`document.activeElement.classList.contains('hotkey-display')`);
      assert.equal(await run(`document.activeElement.querySelector('kbd').textContent`),'F10');
      assert.deepEqual(await run(`JSON.parse(localStorage.getItem('hotkeys')).find(item=>item.id==='open-command-palette').keys`),['F10']);
      await run(`localStorage.removeItem('hotkeys');true;`);
    });
    await scenario('Ctrl+S saves with the Russian keyboard layout and suppresses the browser dialog',async()=>{
      await mount('connection');await run(`input(row('settings.downSpeed').querySelector('input'),'321');true;`);await wait('ctx.hasChanges');
      assert.equal(await run(`!window.dispatchEvent(new KeyboardEvent('keydown',{key:'ы',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true}))`),true);await pause(200);
      assert.equal(await run('settingsFixture.settings.maxDownKbps'),321);assert.equal(await run('ctx.hasChanges'),false);
    });
    await scenario('Keyboard save rejects out-of-range values with an understandable field name',async()=>{
      await mount('connection');await run(`input(row('settings.port').querySelector('input'),'999999');void ctx.handleSave();true;`);await pause(100);
      assert.equal(await run('settingsCalls.length'),0);assert.equal(await run('ctx.message.type'),'error');assert.equal(await run(`ctx.message.text.includes(t('settings.port'))`),true);
      await run(`row('settings.port').querySelector('input').dispatchEvent(new FocusEvent('focusout',{bubbles:true}));true;`);await pause();assert.equal(await run('ctx.portMin'),65535);
    });
    await scenario('Unlimited explicitly sets zero in the draft and persists only on Save',async()=>{
      await mount('connection');const baseline=await run('settingsFixture.settings.maxUpKbps');
      await run(`input(row('settings.downSpeed').querySelector('input'),'512');input(row('settings.upSpeed').querySelector('input'),'96');btn('settings.limit.unlimited',row('settings.upSpeed')).click();true;`);await pause();
      assert.equal(await run('ctx.maxUpKbps'),0);assert.equal(await run('settingsFixture.settings.maxUpKbps'),baseline);
      assert.equal(await run(`row('settings.upSpeed').querySelector('.speed-limit-field-hint').textContent`),await run(`t('settings.limit.zero')`));
      await run(`btn('settings.saveChanges').click();true;`);await wait('!ctx.saving');
      assert.equal(await run('settingsFixture.settings.maxUpKbps'),0);assert.equal(await run('settingsFixture.settings.maxDownKbps'),512);
    });
    await scenario('Unlimited restores a cleared zero field without hiding the editable number',async()=>{
      await mount('connection');await run(`btn('settings.limit.unlimited',row('settings.upSpeed')).click();true;`);await pause();
      await run(`input(row('settings.upSpeed').querySelector('input'),'');btn('settings.limit.unlimited',row('settings.upSpeed')).click();true;`);await pause();
      assert.equal(await run(`row('settings.upSpeed').querySelector('input').value`),'0');
      await run(`input(row('settings.upSpeed').querySelector('input'),'2048');true;`);
      assert.equal(await run('ctx.maxUpKbps'),2048);assert.equal(await run(`row('settings.upSpeed').querySelector('input').value`),'2048');
    });
    await scenario('Alternative unlimited values preserve the normal limits',async()=>{
      await mount('connection');const baseline=await run('[settingsFixture.settings.maxDownKbps,settingsFixture.settings.maxUpKbps]');
      await run(`Object.assign(settingsFixture.settings,{altDownKbps:2048,altUpKbps:64});void ctx.loadSettings();true;`);await wait('!ctx.loading');
      await run(`btn('settings.limit.unlimited',row('settings.altDown')).click();btn('settings.limit.unlimited',row('settings.altUp')).click();true;`);await pause();
      await run(`btn('settings.saveChanges').click();true;`);await wait('!ctx.saving');
      assert.deepEqual(await run('[settingsFixture.settings.maxDownKbps,settingsFixture.settings.maxUpKbps]'),baseline);
      assert.deepEqual(await run('[settingsFixture.settings.altDownKbps,settingsFixture.settings.altUpKbps]'),[0,0]);
    });
    for(const width of [1200,620,400]) await scenario('Speed limit fields stay aligned at '+width+'px',async()=>{
      win.setSize(width,900);await mount('connection');await run(`row('settings.downSpeed').scrollIntoView({block:'start'});true;`);await pause();
      assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.speed-limit-field')].every(node=>node.getBoundingClientRect().right<=innerWidth+1)`),true);
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await pause(120);
      fs.writeFileSync(path.join(output,'speed-limits-'+width+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    });
    for(const section of ['general','downloads','connection','privacy','sharing','devices','seeding','scheduler','automation','interface','hotkeys','notifications','system','about']){
      await scenario('Actual section renders: '+section,async()=>{await mount(section);assert.equal(await run(`document.querySelector('.stg-head h1').textContent===t('settings.'+${JSON.stringify(section)})`),true);assert.equal(await run('document.querySelector(".stg-col").children.length>0'),true);});
    }
    for(const [width,height] of [[1200,900],[620,720],[400,600],[400,500]]) {
      await scenario('Many long setting changes remain bounded at '+width+'x'+height,async()=>{
        win.setSize(width,height);await mount('downloads');
        await run(`dom.flushSync(()=>{
          ctx.setDefaultDownloadDir('D:/'+('very-long-folder-name/').repeat(90)+'downloads');
          ctx.setWatchFolderPath('D:/'+('watch-folder/').repeat(120));ctx.setAutoMovePath('D:/'+('completed-folder/').repeat(100));
          for(const key of ['maxDownKbps','maxUpKbps','altDownKbps','altUpKbps','maxActiveDownloads','maxConnections','maxConnectionsGlobal','portMin','diskGuardMinFreeMB','defaultSeedRatioLimit','defaultSeedTimeLimitMinutes','proxyPort'])ctx['set'+key[0].toUpperCase()+key.slice(1)]((ctx.settings[key]||0)+17);
          ctx.setProxyHost('PRIVATE_HOST');ctx.setProxyUsername('PRIVATE_USER');ctx.setProxyPassword('PRIVATE_PASSWORD');ctx.setProxyType(ctx.proxyType==='http'?'socks5':'http');
          ctx.handleAddSchedule();ctx.setNetDraft({id:'fixture',name:'Fixture',overrides:{}});ctx.setTurnUrl('turn:fixture.invalid');ctx.setCustomTrackers('udp://fixture.invalid:1234');
        });true;`);
        await wait(`document.querySelectorAll('.stg-change-review li').length===23`);
        assert.equal(await run(`!document.querySelector('.stg-change-review').open&&document.querySelector('.stg-change-review').getBoundingClientRect().height<70`),true);
        await run(`document.querySelector('.stg-change-review').open=true;true;`);await pause(100);
        const geometry=await run(`(()=>{const review=document.querySelector('.stg-change-review'),form=document.querySelector('.stg-scroll'),save=document.querySelector('.stg-save');return {review:review.getBoundingClientRect().height,form:form.clientHeight,saveBottom:save.getBoundingClientRect().bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.equal(await run(`(()=>{const value=document.querySelector('.stg-change-value:last-child'),style=getComputedStyle(value);return value.textContent.length>1000&&value.title===value.textContent&&value.getBoundingClientRect().height<=parseFloat(style.lineHeight)*2+1;})()`),true);
        console.log('Stress geometry '+width+'x'+height+': '+JSON.stringify(geometry));
        const size=win.getSize();win.setSize(size[0]+1,size[1]);await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});win.setSize(...size);await pause(120);
        fs.writeFileSync(path.join(output,'many-changes-'+width+'x'+height+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
        assert.equal(geometry.overflow,false);assert(geometry.review<=262);assert(geometry.form>=120,'Settings viewport collapsed: '+geometry.form);assert(geometry.saveBottom<=geometry.viewport+1);
        await run(`document.querySelector('.stg-change-review-body').scrollTop=100000;document.querySelector('.stg-change-review li:last-child button:last-child').scrollIntoView({block:'nearest'});true;`);await pause();
        assert.equal(await run(`(()=>{const last=document.querySelector('.stg-change-review li:last-child button:last-child'),rect=last.getBoundingClientRect();return last.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2));})()`),true);
        await run(`document.querySelector('.stg-change-review').open=false;true;`);await pause();
        assert.equal(await run(`document.querySelector('.stg-scroll').clientHeight>=120&&!document.querySelector('.stg-change-review').textContent.includes('PRIVATE_PASSWORD')`),true);
        await run(`row('settings.defaultDir').querySelector('input').scrollIntoView({block:'center'});true;`);await pause();
        assert.equal(await run(`(()=>{const field=row('settings.defaultDir').querySelector('input'),rect=field.getBoundingClientRect();return document.elementFromPoint(rect.left+20,rect.top+rect.height/2)===field;})()`),true);
      });
    }
    for(const width of [1200,620,400]){
      await scenario('Layout and save actions stay reachable at '+width+'px',async()=>{
        await mount('downloads');win.setSize(width,780);await pause(120);await run(`input(row('settings.defaultDir').querySelector('input'),'D:/Changed');true;`);await pause();
        assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.stg-save').getBoundingClientRect().bottom<=innerHeight+1&&[...document.querySelectorAll('.stg-save button')].every(n=>n.getBoundingClientRect().right<=innerWidth+1)`),true);
        const size=win.getSize();win.setSize(size[0]+1,size[1]);await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});win.setSize(...size);await pause();fs.writeFileSync(path.join(output,'downloads-'+width+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      });
    }
    await scenario('English labels and light theme remain usable',async()=>{
      win.setSize(1100,820);await mount('connection');const darkBackground=await run(`getComputedStyle(document.querySelector('.stg-page')).backgroundColor`);
      await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');document.documentElement.dataset.theme='light';true;`);await pause(150);
      assert.equal(await run(`document.querySelector('.stg-head h1').textContent`),'Connection');assert.equal(await run(`document.querySelector('.stg-save-hint').textContent.includes('Ctrl+S')`),true);
      assert.notEqual(await run(`getComputedStyle(document.querySelector('.stg-page')).backgroundColor`),darkBackground);
      win.setSize(1101,820);await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});win.setSize(1100,820);await pause(150);
      fs.writeFileSync(path.join(output,'connection-en-light.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    });
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:!failures.length,checks,failures},null,2));
    await run('tree.unmount();true;');clearTimeout(deadline);win.destroy();app.exit(failures.length?1:0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
