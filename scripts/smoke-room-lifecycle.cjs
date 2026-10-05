// Real Electron preload/lifecycle check. Isolated profile, no rooms joined,
// only synthetic microphone capture and no remote swarm connections.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-lifecycle-'));
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess'); // sandbox cannot launch the audio helper
  app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // synthetic source only; permission handlers still decide
  app.on('window-all-closed', () => {}); // keep the test host alive while replacing its only engine window
  const deadline = setTimeout(() => { console.error('Room lifecycle smoke deadline'); app.exit(1); }, 60_000);
  let manager;
  app.whenReady().then(async () => {
    const { RoomManager } = require(path.join(root, 'dist/electron/electron/sharing/room-manager.js'));
    const { RoomDiskBudget } = require(path.join(root, 'dist/electron/electron/sharing/room-disk-budget.js'));
    const diskBudget = new RoomDiskBudget();
    const releaseDisk = diskBudget.reserve([{ root: output, bytes: 32 }, { root: output, bytes: 64 }]);
    diskBudget.assertAvailable(output); releaseDisk(); releaseDisk();
    manager = new RoomManager();
    const roomResources = { maxUpKbps: 96, maxDownKbps: 1024, voicePriority: true, screenBitrateKbps: 1500 };
    const savedResources = await manager.setResources(roomResources);
    assert.equal(savedResources.saved, true); assert.equal(savedResources.applied, false);
    assert.equal(manager.win, null, 'saving resource preferences must not open an engine');
    // Session record fixture: this smoke does not need OS secret storage access.
    manager.unsavedRooms.set('diagnostic-only', { roomId: 'diagnostic-only', name: 'PRIVATE_SMOKE_NAME', code: 'PRIVATE_SMOKE_CODE', folder: path.join(output, 'PRIVATE_SMOKE_FOLDER'), createdAt: 1 });
    const offlineReport = manager.diagnoseRoom('diagnostic-only');
    assert.equal(offlineReport.connection.phase, 'offline');
    assert.equal(JSON.stringify(offlineReport).includes('PRIVATE_SMOKE'), false);
    assert.equal(manager.win, null, 'diagnostics must not create an engine for a known offline room');
    manager.unsavedRooms.delete('diagnostic-only');
    const devices = await manager.voiceDevices();
    assert.ok(Array.isArray(devices));
    assert.equal(manager.getEngineStatus().state, 'ready');
    const original = manager.win;
    assert.equal((await manager.setResources(roomResources)).applied, true);
    await assert.rejects(manager.call('resourceSettings', { policy: { ...roomResources, maxUpKbps: -1 } }), /Invalid room resource settings/);
    await assert.rejects(manager.sendChat('missing-room', 'hello'), /Room not found/);
    await assert.rejects(manager.call('chat', { roomId: 'missing-room', payload: { id: 'a'.repeat(32), text: 'hello' } }), /Room not active/);
    await assert.rejects(manager.call('retryConnection', { roomId: 'missing-room' }), /Room connection is not available/);
    await assert.rejects(manager.retryDecrypt('missing-room', 'missing-file'), /File not available in this room/,
      'the real preload must acknowledge and reject an unavailable cached decrypt request');
    assert.notEqual(original.webContents.session, require('electron').session.defaultSession);
    const capture = () => original.webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return true}).catch(e=>e.name)');
    assert.notEqual(await capture(), true, 'capture without an explicit action must be denied');
    await manager.voiceMicTestStart({ noiseSuppressionMode: 'enhanced' });
    const devicesWithLabels = await manager.voiceDevices();
    assert.ok(devicesWithLabels.some(d => d.kind === 'audioinput' && d.label), 'explicit synthetic capture must expose device labels');
    await manager.voiceMicTestStop();
    assert.notEqual(await capture(), true, 'test stop must revoke capture permission');
    const processor = 'registerProcessor("smoke", class extends AudioWorkletProcessor { process(){return true} });';
    const worklet = await original.webContents.executeJavaScript(`(async()=>{const c=new AudioContext();const u=URL.createObjectURL(new Blob([${JSON.stringify(processor)}],{type:"text/javascript"}));try{await c.audioWorklet.addModule(u);return true}finally{URL.revokeObjectURL(u);await c.close()}})()`);
    assert.equal(worklet, true, 'blob AudioWorklet must still work under the engine CSP');
    const { RNNOISE_WORKLET_SOURCE } = require(path.join(root, 'dist/electron/electron/sharing/voice/rnnoise-worklet.js'));
    const { RNNOISE_WASM_BASE64 } = require(path.join(root, 'dist/electron/electron/sharing/voice/rnnoise-wasm.js'));
    const rnnoise = await original.webContents.executeJavaScript(`(async()=>{
      const c=new AudioContext({sampleRate:48000});
      const u=URL.createObjectURL(new Blob([${JSON.stringify(RNNOISE_WORKLET_SOURCE)}],{type:'text/javascript'}));
      try {
        await c.audioWorklet.addModule(u);
        const n=new AudioWorkletNode(c,'rnnoise');
        const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('RNNoise timeout')),5000);n.port.onmessage=e=>{clearTimeout(timer);e.data.type==='ready'?resolve(true):reject(new Error(e.data.message))};});
        n.port.postMessage({type:'wasm',bytes:Uint8Array.from(atob(${JSON.stringify(RNNOISE_WASM_BASE64)}),x=>x.charCodeAt(0))});
        return await ready;
      } finally {URL.revokeObjectURL(u);await c.close()}
    })()`);
    assert.equal(rnnoise, true, 'real RNNoise WASM must initialize with the engine CSP');
    assert.equal(await original.webContents.executeJavaScript(`(async()=>{
      const c=new AudioContext(), a=new Audio();
      try {a.srcObject=c.createMediaStreamDestination().stream;await a.play();return true}
      finally {a.pause();a.srcObject=null;await c.close()}
    })()`), true, 'voice stream playback must still work');
    await original.webContents.executeJavaScript(`window.inlineProbe=false;const s=document.createElement('script');s.textContent='window.inlineProbe=true';document.head.appendChild(s);`);
    assert.equal(await original.webContents.executeJavaScript('window.inlineProbe'), false, 'inline document scripts must be blocked');
    let popups = 0; original.webContents.on('did-create-window', () => popups++);
    await original.webContents.executeJavaScript('window.open("https://example.invalid/")');
    assert.equal(popups, 0, 'external popup must be blocked');
    await original.webContents.executeJavaScript('location.href="https://example.invalid/"');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(original.webContents.getURL(), /room-engine\.html$/);
    const gone = new Promise(resolve => original.webContents.once('render-process-gone', resolve));
    original.webContents.forcefullyCrashRenderer();
    await gone;
    assert.equal(manager.getEngineStatus().state, 'failed');
    assert.equal(manager.win, null);
    await manager.voiceLeave('unused');
    await manager.screenWatchStop('unused', 'peer');
    assert.equal(manager.win, null, 'cleanup must not spawn an engine');
    await manager.voiceDevices();
    assert.equal(manager.getEngineStatus().state, 'ready');
    assert.notEqual(manager.win, original);
    assert.equal((await manager.setResources(roomResources)).applied, true);
    manager.destroy();
    assert.equal(manager.getEngineStatus().state, 'stopped');
    await assert.rejects(() => manager.voiceDevices(), /shut down/);
    const evidence = { diagnosticReadOnly: true, diagnosticSecretsExcluded: true, unavailableRetryRejected: true, roomResourcesPersistAndApply: true, nativeDiskBudgetWorks: true, isolatedSession: true, idleCaptureDenied: true, explicitSyntheticMicWorks: true, testStopRevokesCapture: true, blobWorkletWorks: true, rnnoiseWasmWorks: true, voicePlaybackWorks: true, inlineScriptsBlocked: true, remoteDocumentsBlocked: true, realPreloadReady: true, crashReported: true, cleanupDoesNotRespawn: true, retryReady: true, shutdownRejects: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Room lifecycle smoke passed:', JSON.stringify(evidence));
    console.log('Isolated evidence:', path.join(output, 'evidence.json'));
    clearTimeout(deadline); app.exit(0);
  }).catch(error => {
    console.error(error); if (manager) manager.destroy(); clearTimeout(deadline); app.exit(1);
  });
}
