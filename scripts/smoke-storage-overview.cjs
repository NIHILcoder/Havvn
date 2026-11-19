/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron acceptance. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-storage-ui-')),env={...process.env,HAVVN_STORAGE_UI:scratch};delete env.ELECTRON_RUN_AS_NODE;
  let completed=false;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{if(String(data).includes('PASS storage complete'))completed=true;process.stdout.write(data)});child.stderr.on('data',data=>process.stderr.write(data));child.on('error',error=>{console.error(error);process.exitCode=1});
  child.on('close',code=>{
    if(path.dirname(path.resolve(scratch))!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-storage-ui-'))throw Error('Unexpected profile');
    fs.rmSync(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(code!==0||!completed)process.exitCode=1;
  });
}else{
  const {app,BrowserWindow,ipcMain}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_STORAGE_UI||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-storage-ui-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'browser-profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  const deadline=setTimeout(()=>{console.error('Storage UI deadline');app.exit(1)},100000);
  app.whenReady().then(async()=>{
    const output=path.join(root,'artifacts/storage-ui');fs.mkdirSync(output,{recursive:true});
    const {registerStorageOverviewIpc}=require(path.join(root,'dist/electron/electron/ipc/storage-overview.js'));
    const secrets=require(path.join(root,'dist/electron/electron/db/secrets.js')),db=require(path.join(root,'dist/electron/electron/db/store.js'));
    const roomId=crypto.randomUUID(),rootId=crypto.randomUUID(),data=path.join(scratch,'data'),working=path.join(scratch,'working'),downloads=path.join(scratch,'downloads');
    const tracked=[];const put=(target,text)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);tracked.push(target);return target};
    const source=put(path.join(downloads,'source.bin'),'private source original');
    const copy=path.join(working,'.havvn-files','file','data-1','copy.bin');fs.mkdirSync(path.dirname(copy),{recursive:true});fs.linkSync(source,copy);tracked.push(copy);
    put(path.join(data,'rooms.json'),'protected shared history and draft container');put(path.join(data,'Cache','cache.bin'),'disposable cache');
    put(path.join(data,'room-enc',roomId,'data','cipher.bin'),'required original ciphertext');
    put(path.join(data,'room-documents','context','document-1.json'),'protected draft');
    const roomHash=crypto.createHash('sha256').update(roomId).digest('hex').slice(0,32),indexHash=crypto.createHash('sha256').update(JSON.stringify([roomId,rootId])).digest('hex');
    put(path.join(data,'room-file-sync',roomHash,'bytes',rootId,'snapshot-1','file.bin'),'protected head snapshot');
    put(path.join(working,'.havvn-sync','transactions','op-1','previous'),'last necessary backup');put(path.join(working,'.havvn-sync','transactions','op-1','journal.json'),'protected journal');
    put(path.join(working,'.havvn-sync','trash','op-2','previous'),'unique trash copy');
    put(path.join(data,'room-file-sync',roomHash,'room-sync-'+indexHash+'.json'),JSON.stringify({snapshot:secrets.encryptSecret(JSON.stringify({context:{localRoomId:roomId,rootId},binding:{path:working}}),false)}));
    const fingerprint=()=>tracked.map(file=>[file,fs.statSync(file).mtimeMs,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);const original=fingerprint();
    let locked=false,denyCache=false,delayMs=0,readCount=0;
    const stat=fs.promises.lstat.bind(fs.promises),open=fs.promises.opendir.bind(fs.promises),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    fs.promises.lstat=async(...args)=>{if(String(args[0]).startsWith(scratch)){readCount++;if(delayMs)await wait(delayMs)}return stat(...args)};
    fs.promises.opendir=(...args)=>denyCache&&String(args[0])===path.join(data,'Cache')?Promise.reject(Object.assign(Error('Fixture read denied'),{code:'EACCES'})):open(...args);
    const options={userData:data,sessionData:data,downloads:async()=>[{id:'d',name:'source.bin',savePath:downloads}],rooms:()=>({rooms:[{roomId,name:'Комната с длинным названием для проверки переноса текста',folder:working,locked:false}],more:false}),manifest:()=>[{fileId:'original',localOriginal:true,localPath:source}],decrypt:value=>{if(locked)throw Error('Fixture storage locked');return secrets.decryptSecretStrict(value)}};
    const checks=[],record=(value,label)=>{assert(value,label);checks.push(label);console.log('PASS '+label)};
    const css=require('./smoke-ui-fonts.cjs')(root)+['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/styles/appearance.css','renderer/pages/settings/controls.css','renderer/pages/settings/StorageOverview.css','renderer/pages/settings/ResourceModePanel.css','renderer/components/Modal.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/pages/rooms/RoomSyncModal.css','renderer/pages/rooms/RoomDataModal.css','renderer/pages/rooms/RoomDocuments.css'].map(file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html=path.join(scratch,'ui.html');fs.writeFileSync(html,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'#root{padding:18px;box-sizing:border-box;max-width:1000px;margin:auto}#app-host{display:none}</style><div id="root"></div></html>');
    const bridge=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,preload:path.join(root,'dist/electron/electron/preload.js')}});registerStorageOverviewIpc(bridge,options);await bridge.loadFile(html);
    const scan=()=>bridge.webContents.executeJavaScript(`window.api.storage.scan(${JSON.stringify(crypto.randomUUID())})`);
    const native=await scan();record(native.status==='complete'&&native.groups.length===10,'production preload returns all storage categories');
    record(native.groups.every(group=>group.reclaimableBytes===null)&&native.uniqueLogicalBytes<native.groups.reduce((sum,group)=>sum+(group.logicalBytes||0),0),'shared bytes are deduplicated and cleanup space remains unknown');
    record(!JSON.stringify(native).includes(scratch),'inventory IPC does not disclose filesystem paths or protected content');
    locked=true;const unavailable=await scan();record(unavailable.groups.find(group=>group.kind==='backups').logicalBytes===null&&unavailable.status==='partial','locked metadata is reported as unknown rather than zero');locked=false;
    assert.deepEqual(fingerprint(),original);record(true,'native census preserves originals, ciphertext, backup, trash and drafts');
    bridge.destroy();ipcMain.removeHandler('storage:scan');ipcMain.removeHandler('storage:cancel');
    const win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});registerStorageOverviewIpc(win,options);
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error(event.message)}});
    const run=code=>win.webContents.executeJavaScript(code),until=async code=>{const end=Date.now()+15000;while(!await run(code)){if(Date.now()>end){console.error(await run('document.body.innerText.slice(0,1800)'));throw Error('UI deadline: '+code)}await wait(25)}};
    await win.loadFile(html);await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(db.readSettingsImportState())},roomId=${JSON.stringify(roomId)},rootId=${JSON.stringify(rootId)},scanCalls=0,clearCalls=0,previews={room:0,cache:0,backups:0,trash:0},mutations=0;
      var ipc=require('electron').ipcRenderer;var fixtureApiOverrides={resourceMode:{get:async()=>({mode:'normal',power:'unknown',economy:false,revision:1}),onChanged:()=>()=>{}},
        storage:{scan:id=>{scanCalls++;return ipc.invoke('storage:scan',id)},cancel:id=>ipc.invoke('storage:cancel',id),onProgress:fn=>{var h=(_e,value)=>fn(value);ipc.on('storage:progress',h);return()=>ipc.removeListener('storage:progress',h)}},
        appearance:{getAcrylic:async()=>({enabled:false,active:false,reason:'off',material:'acrylic'}),onAcrylicChanged:()=>()=>{}},clearCache:async()=>{clearCalls++}};
      ${fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')}
      Object.assign(components,load(path.join(fixtureRoot,'renderer/components/Modal.tsx')),load(path.join(fixtureRoot,'renderer/components/Toggle.tsx')));
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/sections/SystemSection.tsx')).StorageOverviewPanel;
      window.api.rooms.diskUsage=async()=>{previews.room++;return{previewId:'preview',plaintext:22,ciphertext:28,originals:22,protectedCiphertext:28,untrackedBytes:0,removable:0,files:[{fileId:'original',name:'source.bin',plaintext:22,ciphertext:28,removable:0,original:true}],skipped:0}};
      window.api.rooms.localHistory=async()=>({items:[],retentionDays:30,cursorExpired:false});window.api.rooms.cleanupCopies=async()=>{mutations++;throw Error('Unexpected cleanup')};
      var rootView={rootId,name:'Рабочая папка',paused:false,publisher:true,owner:true,path:'fixture',autoApply:false,autoPublish:false,files:0,pending:0,conflicts:0};
      window.api.rooms.fileSync={state:async()=>({enabled:true,canCreate:true,roots:[rootView]}),files:async()=>({items:[],next:null}),cache:async(_room,_root,limit)=>{previews.cache++;if(limit!==undefined){mutations++;throw Error('Unexpected cache trim')}return{bytes:50,protectedBytes:50,removableBytes:0,freedBytes:0,limitBytes:100}},backups:async()=>{previews.backups++;return{rootId,previewId:'backup',bytes:20,protectedBytes:20,removeBytes:0,copies:1,removeCopies:0,unscanned:0,items:[],next:null,policy:{enabled:false,keepVersions:3,maxAgeDays:30,limitBytes:1048576}}},trashPreview:async()=>{previews.trash++;return{rootId,previewId:'trash',bytes:20,limitBytes:100,protectedBytes:20,reclaimableBytes:0,selectedBytes:0,selectedCopies:0,copies:1,unscanned:0,items:[],next:null}},confirmBackups:async()=>{mutations++;throw Error('Unexpected backup cleanup')},trashConfirm:async()=>{mutations++;throw Error('Unexpected trash cleanup')}};
      window.api.rooms.documents={view:async()=>({enabled:false,items:[]})};
      function renderPanel(){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(React.Fragment,null,React.createElement(Panel),React.createElement('button',{'data-storage-cache-control':true,onClick:()=>window.api.clearCache()},'Existing cache control')))))};renderPanel();var setStorageLanguage=fixtureSetLanguage;
      var appHost=document.createElement('div');appHost.id='app-host';document.body.append(appHost);var appTree=createRoot(appHost);dom.flushSync(()=>appTree.render(React.createElement(App)));void 0;`);
    await wait(100);record(await run('scanCalls===0'),'opening settings does not start background filesystem work');
    await run('document.querySelector("[data-storage-start]").click()');await until('!!document.querySelector("[data-storage-status=complete]")');
    record(await run('previews.room===0&&previews.cache===0&&previews.backups===0&&previews.trash===0&&mutations===0'),'counting neither activates source previews nor invokes cleanup');
    for(const language of ['ru','en']){
      await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/${language}.json'),'utf8'));document.documentElement.lang='${language}';dom.flushSync(()=>setStorageLanguage('${language}'));void 0;`);win.setSize(language==='ru'?480:1000,900);win.webContents.setZoomFactor(language==='ru'?1.25:1);await until('document.querySelector("[data-storage-overview]").textContent.includes(t("storage.unique"))');await wait(100);
      record(await run('[...document.querySelectorAll("[data-storage-overview] button,[data-storage-start]")].every(b=>b.scrollWidth<=b.clientWidth+1)&&document.documentElement.scrollWidth<=innerWidth+1'),language+' overview buttons and labels fit without horizontal clipping');
      fs.writeFileSync(path.join(output,'overview-'+language+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await run('document.querySelector("[data-storage-manage=app-cache]").click()');record(await run('document.activeElement.hasAttribute("data-storage-cache-control")&&clearCalls===0'),'cache management focuses the existing control without clearing data');
    await run('document.querySelector("[data-storage-manage=ciphertext]").click()');await until('!!document.querySelector(".room-data-panel")');await until('previews.room===1&&document.querySelector(".room-data-panel").closest(".um-card").querySelector(".um-x").disabled===false');
    record(await run('mutations===0'),'room copies open the existing protected-copy preview');await run('document.querySelector(".room-data-panel").closest(".um-card").querySelector(".um-x").click()');
    await run('document.querySelector("[data-storage-manage=sync-cache]").click()');await until('!!document.querySelector("[data-sync-storage-cache]")');
    record(await run('previews.cache===1&&mutations===0'),'sync cache opens its read-only preview with no trimming');await run('document.querySelector(".room-sync-modal .um-x").click()');
    await run('document.querySelector("[data-storage-manage=backups]").click()');await until('!!document.querySelector("[data-sync-storage-backups]")');
    record(await run('previews.backups===1&&mutations===0'),'backup management opens review without confirming removal');await run('document.querySelector(".room-sync-modal .um-x").click()');
    await run('document.querySelector("[data-storage-manage=trash]").click()');await until('previews.trash===1');record(await run('mutations===0'),'trash management keeps protected copies until explicit source confirmation');await run('document.querySelector(".room-sync-modal .um-x").click()');
    denyCache=true;await run('document.querySelector("[data-storage-start]").click()');await until('!!document.querySelector("[data-storage-status=partial]")');
    record(await run('document.querySelector("[data-storage-kind=app-cache]").textContent.includes(t("storage.unknown"))'),'access failures are visible as unknown size in the UI');denyCache=false;
    delayMs=40;await run('document.querySelector("[data-storage-start]").click()');await until('!!document.querySelector("[data-storage-cancel]")');await run('document.querySelector("[data-storage-cancel]").click()');await until('!!document.querySelector("[data-storage-status=canceled]")');delayMs=0;
    record(await run('!document.querySelector("[data-storage-start]").disabled'),'cancel finishes and permits a new scan');
    await run('document.querySelector("[data-storage-start]").click()');await until('!!document.querySelector("[data-storage-status=complete]")');
    record(await run('ipc.listenerCount("storage:progress")===1'),'repeated scans keep exactly one progress subscription');
    await run(`window.dispatchEvent(new CustomEvent('havvn:storage-open-page',{detail:'rooms'}));void 0;`);await until('!!appHost.querySelector("#test-room")');
    await run('document.querySelector("[data-storage-manage=downloads]").click()');await until('!appHost.querySelector("#test-room")');record(true,'download management uses the existing main-shell navigation');
    delayMs=40;await run('document.querySelector("[data-storage-start]").click()');await until('!!document.querySelector("[data-storage-cancel]")');await run('dom.flushSync(()=>tree.unmount())');await wait(300);const afterUnmount=readCount;await wait(200);
    record(readCount===afterUnmount&&await run('ipc.listenerCount("storage:progress")===0'),'leaving settings cancels work and releases progress listeners');
    assert.deepEqual(fingerprint(),original);record(true,'all original, ciphertext, backup, trash and draft bytes remain unchanged');
    await run('dom.flushSync(()=>appTree.unmount())');assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,errors},null,2));console.log('PASS storage complete');clearTimeout(deadline);app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
