/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron acceptance. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-visibility-'));
  const env={...process.env,HAVVN_VISIBILITY_UI:scratch};delete env.ELECTRON_RUN_AS_NODE;
  let completed=false;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{if(String(data).includes('PASS visibility complete'))completed=true;process.stdout.write(data)});
  child.stderr.on('data',data=>process.stderr.write(data));
  child.on('error',error=>{console.error(error);process.exitCode=1});
  child.on('close',code=>{
    if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-visibility-'))throw Error('Unexpected profile');
    fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    if(code!==0||!completed)process.exitCode=1;
  });
}else{
  const {app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_VISIBILITY_UI||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-visibility-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();
  // Keep native minimize semantics, but another desktop window covering the
  // fixture must not silently change visibility halfway through an assertion.
  app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.on('window-all-closed',()=>{});
  const deadline=setTimeout(()=>{console.error('Visibility acceptance deadline');app.exit(1)},100000);
  app.whenReady().then(async()=>{
    const settings=require(path.join(root,'dist/electron/electron/db/store.js')).readSettingsImportState();
    // Local, silent 30s PCM fixture. Media decoding/playback is real; no network.
    const wav=Buffer.alloc(44+8000*2*30);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
    const wave='data:audio/wav;base64,'+wav.toString('base64');
    const html=path.join(scratch,'ui.html');fs.writeFileSync(html,'<html><meta charset="utf-8"><div id="root"></div></html>');
    const win=new BrowserWindow({show:true,width:1000,height:800,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:true,width:800,height:600,webPreferences:{backgroundThrottling:true}}}));
    const errors=[],checks=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run=code=>win.webContents.executeJavaScript(code);
    const until=async code=>{const end=Date.now()+10000;while(!await run(code)){if(Date.now()>end){console.error(await run('JSON.stringify({visibility:document.visibilityState,health:typeof healthCalls!=="undefined"&&healthCalls,docs:typeof documentCalls!=="undefined"&&documentCalls,sync:typeof syncCalls!=="undefined"&&syncCalls,before:typeof before!=="undefined"&&before,body:document.body.innerText.slice(0,600)})'));throw Error('UI deadline: '+code)}await wait(30)}};
    const check=async(code,label)=>{assert(await run(code),label);checks.push(label);console.log('PASS '+label)};
    await win.loadFile(html);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},reads=0,previewCalls={},healthCalls=0,documentCalls=0,syncCalls=0,streamStops=0;
      var fixtureApiOverrides={getDownloads:async()=>{reads++;return structuredClone(fixtureRows)},
        resourceMode:{get:async()=>({mode:'normal',power:'unknown',economy:false,revision:1}),onChanged:()=>()=>{}},
        getTorrentFiles:async id=>{previewCalls[id]=(previewCalls[id]||0)+1;return[{index:0,name:'sample.wav',path:'sample.wav',length:480000,downloaded:480000,priority:'normal'}]},
        getStreamUrl:async()=>({url:${JSON.stringify(wave)},kind:'audio',transcoded:false}),stopStream:async()=>{streamStops++},audioTracks:{list:async()=>[]},subtitles:{list:async()=>[],get:async()=>null},historyPlayback:{duration:async()=>30}};
      ${fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')}
      var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel;
      var visibility=load(path.join(fixtureRoot,'renderer/utils/visible-work.tsx'));
      var hostWindows=load(path.join(fixtureRoot,'renderer/utils/hostWindow.tsx'));
      var DockZone=load(path.join(fixtureRoot,'renderer/pages/rooms/dock/DockZone.tsx')).DockZone;
      var FilePreview=load(path.join(fixtureRoot,'renderer/components/FilePreview.tsx')).FilePreview;
      var Health=load(path.join(fixtureRoot,'renderer/pages/rooms/ServerHealthPanel.tsx')).ServerHealthPanel;
      var Documents=load(path.join(fixtureRoot,'renderer/pages/rooms/RoomDocuments.tsx')).RoomDocuments;
      var Folders=load(path.join(fixtureRoot,'renderer/pages/rooms/RoomSyncFolders.tsx')).RoomSyncFolders;
      var Player=load(path.join(fixtureRoot,'renderer/components/StreamPlayerModal.tsx')).StreamPlayerModal;
      window.api.rooms.servers={health:async()=>{healthCalls++;return{history:[],current:{at:Date.now(),cpuPercent:1,rssBytes:1024}}}};
      window.api.rooms.documents={view:async()=>{documentCalls++;return{enabled:true,items:[]}}};
      window.api.rooms.fileSync={state:async()=>{syncCalls++;return{enabled:true,roots:[]}}};
      var instance={instanceId:'srv',status:'running',moduleId:'other'},activeTab='health',hideZone=false;
      function emitProgress(value,status='downloading'){statsReceiver(fixtureRows.map(d=>({...d,progress:value,status,downloadedBytes:value*1000})));}
      void 0;
    `);
    await until('model.store.getState().loaded&&statsSubscriptions===1');await run('emitProgress(.2)');
    await until('model.store.getState().statsById.values().next().value?.progress===.2');
    await check("model.store.getState().statsById.size>0",'foreground statistics are live');
    win.minimize();await until("document.visibilityState==='hidden'");await wait(100);
    await run('var readsBefore=reads;emitProgress(.7)');await wait(5300);
    await check("reads===readsBefore&&model.store.getState().statsById.values().next().value.progress===.2&&statsSubscriptions===1",'native minimize pauses metadata and counters, retains one critical subscription');
    await run("emitProgress(.7,'paused')");await check("model.store.getState().counts.paused===fixtureRows.length",'pause is delivered while minimized');
    await run('emitProgress(.8)');win.restore();win.show();await until("document.visibilityState==='visible'&&reads>readsBefore");
    await check("model.store.getState().statsById.values().next().value.progress===.8&&statsSubscriptions===1",'restore immediately shows latest counters and obtains fresh metadata');
    // Preserve the model while replacing unrelated shell surfaces with actual panels.
    await run(`var releaseModel=model.retain();function renderPanels(){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,
      React.createElement(DockZone,{zoneId:'left',panels:[{id:'health',label:'Health',keepAlive:true},{id:'other',label:'Other'}],activeId:activeTab,hidden:hideZone,onSelect:id=>{activeTab=id;renderPanels()},renderPanel:id=>id==='health'?React.createElement(React.Fragment,null,React.createElement(Health,{instance,roomId:'r1'}),React.createElement(Documents,{roomId:'r1'}),React.createElement(Folders,{roomId:'r1'})):React.createElement('span',null,'Other')}))))};renderPanels();`);
    await until('healthCalls>0&&documentCalls>0&&syncCalls>0');
    await run("var keepNode=document.querySelector('.server-health');activeTab='other';renderPanels();var before=[healthCalls,documentCalls,syncCalls];");await wait(5300);
    await check('JSON.stringify(before)===JSON.stringify([healthCalls,documentCalls,syncCalls])&&keepNode.isConnected','inactive keep-alive tab retains DOM and stops health/documents/folder polling');
    await run("activeTab='health';renderPanels()");await until('healthCalls>before[0]&&documentCalls>before[1]&&syncCalls>before[2]');
    await check("keepNode===document.querySelector('.server-health')",'tab activation refreshes panels without remounting');
    await run('hideZone=true;renderPanels();before=[healthCalls,documentCalls,syncCalls]');await wait(5300);
    await check('JSON.stringify(before)===JSON.stringify([healthCalls,documentCalls,syncCalls])','stage-hidden zone also suspends read-only polling');
    await run(`var Mounts=load(path.join(fixtureRoot,'renderer/pages/rooms/dock/DockPanelMounts.tsx')).DockPanelMounts;
      var dockRegistry=load(path.join(fixtureRoot,'renderer/pages/rooms/dock/dockMountRegistry.ts')).createDockMountRegistry({createElement:()=>document.createElement('div')});
      var dockSlot=document.createElement('div');document.body.append(dockSlot);dockRegistry.slotRef('health')(dockSlot);
      var hoistActive=true,hoistParked=false;
      function renderHoisted(){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Mounts,{live:[{panel:'health',zoneId:'left',parked:hoistParked}],registry:dockRegistry,realmOf:()=>null,toasterIdOf:()=>undefined,activeOf:()=>hoistActive,renderPanel:()=>React.createElement(Health,{instance,roomId:'r1'})}))))};renderHoisted();void 0;`);
    await run("var hoistedNode=dockSlot.querySelector('.server-health');hoistActive=false;renderHoisted();var hoistBefore=healthCalls");await wait(5300);
    await check('healthCalls===hoistBefore&&hoistedNode.isConnected','hoisted inactive panel suspends polling without losing its DOM');
    await run('hoistActive=true;hoistParked=true;renderHoisted()');await wait(100);
    await check('healthCalls===hoistBefore&&!hoistedNode.isConnected','parked dock panel stays mounted with polling suspended');
    await run('hoistParked=false;dockRegistry.slotRef("health")(dockSlot);renderHoisted()');await until('healthCalls>hoistBefore');
    await check('hoistedNode===dockSlot.querySelector(".server-health")','restoring a parked panel refreshes its original mount');
    await run(`dom.flushSync(()=>tree.render(React.createElement(App)));
      var playerRoot=document.createElement('div');document.body.append(playerRoot);var playerTree=createRoot(playerRoot);
      dom.flushSync(()=>playerTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Player,{downloadId:fixtureRows[0].id,downloadName:'Sample',onClose:()=>{}}))));`);
    await until("!!document.querySelector('audio')&&document.querySelector('audio').readyState>=2");
    await run("document.querySelector('audio').play();document.querySelector('[aria-label=\"'+t('player.detach')+'\"]').click()");
    await until("!!document.querySelector('.player-modal.detached')||[...load(path.join(fixtureRoot,'renderer/commands/windows.ts')).getCommandWindows()].some(w=>w.document.querySelector('audio'))");
    await run(`var child=load(path.join(fixtureRoot,'renderer/commands/windows.ts')).getCommandWindows().find(w=>w.document.querySelector('audio'));
      if(!child)throw Error('Player popout missing');var audio=child.document.querySelector('audio');audio.play();
      var previewRoot=child.document.createElement('div');child.document.body.append(previewRoot);var previewTree=createRoot(previewRoot);
      dom.flushSync(()=>previewTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(hostWindows.HostWindowProvider,{window:child},React.createElement(FilePreview,{downloadId:'detached',onClose:()=>{}})))));
    `);
    const popout=BrowserWindow.getAllWindows().find(w=>w!==win);assert(popout,'native player window exists');
    await until('previewCalls.detached>0&&audio.currentTime>.1');await run('var position=audio.currentTime,previewBefore=previewCalls.detached,stopsBefore=streamStops');
    win.minimize();await until("document.visibilityState==='hidden'&&child.document.visibilityState==='visible'");await wait(2300);
    await check('previewCalls.detached>=previewBefore+2','visible popout polls its own document while the main window is minimized');
    await check('audio===child.document.querySelector("audio")&&!audio.paused&&audio.currentTime>position+1&&streamStops===stopsBefore','actual detached player keeps playing with the same media element');
    console.log(await run("statsReceiver(fixtureRows.map(d=>({...d,status:'downloading',progress:.91,downSpeedBps:4096,peers:7})));JSON.stringify({sameReceiver:statsReceiver===model.receiveStats,immediate:model.store.getState().statsById.values().next().value})"));
    try { await until('child.document.querySelector(".media-buffer-source")?.textContent.includes("4 KB/s")'); }
    catch (error) { console.error(await run('JSON.stringify({stats:model.store.getState().statsById.values().next().value,childText:child.document.body.innerText.slice(-1600),childVisible:child.document.visibilityState,mediaInChild:audio.ownerDocument===child.document})')); throw error; }
    await check('statsSubscriptions===1','visible detached player keeps source speed live through the same shared subscription');
    // Silence is intentionally still playing: explicitly pause only for testing child visibility.
    await run('audio.pause()');popout.minimize();await until("child.document.visibilityState==='hidden'");await wait(100);
    await run('previewBefore=previewCalls.detached');await wait(2300);
    await check('previewCalls.detached===previewBefore','minimized popout stops its own preview polling');
    await run('emitProgress(.93)');
    await check('model.store.getState().statsById.values().next().value.progress===.91','when both windows are hidden, optional player counters rest too');
    popout.restore();popout.show();await until("child.document.visibilityState==='visible'&&previewCalls.detached>previewBefore");
    await check('document.visibilityState==="hidden"','child restoration refreshes independently of the hidden main window');
    await check('model.store.getState().statsById.values().next().value.progress===.93','restored child immediately receives the deferred source counters');
    await run('dom.flushSync(()=>previewTree.unmount());child.close();dom.flushSync(()=>playerTree.unmount());dom.flushSync(()=>tree.unmount());releaseModel()');await wait(100);
    await check('statsSubscriptions===0','closing the surfaces releases the sole stats subscription');
    assert.deepEqual(errors,[]);
    fs.mkdirSync(path.join(root,'artifacts/visibility-ui'),{recursive:true});fs.writeFileSync(path.join(root,'artifacts/visibility-ui/result.json'),JSON.stringify({checks,errors},null,2));
    console.log('PASS visibility complete');clearTimeout(deadline);app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
