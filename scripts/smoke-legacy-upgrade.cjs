/* eslint-disable @typescript-eslint/no-require-imports -- Real archived binaries with private profiles. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/one-pc-extended-20261106');
const versions = ['2.24.1','3.0.7','3.1.0'], id = 'migration-' + crypto.randomBytes(4).toString('hex');
const runRoot = path.join(output, id); fs.mkdirSync(runRoot, { recursive: true });
const report = { startedAt: new Date().toISOString(), id, cases: [], passed: false,
  limitations: ['Original archived executable and application code; bootstrap redirects the profile and blocks OS protocol/autostart writes', 'Tests profile migration to current code, not the NSIS installer or historical online update feed', 'Fixture paused private torrent and offline encrypted room; no user data'] };
const save = () => fs.writeFileSync(path.join(output, 'legacy-upgrade.json'), JSON.stringify(report, null, 2));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reg = key => { const r = spawnSync('reg.exe', ['query', key, '/s', '/reg:64'], { encoding: 'utf8', windowsHide: true }); assert.ok(r.status === 0 || r.status === 1); return r.status ? null : r.stdout; };
const regKeys = ['HKCU\\Software\\Classes\\magnet','HKCU\\Software\\Classes\\havvn','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'];
async function freePort() { const s = require('node:net').createServer(); await new Promise(resolve => s.listen(0,'127.0.0.1',resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
function prepare(version) {
  const dir = path.join(output, 'packages', version), resources = path.join(dir, 'resources');
  const original = path.join(resources, 'app.asar'), legacy = path.join(resources, 'legacy.asar');
  if (fs.existsSync(original)) { fs.renameSync(original, legacy); if (fs.existsSync(original + '.unpacked')) fs.renameSync(original + '.unpacked', legacy + '.unpacked'); }
  assert.ok(fs.existsSync(legacy));
  const asar = require('@electron/asar'), pkg = JSON.parse(asar.extractFile(legacy,'package.json'));
  assert.equal(pkg.version, version); assert.equal(pkg.main, 'dist/electron/electron/main.js');
  const bootstrap = path.join(resources, 'app'); fs.mkdirSync(bootstrap, { recursive: true });
  fs.writeFileSync(path.join(bootstrap, 'package.json'), JSON.stringify({ name:'havvn', version, main:'index.cjs' }));
  fs.writeFileSync(path.join(bootstrap, 'index.cjs'), `
const {app,ipcMain}=require('electron'),fs=require('fs'),path=require('path');
const base=path.resolve(process.env.HAVVN_MIGRATION_BASE||'');
if(!base.startsWith(${JSON.stringify(runRoot)}+path.sep)||!process.env.TH_INSTANCE?.startsWith('legacy-'))throw Error('Missing private migration profile');
app.setPath('userData',base);app.setPath('downloads',path.join(base,'downloads'));const archive=path.join(process.resourcesPath,'legacy.asar');app.getAppPath=()=>archive;
const events=[];const record=(kind,args)=>{events.push({kind,args});fs.writeFileSync(base+'.boundary.json',JSON.stringify({runtime:process.versions,events}));};
app.setAsDefaultProtocolClient=(...args)=>{record('blocked-protocol-registration',args);return false;};
app.setLoginItemSettings=options=>{record('blocked-autostart-registration',[options]);};
ipcMain.on('win:close',()=>{record('explicit-fixture-quit',[]);app.quit();});
require(path.join(archive,'dist/electron/electron/app-instance.js'));
const db=require(path.join(archive,'dist/electron/electron/db/store.js'));
db.updateSettings({engine:'native',defaultDownloadDir:path.join(base,'downloads'),enableDHT:false,enableLSD:false,enablePEX:false,enableUtp:false,portForwarding:false,autoLaunch:false,autoUpdate:false,watchFolderEnabled:false,clipboardWatchEnabled:false,closeToTray:false,minimizeToTray:false})
.then(()=>require(path.join(archive,${JSON.stringify(pkg.main)}))).catch(error=>{console.error(error);app.exit(1);});
`);
  return { dir, legacy, version: pkg.version, hash: hash(legacy), executable: path.join(dir, 'Havvn.exe') };
}
async function session(executable, args, env, label, expectedVersion, body) {
  const port = await freePort(), child = spawn(executable, [...args, '--havvn-start-hidden',`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'], { env, windowsHide:true, stdio:'pipe' });
  const log = fs.createWriteStream(path.join(runRoot,label+'.log')); child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let exited=false,socket,seq=0;child.once('exit',()=>{exited=true;});child.once('error',error=>{exited=true;log.write(String(error));});
  try {
    let page;const deadline=Date.now()+90000;
    while(Date.now()<deadline&&!exited){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json()).find(p=>p.type==='page'&&p.url.includes('/renderer/index.html'));}catch{}if(page)break;await sleep(150);}
    assert.ok(page,label+' renderer unavailable');socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    const evaluate=expression=>new Promise((resolve,reject)=>{const messageId=++seq,timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error(label+' IPC timeout'));},45000);
      function receive(event){const msg=JSON.parse(event.data);if(msg.id!==messageId)return;clearTimeout(timer);socket.removeEventListener('message',receive);if(msg.error||msg.result?.exceptionDetails)reject(Error(JSON.stringify(msg)));else resolve(msg.result.result.value);}
      socket.addEventListener('message',receive);socket.send(JSON.stringify({id:messageId,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});
    let ready=false;while(Date.now()<deadline&&!exited){try{ready=await evaluate("document.readyState==='complete'&&!!window.api&&!!document.getElementById('root')?.childElementCount&&!document.getElementById('th-splash')");}catch(error){if(!/Execution context was destroyed|Cannot find context/.test(error.message))throw error;}if(ready)break;await sleep(150);}
    assert.ok(ready);assert.equal(await evaluate('window.api.getAppVersion()'),expectedVersion);
    assert.equal(await evaluate("typeof window.require==='undefined'&&typeof window.process==='undefined'"),true);
    const result=await body(evaluate);
    socket.send(JSON.stringify({id:++seq,method:'Runtime.evaluate',params:{expression:'window.api.win.close()'}}));
    for(let i=0;i<150&&!exited;i++)await sleep(100);assert.ok(exited,label+' did not close');return result;
  } finally {socket?.close();if(!exited&&child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});log.end();}
}
(async()=>{
  const before = regKeys.map(reg); save();
  const createTorrent=(await import('create-torrent')).default;
  for(const version of versions){
    console.log('START legacy '+version);const archived=prepare(version),base=path.join(runRoot,version),instance='legacy-'+version;
    fs.mkdirSync(path.join(base,'downloads'),{recursive:true});fs.mkdirSync(base+'-'+instance,{recursive:true});
    fs.writeFileSync(path.join(base+'-'+instance,'config.json'),JSON.stringify({defaultsSeeded:true,suggestedFeedSeeded:true,splitStoresMigrated:true,utpDefaultOnMigrated:true,vpnWarningDismissed:true}));
    const sourceDir=path.join(base,'source');fs.mkdirSync(sourceDir);const payload=path.join(sourceDir,'legacy-fixture.bin');fs.writeFileSync(payload,crypto.randomBytes(32768));const payloadHash=hash(payload);
    const torrentFile=path.join(base,'fixture.torrent');fs.writeFileSync(torrentFile,await new Promise((resolve,reject)=>createTorrent(payload,{announceList:[],private:true},(error,bytes)=>error?reject(error):resolve(bytes))));
    const env={...process.env,TH_INSTANCE:instance,HAVVN_MIGRATION_BASE:base,HAVVN_ENGINE:'native',NODE_ENV:'production'};delete env.ELECTRON_RUN_AS_NODE;
    const entry={from:version,to:require('../package.json').version,archiveSha256:archived.hash,status:'running'};report.cases.push(entry);save();
    const original=await session(archived.executable,[`--user-data-dir=${base}`],env,version+'-old',version,async evaluate=>{
      return evaluate(`(async()=>{
        await window.api.updateSettings({maxDownKbps:731,maxUpKbps:31});
        const category=await window.api.addCategory({name:'Legacy category ${version}',icon:'folder',color:'#4488aa'});
        const feed=await window.api.rss.addFeed({name:'Legacy feed ${version}',url:'https://example.invalid/migration.xml',enabled:false,autoDownload:false,intervalMinutes:30,categoryId:category.id});
        const download=await window.api.addDownload(${JSON.stringify({sourceType:'torrent_file',sourceUri:torrentFile,savePath:path.join(base,'downloads'),paused:true})});
        await window.api.pauseDownload(download.id);
        await window.api.setDownloadCategory(download.id,category.id);
        await window.api.rooms.setProfile({name:'Legacy profile ${version}'});
        const room=await window.api.rooms.create('Legacy room ${version}',true,false);
        await window.api.rooms.sendChat(room.roomId,'Preserve this message ${version}');
        const saved=await window.api.rooms.get(room.roomId),profile=await window.api.rooms.getProfile();
        const paused=(await window.api.getDownloads()).find(item=>item.id===download.id);
        return {categoryId:category.id,feedId:feed.id,downloadId:download.id,downloadStatus:paused.status,roomId:room.roomId,ownerId:saved.ownerId,code:saved.code,profile,chat:saved.chat.map(m=>m.text)};
      })()`);
    });
    assert.equal(original.downloadStatus,'paused');entry.seeded={category:true,feed:true,pausedDownload:true,encryptedRoom:true,message:true}; save();
    const inspect=`(async()=>{const settings=await window.api.getSettings(),categories=await window.api.getCategories(),feeds=await window.api.rss.getFeeds(),downloads=await window.api.getDownloads(),room=await window.api.rooms.get(${JSON.stringify(original.roomId)}),profile=await window.api.rooms.getProfile();return {settings:{down:settings.maxDownKbps,up:settings.maxUpKbps},category:categories.find(c=>c.id===${JSON.stringify(original.categoryId)}),feed:feeds.find(f=>f.id===${JSON.stringify(original.feedId)}),download:downloads.find(d=>d.id===${JSON.stringify(original.downloadId)}),room:room&&{ownerId:room.ownerId,code:room.code,name:room.name,e2e:room.e2e,chat:room.chat.map(m=>m.text)},profile};})()`;
    for(const phase of ['upgrade','restart']){
      const state=await session(require('electron'),[root,`--user-data-dir=${base}`],env,version+'-'+phase,require('../package.json').version,evaluate=>evaluate(inspect));
      assert.deepEqual(state.settings,{down:731,up:31});assert.equal(state.category.name,'Legacy category '+version);assert.equal(state.feed.categoryId,original.categoryId);assert.equal(state.feed.enabled,false);
      assert.equal(state.download.status,'paused');assert.equal(state.download.category,original.categoryId);assert.equal(state.download.savePath,path.join(base,'downloads'));
      assert.ok(state.room);assert.equal(state.room.code,original.code);assert.equal(state.room.ownerId,original.ownerId);assert.equal(state.room.e2e,true);assert.ok(state.room.chat.includes('Preserve this message '+version));
      assert.equal(state.profile.memberId,original.profile.memberId);assert.equal(state.profile.name,original.profile.name);
      entry[phase]={settings:true,category:true,feed:true,download:true,roomIdentity:true,roomKey:true,chat:true,profile:true};save();
    }
    assert.equal(hash(payload),payloadHash);
    assert.equal(hash(archived.legacy),archived.hash);assert.deepEqual(regKeys.map(reg),before);
    entry.boundary=JSON.parse(fs.readFileSync(base+'.boundary.json'));entry.status='passed';save();console.log('PASS legacy '+version);
  }
  report.passed=true;report.finishedAt=new Date().toISOString();save();console.log('PASS all real-version profile migrations');
})().catch(error=>{report.error=String(error.stack||error);save();console.error(error);process.exitCode=1;});
