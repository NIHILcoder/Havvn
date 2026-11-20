// Real App/guide, DownloadsPage and RoomsPage handlers, and Chromium audio.
// Native pickers and service results are fixtures; the unrelated room dock is omitted.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-first-steps-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = { ...process.env, HAVVN_FIRST_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw Error('Unexpected temp profile');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_FIRST_SCRATCH || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing temp profile');
  const output = path.join(root, 'dist/first-steps-ui'); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('First steps deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const settings = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/styles/appearance.css',
      'renderer/components/Modal.css', 'renderer/components/FirstStepsGuide.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css',
      'renderer/components/CommandPalette.css', 'renderer/pages/DownloadsPage.css', 'renderer/pages/DownloadViewsBar.css', 'renderer/pages/RoomsPage.css',
      'renderer/components/AddDownloadsModal.css',
      'renderer/components/StreamPlayerModal.css', 'renderer/components/PlayerControls.css', 'renderer/pages/SettingsPage.css', 'renderer/pages/settings/controls.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(scratch, 'ui.html');
    fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1120, height: 820, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    const errors = [], checks = [];
    win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Renderer:', event.message); } });
    const run = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { console.error('First steps UI:', code.slice(0, 250)); throw error; }
    };
    const check = async (label, code) => {
      for (let i = 0; i < 50; i++) { if (await run(code)) { checks.push(label); console.log('PASS ' + label); return; } await new Promise(resolve => setTimeout(resolve, 60)); }
      console.error(await run('({text:document.body.innerText.slice(-1800),calls,firstRoomPicks,shareMode,progress:first.firstSteps.getSnapshot()})')); throw Error(label);
    };
    const capture = async name => {
      const [width, height] = win.getSize(); win.setSize(width + 1, height);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await win.loadFile(html);
    await run('var fixtureRoot=' + JSON.stringify(root) + ',settingsFixture=' + JSON.stringify(settings) + `,testFirstSteps=true,testSavedViews=true;
      var firstRows=[], firstRooms=[], firstRoom=null, roomObservers=new Set(), pickerResult=[], shareMode='cancel', firstCreates=0, firstJoins=0, firstPicks=0, firstRoomPicks=0;
      var fixtureApiOverrides={ getDownloads:async()=>firstRows, selectTorrentFiles:async()=>{firstPicks++;return pickerResult},
        getTorrentFiles:async()=>[{index:0,name:'sample.wav',path:'sample.wav',length:16044}],
        getEpisodePrefetchSupport:async()=>({supported:false}),
        historyPlayback:{duration:async()=>null,files:async()=>[]},
        onRoomUpdate:listener=>{roomObservers.add(listener);return()=>roomObservers.delete(listener)},
        rooms:{list:async()=>firstRooms,getProfile:async()=>({memberId:'me',name:'Me',avatarSeed:'me'}),engineStatus:async()=>({state:'ready'}),setActiveRoom:async()=>{},
          get:async id=>firstRoom?.roomId===id?firstRoom:null,
          create:async name=>{firstCreates++;firstRoom={roomId:'r1',name,code:'fixture',invite:'fixture',members:[],files:[],history:[],voice:{participants:[]},lan:{available:true,active:false}};firstRooms=[{roomId:'r1',name,memberCount:1,fileCount:0,onlineCount:1}];return firstRoom},
          join:async()=>{firstJoins++;throw Error('fixture join disabled')},
          pickAndAddFiles:async()=>{firstRoomPicks++;if(shareMode==='cancel')return null;if(shareMode==='fail')throw Error('fixture disk full');firstRoom={...firstRoom,files:[{addedBy:'me',fileId:'f1',name:'sample.txt',size:1}]};return firstRoom},
          servers:{state:async()=>({available:true,modules:[{id:'fixture',displayName:'Fixture',caps:{}}],instances:[]}),onUpdate:()=>()=>{}},
          voice:{mute:async()=>{},deafen:async()=>{}} }
      };
      ` + fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8') + `
      var first=load(path.join(fixtureRoot,'renderer/utils/first-steps.ts'));
      var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel;
      Object.assign(components, ...['Modal','Identicon','Avatar','Tabs'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      components.StreamPlayerModal=load(path.join(fixtureRoot,'renderer/components/StreamPlayerModal.tsx')).StreamPlayerModal;
      components.TorrentFileSelector=props=>React.createElement('button',{id:'confirm-fixture-download',onClick:()=>props.onConfirm([0])},'Confirm fixture selection');
      window.api.addDownload=async()=>{var row={...fixtureRows[0],id:'d1',name:'Sample',downloadedBytes:0,progress:0,status:'downloading'};firstRows=[row];return row};
      var wav=Buffer.alloc(16044);wav.write('RIFF');wav.writeUInt32LE(16036,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
      window.api.getStreamUrl=async()=>({url:'data:audio/wav;base64,'+wav.toString('base64'),kind:'audio',transcoded:false});
      function firstButton(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.offsetHeight&&node.textContent.trim()===t(key))}
      function firstPanel(){return document.querySelector('.first-panel')}
      function firstShow(){if(firstPanel().hidden)dom.flushSync(()=>document.querySelector('.first-launcher').click())}
      function firstAction(key){firstShow();var action=firstButton(key,firstPanel());if(!action)throw Error('Missing '+key+' in '+firstPanel().innerText);action.click()}
      function firstChoose(route){dom.flushSync(()=>[...document.querySelectorAll('.first-choice')].find(node=>node.textContent.includes(t('first.'+route))).click())}
      function selectFirst(key,value){dom.flushSync(()=>document.querySelector('[aria-haspopup=listbox][aria-label="'+t(key)+'"]').click());var option=[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===value);if(!option)throw Error('Missing option '+value+': '+[...document.querySelectorAll('[role=option]')].map(node=>node.textContent));dom.flushSync(()=>option.click())}
      function firstReopen(){dom.flushSync(()=>first.openFirstSteps())}
      function firstFits(scope){return !!scope&&[...scope.querySelectorAll('button')].filter(n=>n.offsetHeight).every(n=>n.scrollWidth<=n.clientWidth+1&&n.scrollHeight<=n.clientHeight+1)}
      void 0;`);
    await check('Fresh profile offers a collapsed launcher in the status bar without starting services',
      `!!document.querySelector('.status-bar-footer .first-launcher')&&firstPanel().hidden&&firstCreates===0&&firstJoins===0&&firstPicks===0&&!document.querySelector('[role=dialog]')`);
    await run(`var firstPageBounds=document.querySelector('.downloads-page').getBoundingClientRect().toJSON();firstShow();void 0`);
    await check('Chooser stores seen separately and leaves all steps incomplete', `first.firstSteps.getSnapshot().data.seen&&Object.values(first.firstSteps.getSnapshot().data.routes).every(row=>!row.prepared&&!row.done)`);
    await check('Opening the chooser leaves the workspace position and height unchanged',
      `!firstPanel().hidden&&JSON.stringify(document.querySelector('.downloads-page').getBoundingClientRect().toJSON())===JSON.stringify(firstPageBounds)&&!document.querySelector('[role=dialog]')`);
    await check('Chooser controls fit and opening moves keyboard focus to its heading', `firstFits(firstPanel())&&document.activeElement===firstPanel().querySelector('h2')`);
    await capture('chooser-dark.png');
    await run(`firstButton('first.later').click();void 0`);
    await check('Later hides the launcher and persists without a completed task', `!firstPanel()&&!document.querySelector('.first-launcher')&&JSON.parse(localStorage.getItem('havvn.first-steps.v1')).seen`);
    await run(`commandsButton().click();void 0`);
    await check('Help is available through shared palette', `!!document.querySelector('[data-command-id="open-first-steps"]')`);
    await run(`document.querySelector('[data-command-id="open-first-steps"]').click();void 0`);
    await check('Palette opens the same chooser', `!!document.querySelector('.first-chooser')`);
    await run(`firstChoose('download');void 0`);
    await check('Route opens in the lower panel and shows the first step and its action',
      `!firstPanel().hidden&&firstPanel().querySelector('[aria-current=step]').textContent.includes(t('first.download.step1'))&&firstPanel().textContent.includes(t('first.download.help1'))&&!!firstButton('btn.addTorrent',firstPanel())&&!document.querySelector('[role=dialog]')`);
    await capture('download-open.png');
    await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    await check('Escape minimizes the panel and restores focus to the launcher',
      `firstPanel().hidden&&document.activeElement===document.querySelector('.first-launcher')&&first.firstSteps.getSnapshot().data.active==='download'`);
    await capture('download-minimized.png');
    await run(`firstShow();document.querySelector('.downloads-page .page-header').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));void 0`);
    await check('Working elsewhere minimizes the panel without clearing the route',
      `firstPanel().hidden&&first.firstSteps.getSnapshot().data.active==='download'`);
    await run(`firstAction('btn.addTorrent');void 0`);
    await check('Cancelled native picker does not complete the download step', `firstPicks===1&&!first.firstSteps.getSnapshot().data.routes.download.prepared`);
    await run(`pickerResult=['fixture.torrent'];firstAction('btn.addTorrent');void 0`);
    await check('Native selection opens the download queue and the panel stays minimized', `!!document.querySelector('.add-downloads')&&firstPanel().hidden`);
    await run(`[...document.querySelectorAll('.um-foot button')].find(button=>button.textContent.trim()===t('downloads.queue.continue').replace('{count}','1')).click();void 0`);
    await check('Existing download confirmation opens', `!!document.querySelector('#confirm-fixture-download')`);
    await run(`document.querySelector('#confirm-fixture-download').click();void 0`);
    await check('Actual DownloadsPage success prepares but does not complete a zero-byte download', `first.firstSteps.getSnapshot().data.routes.download.prepared&&!first.firstSteps.getSnapshot().data.routes.download.done`);
    await run(`firstShow();void 0`);
    await check('Reopening the guide advances to the second step and its action', `!firstPanel().hidden&&firstPanel().querySelector('[aria-current=step]').textContent.includes(t('first.download.step2'))&&!!firstButton('first.showDownload',firstPanel())`);
    await run(`firstRows=[{...firstRows[0],downloadedBytes:1,progress:0.001}];model.updateDownloads(()=>firstRows);void 0`);
    await check('Receiving target data completes the download route', `first.firstSteps.getSnapshot().data.routes.download.done&&document.querySelectorAll('.first-progress [data-complete=true]').length===2`);
    await run(`[...firstPanel().querySelectorAll('header button')].find(button=>button.getAttribute('aria-label')===t('first.choose')).click();void 0`);
    await check('Panel back button returns to the route list without clearing progress', `!!firstPanel().querySelector('.first-chooser')&&first.firstSteps.getSnapshot().data.routes.download.done`);
    await run(`firstChoose('watch');void 0`);
    await run(`selectFirst('first.selectDownload','Sample');firstButton('first.openPlayer').click();void 0`);
    await check('Real player opens and Chromium playback completes watch guide', `!!document.querySelector('audio')&&document.querySelector('audio').readyState>=2&&first.firstSteps.getSnapshot().data.routes.watch.done`);
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    await check('Escape closes the player while progress stays', `!document.querySelector('audio')&&first.firstSteps.getSnapshot().data.routes.watch.done`);
    await run(`firstReopen();void 0`); await run(`firstChoose('share');void 0`);
    await run(`firstAction('rooms.join');void 0`);
    await check('Join action opens the actual confirmation without joining', `!!document.querySelector('.rooms-input-code')&&firstJoins===0`);
    await run(`document.querySelector('.um-x').click();firstAction('rooms.create');void 0`);
    await check('Create action opens actual room dialog without creating', `!!document.querySelector('.um-card')&&firstCreates===0`);
    await run(`firstButton('rooms.create',document.querySelector('.um-foot')).click();void 0`);
    await check('Confirmed room is loaded but file publication is incomplete', `firstCreates===1&&!!document.querySelector('[data-fixture-room=r1]')&&first.firstSteps.getSnapshot().data.routes.share.prepared&&!first.firstSteps.getSnapshot().data.routes.share.done`);
    await run(`document.querySelector('.um-x').click();void 0`);
    // App's normal room list refresh can lag creation; push the confirmed room.
    await run(`roomObservers.forEach(listener=>listener(firstRoom));firstShow();void 0`);
    await check('Created room becomes selectable in the guide', `!firstPanel().hidden&&firstPanel().querySelector('[aria-haspopup=listbox]')!=null`);
    await run(`selectFirst('first.selectRoom',firstRoom.name);firstButton('first.addFiles').click();void 0`);
    await check('Cancelled room file picker does not publish', `firstRoomPicks===1&&!first.firstSteps.getSnapshot().data.routes.share.done`);
    await run(`shareMode='fail';firstAction('first.addFiles');void 0`);
    await check('Failed room file operation keeps guide incomplete', `firstRoomPicks===2&&!first.firstSteps.getSnapshot().data.routes.share.done`);
    await run(`shareMode='ok';firstAction('first.addFiles');void 0`);
    await check('Actual successful local publication completes share guide', `first.firstSteps.getSnapshot().data.routes.share.done`);
    await run(`firstReopen();void 0`);
    await check('Game choice waits for the actual platform capability response', `[...document.querySelectorAll('.first-choice')].some(node=>node.textContent.includes(t('first.play'))&&!node.disabled)`);
    await run(`firstChoose('play');void 0`);
    await run(`selectFirst('first.selectRoom',firstRoom.name);void 0`);
    await check('Available server and LAN actions are offered without starting them', `!!firstButton('first.openServer')&&!!firstButton('first.openLan')&&!first.firstSteps.getSnapshot().data.routes.play.done`);
    await run(`var firstReveals=[];window.addEventListener('room-reveal-panel',event=>firstReveals.push(event.detail));firstButton('first.openServer').click();void 0`);
    await check('Server action reveals the selected room panel without completing the route', `firstReveals.some(row=>row.roomId==='r1'&&row.panel==='server')&&!first.firstSteps.getSnapshot().data.routes.play.done`);
    await run(`firstAction('first.openLan');void 0`);
    await check('LAN action reveals the selected room panel without starting a session', `firstReveals.some(row=>row.roomId==='r1'&&row.panel==='lan')&&!firstRoom.lan.active`);
    await run(`firstShow();void 0`); await capture('game-dark.png');
    win.setSize(560, 680); win.webContents.setZoomFactor(1.25);
    await run(`document.documentElement.style.setProperty('--radius-md','14px');void 0`);
    await check('Narrow enlarged guide stays readable across the viewport',
      `(() => {
        const box=firstPanel().getBoundingClientRect(), heading=firstPanel().querySelector('h2');
        const body=firstPanel().querySelector('.first-panel-body');
        return firstFits(firstPanel())&&box.width>=280&&box.left>=0&&box.right<=innerWidth&&box.bottom<=innerHeight
          &&heading.offsetHeight<=2*parseFloat(getComputedStyle(heading).fontSize)+8&&body.scrollWidth<=body.clientWidth+1;
      })()`);
    await capture('game-narrow.png');
    win.webContents.setZoomFactor(1); win.setSize(1120, 820);
    await run(`document.documentElement.style.removeProperty('--radius-md');void 0`);
    await run(`firstRoom={...firstRoom,lan:{available:true,active:true,selfVip:'10.0.0.2'}};roomObservers.forEach(listener=>listener(firstRoom));void 0`);
    await check('Actual room update with ready local LAN completes game preparation', `first.firstSteps.getSnapshot().data.routes.play.done`);
    win.setSize(560, 680);
    await run(`document.documentElement.dataset.theme='light';firstReopen();void 0`);
    await check('Narrow light chooser has no clipped labels or horizontal overflow', `firstFits(document.querySelector('.first-chooser'))&&document.querySelector('.first-chooser').scrollWidth<=document.querySelector('.first-chooser').clientWidth+1`);
    await capture('chooser-narrow-light.png');
    await run(`localStorage.setItem('startPage','rooms');localStorage.setItem('density','compact');firstButton('first.later').click();firstReopen();void 0`);
    await check('Help preserves completed routes and unrelated preferences', `Object.values(first.firstSteps.getSnapshot().data.routes).every(row=>row.done)&&localStorage.getItem('startPage')==='rooms'&&localStorage.getItem('density')==='compact'`);
    await run(`dom.flushSync(()=>firstButton('first.later').click());window.api.rooms.servers.state=async()=>({available:false,modules:[],instances:[]});window.api.rooms.get=async()=>null;firstReopen();void 0`);
    await check('Unavailable platform game actions stay disabled with an explanation', `[...document.querySelectorAll('.first-choice')].some(node=>node.disabled&&node.textContent.includes(t('first.gameUnavailable')))`);
    await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    await check('Escape closes the chooser and preserves progress', `!document.querySelector('.first-chooser')&&first.firstSteps.getSnapshot().data.routes.play.done`);
    await run(`
      cache[path.join(fixtureRoot,'renderer/pages/settings/SettingsContext.tsx')]={exports:{useSettings:()=>({appVersion:'3.2.0',runningEngine:'native',stats:{activeDownloads:0,completedDownloads:0}})}};
      components.AppStatistics=load(path.join(fixtureRoot,'renderer/components/AppStatistics.tsx')).AppStatistics;
      var About=load(path.join(fixtureRoot,'renderer/pages/settings/sections/AboutSection.tsx')).AboutSection;
      var helpRoot=document.createElement('div');document.body.append(helpRoot);var helpTree=createRoot(helpRoot);
      dom.flushSync(()=>helpTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(About))));firstButton('first.open',helpRoot).click();void 0`);
    await check('Actual About help control reopens the same saved guides', `!!document.querySelector('.first-chooser')&&Object.values(first.firstSteps.getSnapshot().data.routes).every(row=>row.done)`);
    await run(`
      var panelsKey=load(path.join(fixtureRoot,'shared/working-profile-schema.ts')).PANELS_KEY;
      localStorage.setItem(panelsKey,JSON.stringify({sidebar:true,statusBar:false}));
      window.dispatchEvent(new StorageEvent('storage',{key:panelsKey}));void 0`);
    await check('Guides remain accessible with the status bar turned off',
      `!document.querySelector('.status-bar')&&!!document.querySelector('.first-dock-floating')&&!firstPanel().hidden&&firstPanel().getBoundingClientRect().bottom<=innerHeight`);
    await run(`helpTree.unmount();helpRoot.remove();void 0`);
    assert.deepEqual(errors, []);
    await run('tree.unmount();void 0'); win.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
