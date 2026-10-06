// Real desktop UI regression: generated E2E invite -> deep link, manual paste,
// clipboard and a second local peer. Synthetic profiles and loopback tracker only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (process.versions.electron) {
  const electron = require('electron'), { app } = electron;
  const base = process.env.HAVVN_INVITE_PROFILE;
  assert.ok(base && process.env.TH_INSTANCE);
  app.setPath('userData', base);
  require(path.join(root, 'dist/electron/electron/app-instance.js'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  if (process.argv.includes('--invite-seed')) {
    app.whenReady().then(async () => {
      const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
      await db.updateSettings({ engine: 'webtorrent', defaultDownloadDir: path.join(base, 'downloads'),
        enableDHT: false, enableLSD: false, enablePEX: false, enableUtp: false, portForwarding: false,
        autoLaunch: false, autoUpdate: false, closeToTray: false, minimizeToTray: false,
        watchFolderEnabled: false, clipboardWatchEnabled: false });
      app.exit(0);
    }).catch(e => { console.error(e); app.exit(1); });
  } else {
    const Module = require('node:module'), original = Module._load;
    const engineWrapper = path.join(base, 'engine-local.cjs'), uiWrapper = path.join(base, 'ui-local.cjs');
    // Copy the real preload body: sandboxed preload cannot require an arbitrary file.
    fs.writeFileSync(uiWrapper, "localStorage.setItem('onboarded','1');localStorage.setItem('language','en');\n" + fs.readFileSync(path.join(root,'dist/electron/electron/preload.js'),'utf8'));
    fs.writeFileSync(engineWrapper, `require(${JSON.stringify(path.join(root,'dist/electron/electron/sharing/ice-servers.js'))}).STUN_SERVERS.length=0;require(${JSON.stringify(path.join(root,'dist/electron/electron/sharing/room-engine.js'))});`);
    class FixtureWindow extends electron.BrowserWindow {
      constructor(options) {
        const preload = path.basename(options.webPreferences?.preload || '');
        const engine = preload === 'room-engine.js';
        if (engine) options.webPreferences.preload = engineWrapper;
        if (preload === 'preload.js') options.webPreferences.preload = uiWrapper;
        options.show = false;
        super(options);
        if (engine) this.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces');
      }
      show() {} // Fixtures never open visible application windows.
    }
    Module._load = function (name, ...args) {
      if (name === 'electron') return new Proxy(electron, { get: (target,key) => key === 'BrowserWindow' ? FixtureWindow : target[key] });
      return original.call(this, name, ...args);
    };
    require(path.join(root, 'dist/electron/electron/main.js'));
  }
} else {
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-room-invite-'));
  const clients = [], dict = require(path.join(root, 'renderer/i18n/en.json'));
  async function wait(probe, label, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await probe(); if (value) return value; await pause(100); }
    throw Error('Timed out: ' + label);
  }
  async function freePort() {
    const server = require('node:net').createServer();
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    const port = server.address().port; await new Promise(r => server.close(r)); return port;
  }
  async function start(role, tracker, invite) {
    const base = path.join(out, role), instance = 'invite-' + role;
    fs.mkdirSync(path.join(base,'downloads'),{recursive:true});
    fs.mkdirSync(base + '-' + instance);
    fs.writeFileSync(path.join(base + '-' + instance,'config.json'),JSON.stringify({defaultsSeeded:true,
      suggestedFeedSeeded:true,splitStoresMigrated:true,utpDefaultOnMigrated:true,vpnWarningDismissed:true,
      privacyConfig:{enableVPNDetection:false}}));
    const env = {...process.env, TH_INSTANCE:instance,HAVVN_INVITE_PROFILE:base,
      HAVVN_ROOM_TRACKERS:tracker,NODE_ENV:'production'};delete env.ELECTRON_RUN_AS_NODE;
    const seeded=spawnSync(require('electron'),[__filename,'--invite-seed'],{env,windowsHide:true,timeout:45000,encoding:'utf8'});
    assert.equal(seeded.status,0,seeded.stderr);
    const port=await freePort(), log=fs.createWriteStream(path.join(out,role+'.log'));
    const child=spawn(require('electron'),[__filename,'--havvn-start-hidden','--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port='+port,...(invite?['havvn://join/'+invite]:[])],{env,windowsHide:true,stdio:'pipe'});
    child.stdout.pipe(log);child.stderr.pipe(log);
    const client={child,log};clients.push(client);
    const page=await wait(async()=>{try {const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return pages.find(p=>p.type==='page'&&p.url.includes('/renderer/index.html'));}catch{return null;}},'renderer '+role,60000);
    const socket=new WebSocket(page.webSocketDebuggerUrl);client.socket=socket;
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let seq=0;
    client.run=code=>new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error('UI command timeout'));},20000);
      function receive(event){const m=JSON.parse(event.data);if(m.id!==id)return;clearTimeout(timer);socket.removeEventListener('message',receive);m.error||m.result?.exceptionDetails?reject(Error(JSON.stringify(m))):resolve(m.result.result.value);}
      socket.addEventListener('message',receive);socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:code,awaitPromise:true,returnByValue:true}}));
    });
    await wait(async()=>{try{return await client.run("!!window.api && document.readyState === 'complete'");}catch{return false;}},'preload '+role);
    await wait(async()=>{try{return await client.run("!!window.api && !!document.querySelector('.pillar-switch') && !document.getElementById('th-splash')");}catch{return false;}},'mounted UI '+role);
    return client;
  }
  (async()=>{
    const {Server}=await import('bittorrent-tracker');
    const tracker=new Server({http:false,udp:false,ws:true,interval:150000});
    tracker.on('error',e=>console.error('Local tracker:',e.message));
    await new Promise(r=>tracker.listen(0,'127.0.0.1',r));
    try {
      const a=await start('A','ws://127.0.0.1:'+tracker.ws.address().port);
      const room=await a.run("window.api.rooms.create('Invite fixture',true,false)");
      assert.match(room.code,/^(?:[a-z]+-){5}\d{5}-e2e$/);
      const b=await start('B','ws://127.0.0.1:'+tracker.ws.address().port,room.invite);
      await wait(()=>b.run("document.querySelector('.rooms-input-code')?.value === "+JSON.stringify(room.invite)),'new deep-link prefill');
      assert.equal((await b.run('window.api.rooms.list()')).length,0,'deep links must not auto-join');
      await b.run("Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:async()=>''});[...document.querySelectorAll('.um-foot button')].find(b=>b.textContent.includes("+JSON.stringify(dict['common.cancel'])+")).click()");
      await b.run("[...document.querySelectorAll('.rooms-page button')].find(b=>b.textContent.trim()==="+JSON.stringify(dict['rooms.join'])+").click()");
      await wait(()=>b.run("!!document.querySelector('.rooms-input-code')"),'manual join dialog');
      const enter=async value=>{await b.run("(()=>{const el=document.querySelector('.rooms-input-code');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,"+JSON.stringify(value)+");el.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause(100);await b.run("[...document.querySelectorAll('.um-foot button')].find(b=>b.textContent.includes("+JSON.stringify(dict['rooms.join'])+")).click()");};
      await enter(room.code+'~invalid');await pause(200);
      assert.equal((await b.run('window.api.rooms.list()')).length,0,'invalid owner pins must not reach join');
      await enter(room.invite);
      const joined=await wait(async()=>{const rooms=await b.run('window.api.rooms.list()');return rooms.length===1&&rooms[0];},'manual paste accepted');
      const state=await b.run('window.api.rooms.get('+JSON.stringify(joined.roomId)+')');
      assert.equal(state.code,room.code);assert.equal(state.e2e,true);
      await wait(async()=>{const state=await a.run('window.api.rooms.get('+JSON.stringify(room.roomId)+')');return state.peerCount>0;},'second real peer connected',45000);
      await b.run("Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:async()=>"+JSON.stringify(room.invite)+"});[...document.querySelectorAll('.rooms-page button')].find(b=>b.textContent.trim()==="+JSON.stringify(dict['rooms.join'])+").click()");
      await wait(()=>b.run("document.querySelector('.rooms-input-code')?.value === "+JSON.stringify(room.invite)),'new clipboard prefill');
      const report={ok:true,generatedFormat:true,deepLinkPrefill:true,deepLinkRequiresConfirmation:true,
        invalidOwnerPinRejected:true,manualPasteAccepted:true,encryptedPeerConnected:true,clipboardPrefill:true};
      fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
      console.log('PASS: room invitation UI and two real peers',JSON.stringify({...report,output:out}));
    } finally {
      for(const c of clients){try{const rooms=await c.run('window.api.rooms.list()');for(const room of rooms)await c.run('window.api.rooms.leave('+JSON.stringify(room.roomId)+",false,'stop')");await c.run('setTimeout(()=>window.api.win.close(),0);true');}catch{}c.socket?.close();}
      await pause(1500);
      for(const c of clients)if(c.child.exitCode===null&&c.child.pid) {
        if(process.platform==='win32')spawnSync('taskkill',['/PID',String(c.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        else c.child.kill('SIGKILL');
      }
      await new Promise(r=>tracker.close(r));
    }
  })().catch(e=>{console.error(e);console.error('Fixture logs:',out);process.exitCode=1;});
}