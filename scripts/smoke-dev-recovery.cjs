// Real Chromium ERR_FAILED recovery, isolated session, no user profile or network.
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, session } = require('electron');
  const { loadDevelopmentRenderer } = require('../dist/electron/electron/utils/load-renderer.js');
  const { installAppNavigationPolicy } = require('../dist/electron/electron/utils/app-ui-security.js');
  const timer = setTimeout(() => { console.error('Startup recovery smoke timed out'); app.exit(1); }, 20000);
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const ses = session.fromPartition('dev-startup-recovery');
    let requests = 0, fail = true;
    ses.protocol.handle('http', request => {
      assert.equal(request.url, 'http://127.0.0.1:3000/');
      requests++;
      if (fail) { fail = false; return Response.error(); }
      return new Response('<!doctype html><title>Recovered</title><p id="ready">Renderer recovered</p>', { headers: { 'Content-Type': 'text/html' } });
    });
    const create = () => {
      const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, nodeIntegration: false, contextIsolation: true } });
      installAppNavigationPolicy(win.webContents, () => { throw Error('Unexpected external navigation'); });
      return win;
    };
    const win = create(), retries = [];
    await loadDevelopmentRenderer(win.webContents, (error, attempt) => retries.push({ code: error.code, attempt }));
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#ready").textContent'), 'Renderer recovered');
    assert.equal(requests, 2); assert.deepEqual(retries, [{ code: 'ERR_FAILED', attempt: 2 }]);
    win.destroy();

    // A persistent load failure must reject, not loop indefinitely.
    ses.protocol.unhandle('http'); let failures = 0;
    ses.protocol.handle('http', () => { failures++; return Response.error(); });
    const unavailable = create();
    await assert.rejects(loadDevelopmentRenderer(unavailable.webContents, () => {}), { code: 'ERR_FAILED' });
    assert.equal(failures, 3); unavailable.destroy();
    ses.protocol.unhandle('http');
    clearTimeout(timer);
    console.log('Dev recovery passed: real ERR_FAILED, recovery on retry, persistent failure stops after three attempts; sandbox and navigation policy enabled.');
    app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(timer); app.exit(1); });
}
