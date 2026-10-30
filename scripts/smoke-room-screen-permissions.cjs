// Real Electron display-capture permission regression. Captures only this
// script's small synthetic window; microphone input is a Chromium fake device.
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, desktopCapturer } = require('electron');
  const { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(root, process.argv.find(s => s.startsWith('--output='))?.slice(9) || 'artifacts/room-screen-permissions-20261030/native-after.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(path.dirname(output), 'profile-')));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Screen permission regression deadline'); app.exit(1); }, 35000);
  const evidence = { runtime: process.versions.electron, permissions: [], checks: {}, capturedSource: 'owned synthetic test window only', physicalMicrophoneUsed: false };
  const windows = [];
  app.whenReady().then(async () => {
    const title = 'Havvn synthetic screen permission check';
    const fixture = new BrowserWindow({ width: 360, height: 220, show: true, focusable: false, skipTaskbar: true, title, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(fixture);
    await fixture.loadURL('data:text/html,' + encodeURIComponent(`<title>${title}</title><body style="background:#16324f;color:white;font:24px sans-serif">Havvn synthetic capture</body>`));
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.name === title);
    assert(source, 'the explicitly created synthetic window must be listed');
    const win = new BrowserWindow({ show: false, webPreferences: { partition: 'temporary-screen-permission-test', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    windows.push(win);
    let grant = { audio: false, video: false };
    const ses = win.webContents.session;
    const setCheck = ses.setPermissionCheckHandler.bind(ses), setRequest = ses.setPermissionRequestHandler.bind(ses);
    ses.setPermissionCheckHandler = handler => setCheck((wc, permission, origin, details) => {
      const allowed = handler(wc, permission, origin, details);
      evidence.permissions.push({ kind: 'check', permission, allowed, mediaType: details.mediaType, isMainFrame: details.isMainFrame }); return allowed;
    });
    ses.setPermissionRequestHandler = handler => setRequest((wc, permission, cb, details) => handler(wc, permission, allowed => {
      evidence.permissions.push({ kind: 'request', permission, allowed, mediaTypes: details.mediaTypes, isMainFrame: details.isMainFrame }); cb(allowed);
    }, details));
    const page = path.join(root, 'dist/electron/electron/sharing/room-engine.html');
    require(path.join(root, 'dist/electron/electron/sharing/room-engine-policy.js')).installRoomEnginePolicy(win, pathToFileURL(page).href, () => grant);
    await win.loadFile(page);
    const capture = () => win.webContents.executeJavaScript(`(async()=>{try{const s=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:${JSON.stringify(source.id)}}}});const result={ok:true,videoTracks:s.getVideoTracks().length};s.getTracks().forEach(t=>t.stop());return result;}catch(e){return {ok:false,name:e.name,message:e.message};}})()`);
    const idle = await capture(); assert.equal(idle.ok, false); evidence.checks.idleDisplayDenied = true;
    grant = { audio: true, video: false };
    assert.equal(await win.webContents.executeJavaScript(`(async()=>{window.syntheticMic=await navigator.mediaDevices.getUserMedia({audio:true});return window.syntheticMic.getAudioTracks()[0].readyState;})()`), 'live');
    const micOnly = await capture(); assert.equal(micOnly.ok, false); evidence.checks.microphoneGrantDoesNotAllowDisplay = true;
    assert.equal(await win.webContents.executeJavaScript('window.syntheticMic.getAudioTracks()[0].readyState'), 'live'); evidence.checks.deniedDisplayPreservesExistingMic = true;
    grant = { audio: true, video: true };
    evidence.explicitCapture = await capture();
    assert.equal(evidence.explicitCapture.ok, true, 'an explicit screen operation must accept the runtime display-capture permission');
    assert.equal(evidence.explicitCapture.videoTracks, 1); evidence.checks.explicitDisplayWorks = true;
    grant = { audio: true, video: false };
    assert.equal((await capture()).ok, false); evidence.checks.displayGrantRevoked = true;
    assert.equal(await win.webContents.executeJavaScript('window.syntheticMic.getAudioTracks()[0].readyState'), 'live'); evidence.checks.screenCapturePreservesExistingMic = true;
    await win.webContents.executeJavaScript('window.syntheticMic.getTracks().forEach(t=>t.stop())');
    evidence.status = 'passed';
  }).catch(error => { evidence.status = 'failed'; evidence.error = String(error); console.error(error); }).finally(() => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
    clearTimeout(deadline); app.exit(evidence.status === 'passed' ? 0 : 1);
  });
}
