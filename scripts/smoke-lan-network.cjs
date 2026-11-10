// Actual Chromium WebRTC LAN mesh on one PC. Only the TUN/pipe boundary and
// verified gossip delivery are fixtures; no adapter, routes or user rooms change.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const reverse = process.argv.includes('--reverse');
  const out = path.resolve(root, process.env.HAVVN_LAN_ARTIFACTS || 'artifacts/lan-acceptance', reverse ? 'network-high-host' : 'network');
  fs.mkdirSync(out, { recursive: true });
  const privateDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-lan-network-'));
  app.setPath('userData', path.join(privateDir, 'profile'));
  app.disableHardwareAcceleration();
  const ids = { H: (reverse ? '9' : '1').repeat(32), B: '2'.repeat(32), C: '3'.repeat(32) };
  const sid = ids.H + '.abcdef0123456789';
  const windows = new Map(), checks = [], errors = [];
  let signals = 0;
  const roleOf = event => [...windows].find(([, win]) => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)?.[0];
  ipcMain.on('lan-fixture-wire', (event, message) => {
    const role = roleOf(event); if (!role) return;
    if (message.type === 'signal') signals++;
    for (const [target, win] of windows) {
      if (target === role || message.to && ids[target] !== message.to) continue;
      win.webContents.send('lan-fixture-delivery', { ...message, from: ids[role] });
    }
  });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = (role, code) => windows.get(role).webContents.executeJavaScript(code);
  const snapshots = () => Promise.all([...windows.keys()].map(async role => ({ role, ...await run(role, 'snapshot()') })));
  const wait = async (predicate, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > end) throw Error('Timed out: ' + label); await pause(50); }
  };
  const check = async (label, fn) => { await fn(); checks.push(label); console.log('PASS', label); };
  const deadline = setTimeout(() => { console.error('LAN network deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    for (const role of Object.keys(ids)) {
      const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: {
        nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
      } });
      windows.set(role, win);
      win.webContents.on('console-message', details => { if (details.level === 'error') errors.push({ role, message: details.message }); });
      await win.loadURL('about:blank');
      await run(role, `
        var root=${JSON.stringify(root)}, self=${JSON.stringify(ids[role])}, sid=${JSON.stringify(sid)};
        var fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript')), cache={};
        function load(file) {
          if(cache[file])return cache[file].exports;
          var m={exports:{}};cache[file]=m;
          var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
          new Function('require','module','exports',js)(name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+'.ts'):require(name),m,m.exports);
          return m.exports;
        }
        var ipc=require('electron').ipcRenderer, received=[], trace=[], signalTrace=[], feedTun;
        var ip=load(path.join(root,'shared/lan-ip.ts')), packet=load(path.join(root,'shared/lan-packet.ts'));
        var transport=require(path.join(root,'dist/electron/electron/sharing/room-lan.js'));
        function ufrag(data){return data?.usernameFragment||data?.sdp?.split('a=ice-ufrag:')[1]?.split(String.fromCharCode(13))[0]}
        var wire=m=>ipc.send('lan-fixture-wire',m);
        var lan=new transport.LanSession({selfId:self,sessionId:sid,isHost:${role === 'H'},iceServers:[],
          sendSignal:(to,kind,data)=>{signalTrace.push({direction:'out',peer:to,kind,ufrag:ufrag(data)});wire({type:'signal',to,kind,data:JSON.parse(JSON.stringify(data))})},
          announce:(vip,gen,at)=>wire({type:'state',vip,gen,at}),
          genesis:()=>wire({type:'genesis',at:Date.now()}),
          admit:(target,at)=>wire({type:'admit',target,at}),evict:(target,at)=>wire({type:'evict',target,at}),
          reach:(peers,relay,at)=>wire({type:'reach',peers,relay,at}),
          reip:()=>{},persistFloor:()=>{},sendPacket:frame=>received.push(Buffer.from(frame).toString('hex')),
          onPacket:handler=>{feedTun=handler},onChange:()=>{},warn:m=>trace.push(String(m)),log:m=>trace.push(String(m)),
        });
        ipc.on('lan-fixture-delivery',(_event,m)=>{
          if(m.type==='signal'){signalTrace.push({direction:'in',peer:m.from,kind:m.kind,ufrag:ufrag(m.data)});lan.onSignal(m.from,m.kind,m.data);}
          if(m.type==='genesis')lan.onGenesis(m.from,sid,m.at);
          if(m.type==='admit')lan.onAdmit(m.from,m.target,m.at,sid);
          if(m.type==='evict')lan.onEvict(m.from,m.target,m.at,sid);
          if(m.type==='state')lan.onPeerState({memberId:m.from,sessionId:sid,vip:m.vip,gen:m.gen,at:m.at});
          if(m.type==='reach')lan.onPeerReach({memberId:m.from,sessionId:sid,peers:m.peers,relay:m.relay,at:m.at});
        });
        function frame(dst,body,source=lan.core.selfVip()) {
          var payload=Buffer.from(body), b=Buffer.alloc(28+payload.length);b[0]=0x45;b.writeUInt16BE(b.length,2);b[8]=64;b[9]=17;
          b.writeUInt32BE(source>>>0,12);b.writeUInt32BE(dst>>>0,16);b.writeUInt16BE(25565,20);b.writeUInt16BE(25565,22);b.writeUInt16BE(8+payload.length,24);
          payload.copy(b,28);b.writeUInt16BE(packet.ipChecksum(b,0,20),10);return b;
        }
        function tcpFrame(dst,flags,body='',server=false) {
          var payload=Buffer.from(body), syn=(flags&2)!==0, header=syn?24:20, b=Buffer.alloc(20+header+payload.length);
          b[0]=0x45;b.writeUInt16BE(b.length,2);b[8]=64;b[9]=6;b.writeUInt32BE(lan.core.selfVip(),12);b.writeUInt32BE(dst>>>0,16);
          b.writeUInt16BE(server?51234:49152,20);b.writeUInt16BE(server?49152:51234,22);
          b.writeUInt32BE(server?9000:1000,24);b.writeUInt32BE(flags&16?(server?1001:9001):0,28);
          b[32]=(header/4)<<4;b[33]=flags;b.writeUInt16BE(64240,34);
          if(syn)Buffer.from([2,4,4,216]).copy(b,40); // MSS 1240 for the LAN MTU of 1280.
          payload.copy(b,20+header);
          var pseudo=Buffer.alloc(12);b.copy(pseudo,0,12,20);pseudo[9]=6;pseudo.writeUInt16BE(header+payload.length,10);
          b.writeUInt16BE(packet.ipChecksum(Buffer.concat([pseudo,b.subarray(20)])),36);
          b.writeUInt16BE(packet.ipChecksum(b,0,20),10);return b;
        }
        function snapshot() {return {state:lan.buildState(),received:[...received],trace:[...trace],signalTrace:[...signalTrace],
          peers:[...lan.peers].map(([id,p])=>({id,connection:p.pc.connectionState,signaling:p.pc.signalingState,channel:p.ch.readyState,ice:p.pc.iceConnectionState,
            localUfrag:ufrag(p.pc.localDescription),remoteUfrag:ufrag(p.pc.remoteDescription),
            localCandidates:(p.pc.localDescription?.sdp?.match(/a=candidate:/g)||[]).length,remoteCandidates:(p.pc.remoteDescription?.sdp?.match(/a=candidate:/g)||[]).length}))};}
        true;
      `);
    }
    await check('host admission waits for explicit join', async () => {
      await run('H', `lan.startAsHost([${JSON.stringify(ids.B)},${JSON.stringify(ids.C)}])`);
      await wait(async () => (await run('B', 'snapshot().state.selfAdmitted')) === true, 'host admission');
      assert.equal(await run('B', 'snapshot().state.active'), false);
      // Deliberately let the host's initial offer reach passive joiners. A normal
      // human/UAC delay must not make the subsequent Accept hang forever.
      await pause(900);
    });
    await check('delayed joins form a three-way real WebRTC mesh', async () => {
      await Promise.all(['B', 'C'].map(role => run(role, 'lan.start()')));
      await wait(async () => (await snapshots()).every(s => s.peers.length === 2 && s.peers.every(p => p.connection === 'connected' && p.channel === 'open')), 'delayed mesh');
    });
    await check('bidirectional unicast reaches only the addressed player', async () => {
      await run('H', `feedTun(frame(ip.deriveVip(sid,${JSON.stringify(ids.B)}),'unicast'))`);
      await wait(async () => (await run('B', 'received.length')) === 1, 'unicast');
      assert.equal(await run('C', 'received.length'), 0);
      await run('B', `feedTun(frame(ip.deriveVip(sid,${JSON.stringify(ids.H)}),'reply'))`);
      await wait(async () => (await run('H', 'received.length')) === 1, 'reply');
      assert.equal(await run('B', `Buffer.from(received[0],'hex').subarray(28).toString()`), 'unicast');
    });
    await check('TCP SYN, SYN-ACK, game payload and refusal packets survive the tunnel byte for byte', async () => {
      const exchanges = [
        ['H','B',2,'',false], ['B','H',18,'',true], ['H','B',16,'',false],
        ['H','B',24,'minecraft-handshake-'.repeat(60),false], ['B','H',20,'',true],
      ];
      for (const [from,to,flags,body,server] of exchanges) {
        await Promise.all([...windows.keys()].map(role => run(role,'received=[]')));
        const sent = await run(from, `var tcp=tcpFrame(ip.deriveVip(sid,${JSON.stringify(ids[to])}),${flags},${JSON.stringify(body)},${server});feedTun(tcp);tcp.toString('hex')`);
        await wait(async () => (await run(to,'received.length'))===1, 'TCP '+flags);
        assert.equal(await run(to,'received[0]'),sent);
        assert.equal(await run('C','received.length'),0);
      }
      await Promise.all([...windows.keys()].map(role => run(role,'received=[]')));
    });
    await check('link quality comes from actual Chromium connection statistics', async () => {
      await wait(async () => (await snapshots()).every(s => s.state.participants.filter(p => p.memberId !== ids[s.role]).every(p => p.quality && Number.isFinite(p.rttMs))), 'measured link quality', 8000);
      for (const state of await snapshots()) for (const peer of state.state.participants.filter(p => p.memberId !== ids[state.role])) {
        assert.equal(peer.path, 'local'); assert.equal(peer.rttMs >= 0, true);
        assert.equal(peer.lossPct >= 0 && peer.lossPct <= 100, true);
      }
    });
    for (const [label, destination] of [['limited broadcast', '0xffffffff'], ['subnet broadcast', 'ip.sessionSubnet(sid).broadcast'], ['multicast discovery', '0xe00000fb']]) {
      await check(label + ' reaches both peers without self echo', async () => {
        await Promise.all([...windows.keys()].map(role => run(role, 'received=[]')));
        await run('H', `feedTun(frame(${destination},'discovery'))`);
        await wait(async () => (await run('B', 'received.length')) === 1 && (await run('C', 'received.length')) === 1, label);
        assert.equal(await run('H', 'received.length'), 0);
      });
    }
    await check('egress drops spoofed, malformed, oversized and off-LAN frames', async () => {
      await Promise.all([...windows.keys()].map(role => run(role, 'received=[]')));
      await run('H', `var dst=ip.deriveVip(sid,${JSON.stringify(ids.B)});feedTun(frame(dst,'spoof',ip.deriveVip(sid,${JSON.stringify(ids.C)})));feedTun(Buffer.from('bad'));feedTun(frame(dst,'x'.repeat(2000)));feedTun(frame(0x08080808,'off-LAN'))`);
      await pause(250);
      assert.equal((await snapshots()).every(s => s.received.length === 0), true);
    });
    await check('ingress drops an admitted player spoofing another IP', async () => {
      await run('H', `lan.peers.get(${JSON.stringify(ids.B)}).ch.send(frame(ip.deriveVip(sid,${JSON.stringify(ids.B)}),'forged',ip.deriveVip(sid,${JSON.stringify(ids.C)})))`);
      await pause(200); assert.equal(await run('B', 'received.length'), 0);
    });
    await check('room members without host admission cannot create LAN legs', async () => {
      const stranger = 'e'.repeat(32);
      await run('B', `lan.onPeerState({memberId:${JSON.stringify(stranger)},sessionId:sid,vip:ip.deriveVip(sid,${JSON.stringify(stranger)}),gen:0,at:Date.now()});lan.onSignal(${JSON.stringify(stranger)},'offer',{type:'offer',sdp:'invalid'});true`);
      assert.equal(await run('B', `lan.peers.has(${JSON.stringify(stranger)})`), false);
      assert.equal(await run('B', `lan.core.memberVip(${JSON.stringify(stranger)})===undefined`), true);
    });
    await check('terminal-failure retry rebuilds native channels and restores traffic', async () => {
      await run('H', `for(var n=0;n<4;n++)lan.onPeerFailed(${JSON.stringify(ids.B)},'peer-unreachable');true`);
      assert.equal(await run('H', `lan.terminal.has(${JSON.stringify(ids.B)})`), true);
      await run('H', 'lan.retryFailedPeers()');
      await wait(async () => (await snapshots()).every(s => s.peers.length === 2 && s.peers.every(p => p.connection === 'connected' && p.channel === 'open')), 'retry');
      await run('H', `feedTun(frame(ip.deriveVip(sid,${JSON.stringify(ids.B)}),'after-retry'))`);
      await wait(async () => (await run('B', 'received.length')) === 1, 'post-retry frame');
    });
    await check('eviction stops the evicted session and removes routes everywhere', async () => {
      await run('H', `lan.control('evict',${JSON.stringify(ids.C)})`);
      await wait(async () => !(await run('C', 'lan.isActive()')), 'eviction');
      for (const role of ['H', 'B']) {
        assert.equal(await run(role, `lan.peers.has(${JSON.stringify(ids.C)})`), false);
        assert.equal(await run(role, `lan.core.memberVip(${JSON.stringify(ids.C)})===undefined`), true);
      }
      assert.equal(await run('C', 'lan.peers.size'), 0);
      const before = await run('C', 'received.length');
      await run('H', `feedTun(frame(ip.deriveVip(sid,${JSON.stringify(ids.C)}),'after-evict'))`);
      await pause(200); assert.equal(await run('C', 'received.length'), before);
    });
    await check('suspend and stop close every channel and prevent further routing', async () => {
      await run('H', 'lan.suspend()');
      assert.equal(await run('H', 'lan.isActive()'), false); assert.equal(await run('H', 'lan.peers.size'), 0);
      await Promise.all([...windows.keys()].map(role => run(role, 'lan.stop();true')));
      assert.equal((await snapshots()).every(s => !s.state.active && s.peers.length === 0 && !s.state.selfVip), true);
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: true, checks, signals, errors, snapshots: await snapshots(), scope: 'Native Chromium data channels; fixture TUN and verified gossip, no adapter/OS route test.' }, null, 2));
    clearTimeout(deadline); console.log('LAN network:', checks.length, 'passed'); app.exit(0);
  }).catch(async error => {
    let state; try { state = await snapshots(); } catch { /* renderer may have exited */ }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ passed: false, checks, signals, errors, error: String(error.stack || error), snapshots: state }, null, 2));
    console.error(error); clearTimeout(deadline); app.exit(1);
  });
}
