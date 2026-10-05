// Real desktop <-> guest WebRTC across two isolated Electron renderers.
// Synthetic microphones, local ICE only: no user room, trackers, STUN or TURN.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-voice-'));
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const ts = require('typescript');
  const guestFile = path.join(output, 'guest-voice.cjs');
  const guestJs = ts.transpileModule(fs.readFileSync(path.join(root, 'guest/voice.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText.replace(/require\("\.\.\/shared\/([^"\n]+)"\)/g, (_match, name) =>
    'require(' + JSON.stringify(path.join(root, 'dist/electron/shared', name + '.js')) + ')');
  fs.writeFileSync(guestFile, guestJs);
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, String.raw`
    const { ipcRenderer } = require('electron');
    addEventListener('DOMContentLoaded', async () => {
      try {
        const { root, role, guestFile } = await ipcRenderer.invoke('voice-smoke-config');
        const fs = require('node:fs'), path = require('node:path');
        const built = path.join(root, 'dist/electron');
        let voice, raw, peer, baseline; const trace = [];
        const hooks = {
          selfId: role, iceServers: [],
          sendSignal(to, kind, data) { ipcRenderer.send('voice-wire', { kind, data: JSON.parse(JSON.stringify(data)) }); },
          announce(inVoice, muted, at, deafened) { ipcRenderer.send('voice-presence', { inVoice, muted, at, deafened }); },
          announceShare() {}, sendLoopback() {}, onChange() {}, warn() {}, log(msg) { if (trace.length < 20) trace.push(String(msg)); },
        };
        if (role === 'A') {
          const { VoiceSession, defaultVoiceSettings } = require(path.join(built, 'electron/sharing/room-voice.js'));
          voice = new VoiceSession(hooks, () => Date.now(), () => ({ ...defaultVoiceSettings(), noiseSuppressionMode: 'off' }));
        } else {
          const { GuestVoice } = require(guestFile);
          voice = new GuestVoice(hooks);
        }
        const other = role === 'A' ? 'B' : 'A';
        ipcRenderer.on('voice-wire', (_e, m) => voice.onSignal(other, m.kind, m.data));
        ipcRenderer.on('voice-presence', (_e, m) => voice.onPeerState(other, m.inVoice, m.muted, m.at, m.deafened));
        async function snapshot() {
          const p = voice.peers.get(other), pc = p?.pc;
          let receivedAudioBytes=0;
          if(pc&&pc.connectionState!=='closed')for(const stat of (await pc.getStats()).values())if(stat.type==='inbound-rtp'&&(stat.kind||stat.mediaType)==='audio')receivedAudioBytes+=stat.bytesReceived||0;
          return { receivedAudioBytes, transmitting: role==='A' ? voice.localStream?.getAudioTracks()[0]?.enabled===true : voice.stream?.getAudioTracks()[0]?.enabled===true, connection: pc?.connectionState, signaling: pc?.signalingState, recovery: p?.recovery.state, attempts: p?.recovery.attempts,
            ice: pc?.iceConnectionState, gather: pc?.iceGatheringState,
            receivers: pc?.getReceivers().filter(r => r.track.kind === 'audio').length,
            ufrag: pc?.localDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1],
            retained: !baseline || voice.peers.get(other) === peer && (role === 'A' ? voice.rawStream : voice.stream) === raw,
            gated: role === 'A' ? voice.localStream?.getAudioTracks()[0]?.enabled === false : voice.stream?.getAudioTracks()[0]?.enabled === false,
            closed: peer?.pc.connectionState === 'closed', stopped: raw?.getAudioTracks()[0]?.readyState === 'ended', trace };
        }
        ipcRenderer.on('voice-command', async (_e, { id, command }) => {
          try {
            if (command === 'join') await voice.join();
            if (command === 'baseline') { peer = voice.peers.get(other); raw = role === 'A' ? voice.rawStream : voice.stream; baseline = true; }
            if (command === 'ptt-idle' && role==='A') voice.setInputMode('ptt');
            if (command === 'ptt-down' && role==='A') voice.setPtt(true);
            if (command === 'ptt-up' && role==='A') voice.setPtt(false);
            if (command === 'gate') { if (role === 'A') voice.setMuted(true); else voice.setDeafened(true); }
            if (command === 'retry') voice.reconnect();
            if (command === 'network') voice.onNetworkChanged();
            if (command === 'leave') voice.leave();
            ipcRenderer.send('voice-result', { id, data: await snapshot() });
          } catch (e) { ipcRenderer.send('voice-result', { id, error: String(e.stack || e) }); }
        });
        ipcRenderer.send('voice-ready');
      } catch (e) { ipcRenderer.send('voice-fatal', String(e.stack || e)); }
    }, { once: true });
  `);
  const windows = new Map(), ready = new Set(), pending = new Map();
  let serial = 0, offers = 0;
  const deadline = setTimeout(() => { console.error('Voice smoke deadline'); app.exit(1); }, 90_000);
  const fail = error => { console.error(error); clearTimeout(deadline); app.exit(1); };
  const roleOf = event => [...windows].find(([, win]) => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)?.[0];
  ipcMain.handle('voice-smoke-config', event => { const role = roleOf(event); if (!role) throw new Error('Unknown smoke sender'); return { root, role, guestFile }; });
  ipcMain.on('voice-ready', event => { const role = roleOf(event); if (role) ready.add(role); });
  ipcMain.on('voice-fatal', (event, error) => { if (roleOf(event)) fail(error); });
  for (const channel of ['voice-wire', 'voice-presence']) ipcMain.on(channel, (event, payload) => {
    const role = roleOf(event); if (!role) return;
    if (channel === 'voice-wire' && payload.kind === 'offer') offers++;
    windows.get(role === 'A' ? 'B' : 'A').webContents.send(channel, payload);
  });
  ipcMain.on('voice-result', (event, result) => {
    const p = pending.get(result.id); if (!p || p.role !== roleOf(event)) return;
    pending.delete(result.id); result.error ? p.reject(new Error(result.error)) : p.resolve(result.data);
  });
  function command(role, command) {
    const id = ++serial;
    return new Promise((resolve, reject) => { pending.set(id, { role, resolve, reject }); windows.get(role).webContents.send('voice-command', { id, command }); });
  }
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const both = commandName => Promise.all(['A', 'B'].map(role => command(role, commandName)));
  async function wait(test, label) {
    const until = Date.now() + 30_000;
    while (!await test()) { if (Date.now() > until) throw new Error(label); await pause(50); }
  }
  const healthy = states => states.every(s => s.connection === 'connected' && s.signaling === 'stable' && s.recovery === 'connected');
  app.whenReady().then(async () => {
    for (const role of ['A', 'B']) {
      const partition = 'voice-smoke-' + role, sess = session.fromPartition(partition);
      sess.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
      sess.setPermissionCheckHandler((_wc, permission) => permission === 'media');
      const win = new BrowserWindow({ show: false, webPreferences: { preload, partition, nodeIntegration: false, contextIsolation: true, sandbox: false, backgroundThrottling: false } });
      windows.set(role, win);
      win.webContents.setWebRTCIPHandlingPolicy('default_public_and_private_interfaces'); // local-only fixture, no public rendezvous
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', e => e.preventDefault());
      win.webContents.on('preload-error', (_event, _file, error) => fail(error));
    }
    await Promise.all([...windows.values()].map(win => win.loadFile(path.join(root, 'electron/sharing/room-engine.html'))));
    await wait(() => ready.size === 2, 'Both isolated preloads ready');
    await command('A', 'join'); await command('B', 'join');
    await wait(async () => healthy(await both('snapshot')), 'Initial desktop/guest ICE connection');
    await wait(async()=> (await both('snapshot')).every(s=>s.receivedAudioBytes>0),'Actual bidirectional audio RTP');
    assert.equal((await command('A','ptt-idle')).transmitting,false);
    assert.equal((await command('A','ptt-down')).transmitting,true);
    assert.equal((await command('A','ptt-up')).transmitting,false);
    const baseline = await both('baseline'); assert.ok(baseline.every(s => s.receivers > 0));
    await both('gate'); const oldOffers = offers;
    await both('retry');
    await wait(async () => { const states = await both('snapshot'); return offers >= oldOffers + 2 && healthy(states) && states.every((s, i) => s.ufrag !== baseline[i].ufrag); }, 'Simultaneous ICE restart and refreshed credentials');
    const recovered = await both('snapshot'); assert.ok(recovered.every(s => s.retained && s.gated));
    await both('network'); await wait(async () => healthy(await both('snapshot')), 'Local network recovery');
    await pause(1000);
    const stable = await both('snapshot'); assert.ok(healthy(stable)); assert.ok(stable.every(s => s.retained && s.gated));
    const stopped = await both('leave'); assert.ok(stopped.every(s => s.closed && s.stopped));
    const evidence = { actualDesktopGuestWebRTC: true, isolatedRenderers: true, syntheticMicrophones: true, actualBidirectionalAudioRtp: true, pushToTalkGatesTrack: true, localIceOnly: true,
      simultaneousIceRestart: true, refreshedIceCredentials: true, mediaTracksRetained: true, muteDeafenRetained: true,
      localNetworkRecovery: true, teardownStopsTracksAndPeers: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Room voice smoke passed:', JSON.stringify(evidence)); console.log('Isolated evidence:', path.join(output, 'evidence.json'));
    clearTimeout(deadline); app.exit(0);
  }).catch(async error => {
    try { const states = await both('snapshot'); states.forEach(s => { delete s.ufrag; }); console.error('Safe voice states:', JSON.stringify(states)); } catch { /* renderer already gone */ }
    fail(error);
  });
}
