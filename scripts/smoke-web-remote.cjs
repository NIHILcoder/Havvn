// Isolated real HTTP + Electron page acceptance. No user torrent manager is started.
const fs = require('node:fs'), path = require('node:path');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), http = require('node:http');
  const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/one-pc-audit-20261106'), checks = [], errors = [];
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(output, 'web-remote-profile-')));
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 45000);
  let server, win;
  app.whenReady().then(async () => {
    const { WebRemoteServer } = require(path.join(root, 'dist/electron/electron/torrent/web-remote.js'));
    const actions = [], downloads = [{ id: 'd'.repeat(40), name: '<Synthetic torrent>', status: 'paused', progress: 0.5, totalSize: 1024 }];
    let offline = false, controlError = false;
    const manager = {
      getDownloads: async () => { if (offline) throw Error('Synthetic engine unavailable'); return downloads; },
      getStats: () => [], getFiles: async () => [{ name: 'Synthetic file.mp4', length: 1024, progress: 1 }],
      pauseDownload: async id => { if (controlError) throw Error('Synthetic pause rejected'); actions.push(['pause', id]); },
      resumeDownload: async id => actions.push(['resume', id]), recheckDownload: async id => actions.push(['recheck', id]),
      removeDownload: async (id, files) => actions.push(['remove', id, files]),
      addDownload: async data => { actions.push(['add', data]); return { id: 'new' }; },
    };
    server = new WebRemoteServer(); server.mgr = () => manager;
    const token = 'a'.repeat(64), nextToken = 'b'.repeat(64);
    await server.start(0, token);
    let base = `http://127.0.0.1:${server.getInfo().port}`;
    const request = (route, init = {}) => fetch(base + route, { ...init, signal: AbortSignal.timeout(3000), headers: { 'X-TH-Token': token, ...init.headers } });
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal((await request('/api/state', { headers: { 'X-TH-Token': 'wrong' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/state', { headers: { Host: 'attacker.invalid', 'X-TH-Token': token } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
    });
    assert.equal(badHost, 403); checks.push('missing-and-wrong-token-and-foreign-host-denied');
    const state = await request('/api/state'); assert.equal(state.status, 200); assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.equal((await state.json()).downloads[0].name, '<Synthetic torrent>'); checks.push('authenticated-state-json-and-no-store');
    offline = true;
    const failed = await request('/api/state'); assert.equal(failed.status, 503); assert.match((await failed.json()).error, /retry|temporar|unavailable/i);
    offline = false; assert.equal((await request('/api/state')).status, 200); checks.push('engine-failure-returns-readable-error-and-recovers');
    assert.equal((await request('/api/add', { method: 'POST', body: '{broken' })).status, 400);
    assert.equal((await request('/api/add', { method: 'POST', body: JSON.stringify({ magnet: 'file:///private' }) })).status, 400);
    assert.equal((await request('/api/torrents/id/invalid', { method: 'POST' })).status, 404); checks.push('invalid-json-non-magnet-and-unknown-control-rejected');
    win = new BrowserWindow({ show: false, width: 500, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    const run = code => win.webContents.executeJavaScript(code);
    const until = async code => { const end = Date.now() + 6000; while (!await run(code)) { if (Date.now() > end) throw Error('Web remote UI deadline: ' + code); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await win.loadURL(base + '/?k=' + token); await until('document.querySelectorAll(".card").length === 1');
    assert.equal(await run('document.querySelector(".name").textContent'), '<Synthetic torrent>');
    assert.equal(await run('typeof window.require === "undefined" && typeof window.process === "undefined"'), true); checks.push('real-sandboxed-page-renders-escaped-torrent-name');
    await run('document.querySelectorAll(".row button")[0].click()');
    const pauseDeadline = Date.now() + 3000; while (!actions.some(([kind]) => kind === 'pause') && Date.now() < pauseDeadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(actions.some(([kind]) => kind === 'pause')); checks.push('real-pause-button-dispatches');
    await run('document.querySelectorAll(".row button")[1].click()');
    const waitActions = Date.now() + 3000; while (!actions.some(([kind]) => kind === 'resume') && Date.now() < waitActions) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(actions.some(([kind]) => kind === 'resume'));
    await run('document.querySelectorAll(".row button")[2].click()'); await until('!!document.querySelector(".file .fn")'); checks.push('resume-and-file-list-buttons-dispatch');
    controlError = true; await run('document.querySelectorAll(".row button")[0].click()'); await until('document.querySelector("#remote-error")?.hidden === false');
    assert.match(await run('document.querySelector("#remote-error").textContent'), /Synthetic pause rejected/); controlError = false;
    await run('document.querySelectorAll(".row button")[0].click()'); await until('document.querySelector("#remote-error")?.hidden === true'); checks.push('failed-control-shows-error-successful-retry-clears-it');
    await run('document.querySelector("#mag").value="magnet:?xt=urn:btih:"+"a".repeat(40);addMag()');
    await until('document.querySelector("#mag").value === ""'); assert.ok(actions.some(([kind]) => kind === 'add')); checks.push('real-add-magnet-button-dispatches');
    offline = true; await run('refresh()'); await until('document.querySelector("#remote-error")?.hidden === false');
    assert.equal(await run('document.querySelectorAll(".card").length'), 1);
    offline = false; await run('refresh()'); await until('document.querySelector("#remote-error")?.hidden === true'); checks.push('poll-failure-visible-last-state-retained-and-recovery-clears-error');
    win.destroy(); win = null;
    await server.start(0, nextToken); base = `http://127.0.0.1:${server.getInfo().port}`;
    assert.equal((await request('/api/state')).status, 403); assert.equal((await request('/api/state', { headers: { 'X-TH-Token': nextToken } })).status, 200); checks.push('rotation-revokes-old-token');
    await server.stop(); assert.equal(server.getInfo().running, false); checks.push('disable-closes-server');
    fs.writeFileSync(path.join(output, 'web-remote-final.json'), JSON.stringify({ passed: true, checks, errors, runtime: process.versions.electron, limitations: 'Real HTTP and Electron UI; synthetic torrent manager; random local port; no user data' }, null, 2));
    console.log('PASS web remote: ' + checks.length + ' checks');
  }).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    win?.destroy(); server?.server?.closeAllConnections(); await server?.stop(); clearTimeout(deadline); app.exit(process.exitCode || 0);
  });
}
