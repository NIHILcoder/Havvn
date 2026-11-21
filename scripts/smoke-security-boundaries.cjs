// Synthetic files, a separate profile, local HTTP only. Run after build:electron.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
  const assert = require('node:assert/strict'), { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'artifacts/security-audit-20261030');
  fs.mkdirSync(output, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(output, 'browser-fixture-'));
  app.setPath('userData', path.join(fixture, 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 40000);
  const checks = [], windows = [];
  const runtime = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, undici: process.versions.undici };
  let cast, baseline, owner;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const record = (name, details = {}) => checks.push({ name, status: 'passed', ...details });
  app.whenReady().then(async () => {
    const { assertAppUiSender, installAppNavigationPolicy } = require('../dist/electron/electron/utils/app-ui-security');
    const { CastServer } = require('../dist/electron/electron/torrent/cast-server');
    const preload = path.join(fixture, 'preload.cjs');
    fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{read:()=>ipcRenderer.invoke('security-fixture:read')});`);
    const trusted = path.join(fixture, 'trusted.html'), foreign = path.join(fixture, 'untrusted.html');
    fs.writeFileSync(trusted, '<!doctype html><title>Trusted synthetic shell</title>');
    fs.writeFileSync(foreign, '<!doctype html><title>Untrusted synthetic file</title><script src="./untrusted.js"></script>');
    fs.writeFileSync(path.join(fixture, 'untrusted.js'), `window.foreignLoaded=true;window.probe.read().then(v=>window.probeResult=v,()=>window.probeResult='rejected');`);
    ipcMain.handle('security-fixture:read', event => { assertAppUiSender(event, owner); return 'synthetic-capability'; });
    const create = extra => {
      const win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, ...extra,
      } }); windows.push(win); return win;
    };
    // Demonstrate the historical file:// prefix rule using synthetic capabilities.
    owner = create({ preload });
    owner.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
    await owner.loadFile(trusted);
    await owner.webContents.executeJavaScript(`{ const a=document.createElement('a');a.href=${JSON.stringify(pathToFileURL(foreign).href)};document.body.append(a);a.click(); }`);
    await wait(250);
    assert.equal(owner.webContents.getURL(), pathToFileURL(foreign).href);
    assert.equal(await owner.webContents.executeJavaScript('window.probeResult'), 'synthetic-capability');
    record('historical local-document navigation reproduces bridge exposure');
    owner.destroy();

    owner = create({ preload });
    const external = [];
    installAppNavigationPolicy(owner.webContents, url => external.push(url));
    await owner.loadFile(trusted);
    assert.equal(await owner.webContents.executeJavaScript('window.probe.read()'), 'synthetic-capability');
    await owner.webContents.executeJavaScript(`{ const a=document.createElement('a');a.href=${JSON.stringify(pathToFileURL(foreign).href)};document.body.append(a);a.click(); }`);
    await wait(150);
    assert.equal(owner.webContents.getURL(), pathToFileURL(trusted).href);
    assert.equal(await owner.webContents.executeJavaScript('window.foreignLoaded'), undefined);
    record('fixed navigation blocks a foreign local document; shell IPC still works');
    const untrustedWindow = create({ preload });
    await untrustedWindow.loadFile(foreign); await wait(100);
    assert.equal(await untrustedWindow.webContents.executeJavaScript('window.probeResult'), 'rejected');
    record('another Electron window cannot use shell capabilities');
    await owner.webContents.executeJavaScript(`location.hash='rooms/test'`);
    assert.equal(new URL(owner.webContents.getURL()).hash, '#rooms/test');
    record('hash navigation remains usable');
    await owner.webContents.executeJavaScript(`{const a=document.createElement('a');a.href='https://example.invalid/release';a.click();}`);
    await wait(100); assert.deepEqual(external, ['https://example.invalid/release']);
    assert.equal(new URL(owner.webContents.getURL()).pathname, new URL(pathToFileURL(trusted).href).pathname);
    record('HTTP link is routed to the external callback without fetching it');

    const headerOnly = session.fromPartition('security-header-only');
    let headerCalls = 0;
    headerOnly.webRequest.onHeadersReceived((details, callback) => {
      headerCalls++;
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'"] } });
    });
    const inlineFile = path.join(fixture, 'inline-control.html');
    fs.writeFileSync(inlineFile, '<!doctype html><script>window.inlineScriptRan=true</script>');
    const headerWindow = create({ session: headerOnly }); await headerWindow.loadFile(inlineFile);
    const headerOnlyExecuted = await headerWindow.webContents.executeJavaScript('window.inlineScriptRan === true');
    assert.equal(headerOnlyExecuted, false);
    assert(headerCalls > 0);
    record('bundled Electron applies response-header CSP to local files', { headerCalls, inlineScriptExecuted: headerOnlyExecuted });

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="document.documentElement.setAttribute(\'data-peer-script-ran\',\'yes\')"><script>document.documentElement.setAttribute("data-peer-script-ran","yes")</script><rect width="10" height="10" fill="red"/></svg>';
    // Control: this payload really executes without response policy.
    baseline = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svg); });
    await new Promise(resolve => baseline.listen(0, '127.0.0.1', resolve));
    const svgWindow = create({});
    await svgWindow.loadURL(`http://127.0.0.1:${baseline.address().port}/peer.svg`);
    assert.equal(await svgWindow.webContents.executeJavaScript('document.documentElement.getAttribute("data-peer-script-ran")'), 'yes');
    record('SVG control executes script without image response policy');
    const svgPath = path.join(fixture, 'peer.svg'); fs.writeFileSync(svgPath, svg);
    cast = new CastServer(() => null, () => null);
    const { url } = await cast.publishImage(svgPath);
    await svgWindow.loadURL(url);
    // The sandbox also prevents executeJavaScript: inspect DOM without running
    // code in the hostile document or weakening its actual response policy.
    svgWindow.webContents.debugger.attach('1.3');
    const { root: documentRoot } = await svgWindow.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await svgWindow.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: 'svg' });
    const { attributes } = await svgWindow.webContents.debugger.sendCommand('DOM.getAttributes', { nodeId });
    assert(!attributes.includes('data-peer-script-ran'));
    svgWindow.webContents.debugger.detach();
    record('actual CastServer SVG response blocks script as a top-level document');
    const preview = create({}); await preview.loadFile(trusted);
    const dims = await preview.webContents.executeJavaScript(`(async()=>{const i=new Image();i.src=${JSON.stringify(url)};document.body.append(i);await i.decode();return [i.naturalWidth,i.naturalHeight]})()`);
    assert.deepEqual(dims, [10, 10]);
    record('sandboxed SVG still renders as a normal image preview');
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ scope: 'isolated-local-only', runtime, checks }, null, 2));
    console.log(JSON.stringify({ output, runtime, passed: checks.length, checks: checks.map(check => check.name) }));
  }).catch(error => {
    console.error(error);
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ runtime, checks, error: String(error) }, null, 2));
    process.exitCode = 1;
  }).finally(async () => {
    cast?.destroy();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    if (baseline) { baseline.closeAllConnections(); await new Promise(resolve => baseline.close(resolve)); }
    clearTimeout(deadline); app.exit(process.exitCode || 0);
  });
}
