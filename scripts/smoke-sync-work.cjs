/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron UI/IPC acceptance. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-sync-work-ui-')),env={...process.env,HAVVN_SYNC_WORK_UI:scratch};delete env.ELECTRON_RUN_AS_NODE;
  let completed=false;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{if(String(data).includes('PASS sync work complete'))completed=true;process.stdout.write(data)});child.stderr.on('data',data=>process.stderr.write(data));
  child.on('error',error=>{console.error(error);process.exitCode=1});
  child.on('close',code=>{
    if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-sync-work-ui-'))throw Error('Unexpected profile');
    fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(code!==0||!completed)process.exitCode=1;
  });
}else{
  const {app,BrowserWindow,ipcMain}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_SYNC_WORK_UI||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-sync-work-ui-'))throw Error('Missing profile');
  app.setPath('userData',path.join(scratch,'profile'));app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');app.on('window-all-closed',()=>{});
  const deadline=setTimeout(()=>{console.error('Sync work UI deadline');app.exit(1)},120000);
  app.whenReady().then(async()=>{
    const {RoomFileSync}=require(path.join(root,'dist/electron/electron/sharing/room-file-sync.js'));
    const {syncWorkQueue}=require(path.join(root,'dist/electron/electron/sharing/room-sync-work.js'));
    const {prepareSyncSnapshot}=require(path.join(root,'dist/electron/electron/sharing/room-sync-snapshot.js'));
    const {registerRoomFileSyncIpc}=require(path.join(root,'dist/electron/electron/ipc/room-file-sync.js'));
    const db=require(path.join(root,'dist/electron/electron/db/store.js')),identity=db.getRoomIdentity(),roomId=crypto.randomUUID();
    const working=path.join(scratch,'working');fs.mkdirSync(working);fs.writeFileSync(path.join(working,'config.ini'),'original=true');
    const service=new RoomFileSync({roomId,context:{scope:'local-ui',ownerId:require(path.join(root,'dist/electron/electron/sharing/room-crypto.js')).deriveMemberId(identity.pub),e2e:false},directory:path.join(scratch,'private'),identity,current:()=>true,send:async()=>{},seed:async()=>{},fetch:async()=>{throw Error('No network fixture')}});
    const rootId=await service.create('Folder with a long descriptive name for layout checks',working);
    const state=()=>({enabled:true,canCreate:true,roots:service.view()});
    const manager={fileSyncView:state,fileSyncFiles:(_room,id,offset,trash)=>service.files(id,offset,trash),fileSyncAction:async(_room,id,action,enabled)=>{await service.action(id,action,enabled);return state()},openFileSyncEditor:(_room,id,entry)=>service.openEditor(id,entry),saveFileSyncEditor:(_room,token,text)=>service.saveEditor(token,text),closeFileSyncEditor:(_room,token)=>service.closeEditor(token)};
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),untilMain=async test=>{const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw Error('Backend deadline');await wait(20)}};
    const checks=[],record=(value,label)=>{assert(value,label);checks.push(label);console.log('PASS '+label)};
    const css=require('./smoke-ui-fonts.cjs')(root)+['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/components/Modal.css','renderer/components/Toggle.css','renderer/pages/rooms/RoomSyncFolders.css','renderer/pages/rooms/RoomSyncModal.css','renderer/pages/rooms/RoomFileEditorModal.css','renderer/components/StreamPlayerModal.css','renderer/components/PlayerControls.css','renderer/components/MediaBufferStatus.css'].map(file=>fs.existsSync(path.join(root,file))?fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,''):'').join('\n');
    const html=path.join(scratch,'ui.html');fs.writeFileSync(html,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'body{margin:0}#root{padding:18px;box-sizing:border-box}#probe{margin:16px;width:250px}</style><div id="root"></div></html>');
    // Track only this fixture's registrations to change the trusted caller between phases.
    const channels=[],handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,listener)=>{channels.push(name);return handle(name,listener)};
    const bridge=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,preload:path.join(root,'dist/electron/electron/preload.js')}});
    registerRoomFileSyncIpc(bridge,manager);await bridge.loadFile(html);
    let release;const block=syncWorkQueue.run({owner:{}},()=>new Promise(resolve=>{release=resolve}));
    await service.action(rootId,'auto-publish',true);const queued=service.publish(rootId,'config.ini').catch(error=>error.message);
    await untilMain(()=>service.view()[0].work?.waiting>0);
    const fromBridge=await bridge.webContents.executeJavaScript(`window.api.rooms.fileSync.state(${JSON.stringify(roomId)})`);
    record(fromBridge.roots[0].work.reason==='resource-slot','production preload exposes the bounded preparation wait');
    await bridge.webContents.executeJavaScript(`window.api.rooms.fileSync.action(${JSON.stringify(roomId)},${JSON.stringify(rootId)},'cancel-work')`);
    record(await queued==='Sync preparation canceled'&&!service.view()[0].autoPublish,'production preload cancels queued work and pauses automatic publication');
    record(fs.readFileSync(path.join(working,'config.ini'),'utf8')==='original=true','cancel leaves the original file unchanged');
    release();await block;for(const channel of channels.splice(0))ipcMain.removeHandler(channel);bridge.destroy();
    await service.publish(rootId,'config.ini');
    const video=path.join(scratch,'sample.webm');
    require('node:child_process').execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=15','-t','20','-c:v','libvpx','-b:v','180k','-an','-y',video],{windowsHide:true,timeout:30000});
    const videoUrl=require('node:url').pathToFileURL(video).href;
    const win=new BrowserWindow({show:true,width:520,height:850,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
    registerRoomFileSyncIpc(win,manager);const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});
    const run=code=>win.webContents.executeJavaScript(code),until=async code=>{const end=Date.now()+15000;while(!await run(code)){if(Date.now()>end){console.error(await run('document.body.innerText.slice(0,1200)'));throw Error('UI deadline: '+code)}await wait(25)}};
    await win.loadFile(html);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(db.readSettingsImportState())};
      var fixtureApiOverrides={resourceMode:{get:async()=>({mode:'normal',power:'unknown',economy:false,revision:1}),onChanged:()=>()=>{}},
        getTorrentFiles:async()=>[{index:0,name:'sample.webm',path:'sample.webm',length:1000,downloaded:1000,priority:'normal'}],getStreamUrl:async()=>({url:${JSON.stringify(videoUrl)},kind:'video',transcoded:false}),audioTracks:{list:async()=>[]},subtitles:{list:async()=>[],get:async()=>null},historyPlayback:{duration:async()=>20}};
      ${fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')}
      var ipc=require('electron').ipcRenderer,roomId=${JSON.stringify(roomId)};
      window.api.rooms.fileSync={state:id=>ipc.invoke('rooms:syncState',id),files:(id,root,offset,trash)=>ipc.invoke('rooms:syncFiles',id,root,offset,trash),action:(id,root,action)=>ipc.invoke('rooms:syncAction',id,root,action),openEditor:(id,root,entry)=>ipc.invoke('rooms:syncEditorOpen',id,root,entry),saveEditor:(id,token,text)=>ipc.invoke('rooms:syncEditorSave',id,token,text),closeEditor:(id,token)=>ipc.invoke('rooms:syncEditorClose',id,token)};
      window.api.rooms.documents={view:async()=>({enabled:false,canCreate:false})};
      var Folders=load(path.join(fixtureRoot,'renderer/pages/rooms/RoomSyncFolders.tsx')).RoomSyncFolders;
      dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Folders,{roomId}))));void 0;`);
    await until('!!document.querySelector("[data-sync-folder-expand]")');await run('document.querySelector("[data-sync-folder-expand]").click()');
    await until('!!document.querySelector("[data-sync-open-editor]")');await run('document.querySelector("[data-sync-open-editor]").click()');
    await until('!!document.querySelector(".cm-content")');
    let releaseEditor;const editorBlock=syncWorkQueue.run({owner:{}},()=>new Promise(resolve=>{releaseEditor=resolve}));
    await run('document.querySelector(".cm-content").focus()');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
    await win.webContents.insertText('edited buffer retained');
    await until('document.querySelector(".cm-content").textContent.includes("edited buffer retained")');
    await until('[...document.querySelectorAll(".room-file-editor-modal .um-foot button")].find(b=>b.textContent.trim()===t("rooms.sync.editorSave"))?.disabled===false');
    await run('[...document.querySelectorAll(".room-file-editor-modal .um-foot button")].find(b=>b.textContent.trim()===t("rooms.sync.editorSave")).click()');
    await until('!!document.querySelector("[data-sync-editor-work]")');
    record(await run('document.querySelector("[data-sync-editor-work]").textContent.includes(t("rooms.sync.workWaiting").split("{n}")[0])'),'editor explains why a manual save is waiting');
    const output=path.join(root,'artifacts/sync-work-ui');fs.mkdirSync(output,{recursive:true});
    for(const language of ['ru','en']){
      await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/${language}.json'),'utf8'));fixtureSetLanguage('${language}');void 0;`);
      win.setSize(language==='ru'?480:680,850);win.webContents.setZoomFactor(language==='ru'?1.25:1);await wait(200);
      record(await run('[...document.querySelectorAll("[data-sync-editor-work] button")].every(b=>b.scrollWidth<=b.clientWidth+1&&b.getBoundingClientRect().bottom<=b.closest(".um-foot").getBoundingClientRect().bottom-8)&&document.documentElement.scrollWidth<=innerWidth+1'),language+' waiting controls fit at narrow width and UI scale');
      fs.writeFileSync(path.join(output,'waiting-'+language+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await run('document.querySelector("[data-sync-editor-work] button").click()');
    await until('!document.querySelector("[data-sync-editor-work]")&&document.body.innerText.includes(t("rooms.sync.workCanceled"))');
    record(await run('document.querySelector(".cm-content").textContent.includes("edited buffer retained")'),'canceling a queued save preserves the editor buffer');
    record(fs.readFileSync(path.join(working,'config.ini'),'utf8')==='original=true'&&service.view()[0].files===1,'canceled save commits neither file bytes nor another revision');
    releaseEditor();await editorBlock;
    await run(`var Player=load(path.join(fixtureRoot,'renderer/components/StreamPlayerModal.tsx')).StreamPlayerModal;dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Player,{downloadId:fixtureRows[0].id,downloadName:'Local video',onClose:()=>{}}))));var input=document.createElement('input');input.id='probe';document.body.prepend(input);void 0;`);
    await until('!!document.querySelector("video")&&document.querySelector("video").readyState>=2');await run('document.querySelector("video").play()');
    const initial=await run('document.querySelector("video").currentTime');
    const payload=path.join(scratch,'payload.bin');fs.writeFileSync(payload,Buffer.alloc(32*1048576,73));
    let done=false;const work=Promise.all(Array.from({length:6},(_,i)=>prepareSyncSnapshot({source:payload,storage:path.join(scratch,'work-'+i),authorId:'fixture',secret:'b'.repeat(64)}))).finally(()=>{done=true});
    const latencies=[];let probes=0;
    while(!done||probes<5){
      const started=performance.now();await run('document.querySelector("#probe").focus()');await win.webContents.insertText('x');
      assert.equal(await run('document.querySelector("#probe").value.length'),++probes);latencies.push(performance.now()-started);await wait(30);
    }
    await work;await wait(250);
    record(await run('!document.querySelector("video").paused')&&await run('document.querySelector("video").currentTime')>initial+.5,'real video playback advances while encrypted snapshots are prepared');
    record(probes>=5&&Math.max(...latencies)<1000,'real keyboard input remains responsive under preparation load');
    record(!service.view()[0].work,'completed work releases its queue state');
    await run('dom.flushSync(()=>tree.unmount())');service.close();await service.settled();
    // Expected IPC cancellation is an operation result, not a console error.
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,errors,input:{samples:probes,maxMs:Math.max(...latencies),latencies}},null,2));
    console.log('PASS sync work complete');clearTimeout(deadline);app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
