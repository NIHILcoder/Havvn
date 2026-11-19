/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron acceptance. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-resource-ui-'));
  const launch = stage => new Promise((resolve, reject) => {
    const env = { ...process.env, HAVVN_RESOURCE_UI: scratch, HAVVN_RESOURCE_STAGE: stage }; delete env.ELECTRON_RUN_AS_NODE;
    let completed = false;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { if (String(data).includes('PASS resource ' + stage + ' complete')) completed = true; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data)); child.on('error', reject);
    child.on('close', code => code === 0 && completed ? resolve() : reject(Error('Resource acceptance incomplete: ' + stage)));
  });
  const cleanup = () => {
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-resource-ui-')) throw Error('Unexpected profile path');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  (async () => { try { await launch('ui'); await launch('restart'); }
    finally { cleanup(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_RESOURCE_UI || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-resource-ui-')) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => { /* The fixture owns shutdown. */ });
  const output = path.join(root, 'artifacts/resource-mode-ui'); fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => { console.error('Resource UI deadline'); app.exit(1); }, 100000);
  app.whenReady().then(async () => {
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    const { ResourceModeController } = require(path.join(root, 'dist/electron/electron/services/resource-mode-controller.js'));
    let power = 'unknown', failSaves = false;
    const controller = new ResourceModeController({ readMode: async () => (await db.getSettings()).resourceMode ?? 'normal', writeMode: mode => db.updateSettings({ resourceMode: mode }), readPower: () => power });
    ipcMain.handle('resources:get', () => controller.refresh()); ipcMain.handle('resources:set', (_event, mode) => { if (failSaves) throw Error('Fixture save failure'); return controller.setMode(mode); });
    controller.subscribe(snapshot => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('resources:changed', snapshot); });
    await controller.refresh();
    if (process.env.HAVVN_RESOURCE_STAGE === 'restart') {
      assert.equal((await db.getSettings()).resourceMode, 'economy'); assert.equal(controller.peek().economy, true);
      console.log('PASS saved manual economy survives a new Electron process with unknown power');
      console.log('PASS resource restart complete'); clearTimeout(deadline); app.exit(0); return;
    }
    await controller.setMode('normal');
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/styles/appearance.css',
      'renderer/pages/settings/controls.css', 'renderer/pages/settings/ResourceModePanel.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css', 'renderer/components/Modal.css', 'renderer/components/EpisodePrefetchControl.css', 'renderer/pages/RoomsPage.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'ui.html'); fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '#root{max-width:900px;margin:24px auto;padding:0 20px;box-sizing:border-box}.fixture-extras{margin-top:20px}</style><div id="root"></div></html>');
    const bridge = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, preload: path.join(root, 'dist/electron/electron/preload.js') } });
    await bridge.loadFile(page); const initial = await bridge.webContents.executeJavaScript('window.api.resourceMode.get()'); assert.equal(initial.mode, 'normal'); assert.equal(initial.power, 'unknown'); bridge.destroy(); console.log('PASS production preload reads resource state through IPC');
    const win = new BrowserWindow({ show: false, width: 980, height: 980, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error(message.message); } });
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(db.readSettingsImportState())},testResourceMode=true,testFirstSteps=true;
      var ipc=require('electron').ipcRenderer,prefetchCalls=0,prefetchStops=0,imageCalls=0,previewCalls=0;
      var fixtureApiOverrides={resourceMode:{get:()=>ipc.invoke('resources:get'),set:mode=>ipc.invoke('resources:set',mode),onChanged:fn=>{var handler=(_e,value)=>fn(value);ipc.on('resources:changed',handler);return()=>ipc.removeListener('resources:changed',handler)}},
        appearance:{getAcrylic:async()=>({enabled:false,active:false,reason:'off',material:'acrylic'}),onAcrylicChanged:()=>()=>{},setAcrylic:async()=>({enabled:false,active:false,reason:'off',material:'acrylic'})},
        getTorrentFiles:async()=>{previewCalls++;return[{index:0,name:'sample.bin',path:'sample.bin',length:100,downloaded:20,priority:'normal'}]},
        getEpisodePrefetchSupport:async()=>({supported:true}),getEngineCapabilities:async()=>require(path.join(fixtureRoot,"dist/electron/shared/engine-capabilities.js")).engineCapabilities("webtorrent"),prefetchEpisode:async()=>{prefetchCalls++;return{state:'active',bytes:1024}},stopEpisodePrefetch:async()=>{prefetchStops++}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      Object.assign(components,...['Identicon','Avatar','Modal','CategorySelect'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var resources=load(path.join(fixtureRoot,'renderer/utils/resource-mode.ts')).resourceMode;
      var appearance=load(path.join(fixtureRoot,'renderer/utils/appearance.ts'));
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/ResourceModePanel.tsx')).ResourceModePanel;
      var Prefetch=load(path.join(fixtureRoot,'renderer/components/EpisodePrefetchControl.tsx')).EpisodePrefetchControl;
      var Row=load(path.join(fixtureRoot,'renderer/pages/RoomsPage.tsx')).ResourceRoomFileRow;
      var media=document.createElement('video');Object.defineProperties(media,{paused:{value:false},readyState:{value:4},currentTime:{value:100},duration:{value:200},buffered:{value:{length:1,start:()=>0,end:()=>200}}});
      var imageFile={fileId:'img',name:'photo.png',size:20,addedBy:'me',addedByName:'Me',addedAt:Date.now(),infoHash:'a'.repeat(40),category:'other'};
      var imageRoom={roomId:'r1',members:[{memberId:'me',isSelf:true,name:'Me',avatarSeed:'me',have:['img']}],transfers:{img:{haveLocally:true,phase:'ready',progress:1}},folders:[],autoFetch:true,e2e:false};
      window.api.rooms.imageUrl=async()=>{imageCalls++;return{url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}};
      localStorage.setItem('havvn.player.episodePrefetch.v1',JSON.stringify({enabled:true,allowExcluded:false,budgetMiB:32}));
      var extras=false;function renderFixture(){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(React.Fragment,null,React.createElement(Panel),extras&&React.createElement('div',{className:'fixture-extras'},React.createElement(Prefetch,{media,downloadId:'one',currentFile:0,nextFile:1}),React.createElement(Row,{file:imageFile,room:imageRoom,onWatch:()=>{},onAssignFile:()=>{},viewPrefs:{showReactions:false}}))))))};
      renderFixture();var stopEffects=load(path.join(fixtureRoot,'renderer/utils/resource-effects.ts')).bootResourceEffects();
      void 0;`);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms ?? 80));
    const check = async (label, code) => { for (let i = 0; i < 75; i++) { if (await run(code)) { console.log('PASS ' + label); return; } await pause(); } throw Error(label); };
    const choose = async mode => {
      await run(`document.querySelector('[aria-label="'+t('resources.mode')+'"]').click();void 0`);
      await check('Mode selector opens', `!!document.querySelector('[role=option]')`);
      await run(`Array.from(document.querySelectorAll('[role=option]')).find(node=>node.textContent.trim()===t('resources.${mode}')).click();void 0`); await pause();
    };
    const capture = async name => { const [w,h]=win.getSize(); win.setSize(w+1,h); await pause(); await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); win.setSize(w,h); await pause(); fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); };
    await check('Resource control loads', `resources.getSnapshot().status==='ready'`);
    failSaves = true; await choose('economy');
    await check('A failed save is explained and the actual mode is read back', `document.querySelector('[role=alert]')?.textContent===t('resources.saveError')&&resources.getSnapshot().snapshot.mode==='normal'`);
    failSaves = false;
    await run(`appearance.saveAppearance({...appearance.readAppearance(),material:'liquid',quality:'full',motion:true,blur:28});void 0`);
    const savedAppearance = await run(`localStorage.getItem('havvn.appearance.v1')`);
    await choose('economy'); await check('Manual economy applies light glass and suppresses motion', `document.documentElement.dataset.resourceMode==='economy'&&document.documentElement.dataset.glassQuality==='light'&&document.documentElement.dataset.glassMotion==='off'`);
    assert.equal(await run(`localStorage.getItem('havvn.appearance.v1')`), savedAppearance); console.log('PASS temporary effects do not overwrite saved appearance');
    await run(`appearance.saveAppearance({...appearance.readAppearance(),blur:12,motion:false});void 0`); await choose('normal');
    await check('Leaving economy uses the latest edited preference', `document.documentElement.dataset.glassQuality==='full'&&document.documentElement.dataset.glassMotion==='off'&&document.documentElement.style.getPropertyValue('--ap-blur')==='12px'`);
    await choose('auto'); power='battery'; controller.receivePower(power);
    await check('Long automatic mode label remains fully visible', `(()=>{var node=document.querySelector('.custom-select-value');return !!node&&node.scrollWidth<=node.clientWidth+1})()`);
    await check('Battery event activates automatic economy', `resources.getSnapshot().snapshot.economy&&document.body.innerText.includes(t('resources.battery'))`);
    await choose('normal'); power='ac'; controller.receivePower(power);
    await check('Manual normal remains selected through a power change', `resources.getSnapshot().snapshot.mode==='normal'&&!resources.getSnapshot().snapshot.economy`);
    power='unknown'; await choose('auto'); await check('Unknown power is shown without claiming battery or AC', `document.body.innerText.includes(t('resources.autoUnknown'))&&!resources.getSnapshot().snapshot.economy`);
    await choose('economy'); await capture('wide-dark-ru.png'); win.setSize(520,1100); await pause();
    await check('Russian mode controls fit a narrow window', `document.documentElement.scrollWidth<=innerWidth`); await capture('narrow-dark-ru.png');
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');document.documentElement.dataset.theme='light';void 0`); win.webContents.setZoomFactor(1.25); win.setSize(520,1300); await pause();
    await check('English mode controls fit at 125 percent zoom', `document.body.innerText.includes('Resources and power')&&document.documentElement.scrollWidth<=innerWidth`); await capture('narrow-light-en-125.png');
    await run(`extras=true;renderFixture();void 0`); await pause(300);
    assert.equal(await run('prefetchCalls'),0); assert.equal(await run('imageCalls'),0); console.log('PASS economy skips optional prefetch and automatic image URLs');
    await run(`document.querySelector('.room-file').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));void 0`);
    await check('Explicit image opening still works in economy', `!!document.querySelector('.room-lightbox-img')`);
    await run(`document.querySelector('.room-lightbox-close').click();void 0`); await choose('normal');
    await check('Saved prefetch resumes only when eligible and normal mode is restored', `prefetchCalls>0&&imageCalls>0`);
    const beforeStops = await run('prefetchStops'), beforeCalls = await run('prefetchCalls'); await choose('economy'); await pause(1150);
    assert.equal(await run('prefetchCalls'),beforeCalls); assert((await run('prefetchStops'))>beforeStops);
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.player.episodePrefetch.v1')).enabled`),true); assert.equal(await run('media.paused'),false); console.log('PASS economy stops optional leases while preserving playback and player preferences');
    await run(`document.querySelector('[role=switch][aria-label="'+t('player.prefetch.enable')+'"]').click();void 0`);
    await check('Prefetch preferences can be edited while economy is active', `JSON.parse(localStorage.getItem('havvn.player.episodePrefetch.v1')).enabled===false`);
    await controller.setMode('normal'); await pause(1150); assert.equal(await run('prefetchCalls'),beforeCalls); console.log('PASS leaving economy respects a new user opt-out');
    await controller.setMode('economy');
    await run(`var Preview=load(path.join(fixtureRoot,'renderer/components/FilePreview.tsx')).FilePreview;dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Preview,{downloadId:'one',onClose:()=>{}}))));void 0`);
    await check('File details load immediately in economy', `previewCalls===1`); await pause(1200); assert.equal(await run('previewCalls'),1); console.log('PASS economy avoids the one-second file-preview polling loop');
    await controller.setMode('normal'); await pause(1300); assert((await run('previewCalls'))>=3); console.log('PASS leaving economy restores normal file-preview cadence');
    await controller.setMode('economy');
    await run(`dom.flushSync(()=>tree.render(null));stopEffects();void 0`); assert.deepEqual(errors,[]);
    console.log('PASS resource ui complete'); win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),stack:error.stack},null,2)); clearTimeout(deadline); app.exit(1); });
}
