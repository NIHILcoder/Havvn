const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-speaker-output-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_SPEAKER_FIXTURE: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Unexpected fixture path');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow } = require('electron'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_SPEAKER_FIXTURE);
  const output = path.join(root, 'artifacts/ux-rooms-20261108');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const deadline = setTimeout(() => { console.error('Speaker deadline'); app.exit(1); }, 20000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const modulePath = path.join(root, 'dist/electron/electron/sharing/speaker-test.js'), preload = path.join(scratch, 'preload.cjs'), page = path.join(scratch, 'engine.html');
    fs.writeFileSync(preload, 'window.outputTest = new (require(' + JSON.stringify(modulePath) + ').SpeakerTester)();');
    fs.writeFileSync(page, '<!doctype html><html><meta charset="utf-8"><title>Owned speaker test</title><body>Isolated speaker test</body></html>');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', partition: 'speaker-test-fixture', preload } });
    let grant = { audio: false, video: false, speaker: false };
    require(path.join(root, 'dist/electron/electron/sharing/room-engine-policy.js')).installRoomEnginePolicy(win, pathToFileURL(page).href, () => grant);
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code);
    const checks = [];
    assert.equal(await run('!!window.outputTest'), true); checks.push('Production speaker tester loads in inert engine host');
    grant.speaker = true;
    assert.equal(await run('outputTest.play(null, 0.15).then(result=>result.ok)'), true); checks.push('Actual local AudioContext tone finishes under engine CSP');
    assert.equal(await run('outputTest.play("default", 0.15).then(result=>result.ok)'), true); checks.push('Explicit system output selection works without joining voice');
    assert.equal(await run('navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return false},()=>true)'), true); checks.push('Output-only permission does not grant microphone capture');
    assert.equal(await run('(async()=>{const pending=outputTest.play(null,0.15);setTimeout(()=>outputTest.stop(),30);return (await pending).ok})()'), false); checks.push('Actual running tone stops on cancellation');
    assert.equal(await run('outputTest.play("nonexistent-fixture-device",0.15).then(()=>false,()=>true)'), true); checks.push('Unavailable selected output fails without silent fallback');
    grant.speaker = false;
    assert.equal(await run('navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return false},()=>true)'), true); checks.push('Microphone remains denied after output test');
    fs.writeFileSync(path.join(output, 'speaker-native-results.json'), JSON.stringify({ checks, physicalAudibilityConfirmed: false }, null, 2));
    console.log('PASS native speaker output:', checks.length, 'checks'); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
