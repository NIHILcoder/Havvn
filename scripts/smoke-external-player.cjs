// Isolated Electron UI plus a real Windows argv receiver (not a VLC/mpv decoder).
// Never opens user media or changes the user's application associations/settings.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', data => { process.stdout.write(data); output = (output + data).slice(-8192); });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', async code => {
    process.exitCode = code ?? 1; if (code !== 0) return;
    const fs = require('node:fs'), path = require('node:path'), match = /screenshots: (.+)/.exec(output);
    const marker = match && path.join(match[1].trim(), 'Плеер с пробелами', 'after-owner-exit.txt');
    for (let i = 0; i < 30; i++) {
      if (marker && fs.existsSync(marker)) { console.log('PASS native player process continued after Electron exited'); return; }
      await new Promise(r => setTimeout(r, 100));
    }
    console.error('Native player did not complete after owner exit'); process.exitCode = 1;
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-external-player-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('external player deadline'); app.exit(1); }, 55000);
  app.on('window-all-externalClosed', () => {}); let history;
  app.whenReady().then(async () => {
    assert.equal(process.platform, 'win32', 'This native launch fixture currently targets Windows');
    const folder = path.join(out, 'Плеер с пробелами'); fs.mkdirSync(folder);
    const cs = path.join(folder, 'Receiver.cs'), mpv = path.join(folder, 'mpv.exe'), vlc = path.join(folder, 'vlc.exe');
    fs.writeFileSync(cs, 'using System; using System.IO; using System.Threading; class Receiver { static int Main(string[] args) { File.WriteAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "received.txt"), args); if (Array.Exists(args, a => a.StartsWith("http://127.0.0.1:"))) { Thread.Sleep(5000); } if (Array.IndexOf(args, "--start=123.456") >= 0) { Thread.Sleep(1500); File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "after-owner-exit.txt"), "done"); } return 0; } }');
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    require('node:child_process').execFileSync(csc, ['/nologo', '/target:exe', '/out:' + mpv, cs], { windowsHide: true, timeout: 15000 }); fs.copyFileSync(mpv, vlc);
    const name = 'Фильм $() & серия 01.mp4', disk = path.join(out, name); fs.writeFileSync(disk, '0123456789');
    const d = { id: 'test', infoHash: 'hash', savePath: out, name: 'Test film', status: 'paused', progress: 1 };
    let files = [{ name, path: name, length: 10, downloaded: 10, progress: 1 }], starts = 0;
    const cache = new Map();
    history = new (require(path.join(root, 'dist/electron/electron/services/history-playback.js')).HistoryPlayback)({
      download: async () => d, files: async () => files, cached: key => cache.get(key) || [], cache: (key, value) => cache.set(key, value),
      stream: async () => { starts++; throw Error('Must not start torrents'); }, ffmpeg: () => null,
    });
    const Store = require('electron-store'), store = new Store({ name: 'external-player-fixture', defaults: { preferences: { kind: 'default', executable: null } } });
    let systemError = '', systemCalls = [], picker = 'cancel', exe = mpv;
    const Player = require(path.join(root, 'dist/electron/electron/services/external-player.js')).ExternalPlayer;
    const dependencies = { read: () => store.get('preferences'), write: value => store.set('preferences', value), resolve: (id, rel) => history.localFile(id, rel),
      snapshot: async (_id,rel) => rel !== name ? {ok:false,reason:'invalid-file'} : d.status==='downloading' ? {ok:true,key:'isolated-source',name,length:10} : {ok:false,reason:'paused-file'},
      readMedia: async (_id,_rel,_key,start,max) => ({data:Buffer.from('0123456789').subarray(start,start+max).toString('base64')}),
      openPath: async file => { systemCalls.push(file); return systemError; } };
    let player = new Player(dependencies);
    ipcMain.handle('fixture:files', (_event, id) => history.files(id));
    ipcMain.handle('fixture:inspect', (_e,id,rel) => player.inspect(id,rel));
    ipcMain.handle('fixture:sessions', () => player.sessions());
    ipcMain.handle('fixture:stop', (_e,id) => player.stop(id));
    ipcMain.handle('fixture:getConfig', () => player.getConfig()); ipcMain.handle('fixture:default', () => player.useDefault());
    ipcMain.handle('fixture:choose', () => picker === 'cancel' ? { ok: true, config: null } : player.select(exe));
    ipcMain.handle('fixture:open', (_event, ...args) => player.open(...args));
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Modal.css', 'renderer/components/ExternalPlayer.css', 'renderer/components/TorrentControlModal.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(out, 'preview.html'); fs.writeFileSync(page, '<html><style>' + css + 'body{background:#101114}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1050, height: 720, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true } });
    win.webContents.on('console-message', event => { console.log('[renderer]', event.message); });
    await win.loadFile(page); const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(error) { console.error('Failed renderer step:', code); throw error; } };
    const capture = async file => { for (let i = 0; i < 10; i++) {
      try { fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG()); return; }
      catch (error) { if (i === 9) throw error; await new Promise(r => setTimeout(r, 100)); }
    } };
    const wait = async expression => { for (let i = 0; i < 80; i++) { if (await run(expression)) return; await new Promise(r => setTimeout(r, 100)); }
      fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); throw Error('UI wait failed: ' + expression); };
    const bootstrap = `
      var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),translate=k=>dict[k]||k,cache={},ipc=require('electron').ipcRenderer;
      window.api={historyPlayback:{files:id=>ipc.invoke('fixture:files',id)},externalPlayer:{inspect:(id,rel)=>ipc.invoke('fixture:inspect',id,rel),sessions:()=>ipc.invoke('fixture:sessions'),stop:id=>ipc.invoke('fixture:stop',id),getConfig:()=>ipc.invoke('fixture:getConfig'),useDefault:()=>ipc.invoke('fixture:default'),
        watchTarget:async()=>null,watchUpdates:async()=>[],acknowledgeWatch:async()=>{},choose:()=>ipc.invoke('fixture:choose'),open:(...args)=>ipc.invoke('fixture:open',...args)}};
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const source=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',source)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t:translate,language:'ru'})};
          if(s==='./PlayerControls')return{fmtTime:v=>Math.floor(v/60)+':'+String(Math.floor(v%60)).padStart(2,'0')};
          if(s==='./index')return{Icon:load(path.join(root,'renderer/components/Icon.tsx')).Icon,Button:load(path.join(root,'renderer/components/Button.tsx')).Button};
          if(s.endsWith('ConfirmDialog'))return{useConfirm:()=>({alert:async()=>{},confirm:async()=>true})};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var External=load(path.join(root,'renderer/components/ExternalPlayerModal.tsx')).ExternalPlayerModal;
      var Control=load(path.join(root,'renderer/components/TorrentControlModal.tsx')).TorrentControlModal,parentClosed=0;
      var externalClosed=0,externalLaunched=0,reactRoot=ReactDOM.createRoot(document.getElementById('root'));
      function mount(){reactRoot.render(React.createElement(External,{downloadId:'test',relativePath:${JSON.stringify(name)},position:12.5,onClose:()=>{externalClosed++;reactRoot.render(null)},onOpened:()=>externalLaunched++}));}
      function button(key){return [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===translate(key));}
      mount();
    `;
    await run(bootstrap); await wait(`button('external.open')&&!button('external.open').disabled`);
    assert.ok(await run(`document.body.textContent.includes(translate('external.defaultPosition'))`));
    await run(`button('external.choose').click()`); await wait(`!button('external.choose').disabled`); assert.equal(player.getConfig().kind, 'default');
    picker = 'select'; await run(`button('external.choose').click()`); await wait(`document.querySelector('.external-player-selected strong')?.textContent==='mpv'&&!button('external.open').disabled`);
    assert.equal(await run(`document.querySelector('.external-player-resume input').checked`), true);
    await capture('external-1050.png');
    win.setSize(440, 720); await new Promise(r => setTimeout(r, 100)); assert.ok(await run(`document.documentElement.scrollWidth<=innerWidth`));
    assert.ok(await run(`document.querySelector('.um-card').getBoundingClientRect().right<=innerWidth`));
    await capture('external-440.png');
    // A fresh service and Store read the persisted application selection.
    player = new Player({ ...dependencies, read: () => new Store({ name: 'external-player-fixture' }).get('preferences') });
    assert.equal(player.getConfig().executable, mpv);
    await run(`button('external.open').click()`); await wait(`externalLaunched===1&&externalClosed===1`);
    const received = path.join(folder, 'received.txt'); assert.deepEqual(fs.readFileSync(received, 'utf8').trim().split(/\r?\n/), ['--start=12.5', '--', disk]);
    fs.unlinkSync(received); assert.deepEqual(await player.open('test', name, 12.5), { ok: true, kind: 'mpv', startTime: 12.5 });
    assert.ok(fs.existsSync(received)); fs.unlinkSync(received);
    assert.equal(player.select(vlc).ok, true); await player.open('test', name, 12.5);
    assert.deepEqual(fs.readFileSync(received, 'utf8').trim().split(/\r?\n/), ['--start-time=12.5', disk]); fs.unlinkSync(received);
    // Missing player: keep the choice and expose a recoverable error in the UI.
    fs.renameSync(vlc, vlc + '.saved'); await run(`mount()`);
    await wait(`document.body.textContent.includes(translate('external.error.missing-player'))`); assert.equal(await run(`button('external.open').disabled`), true);
    fs.renameSync(vlc + '.saved', vlc); await run(`button('common.cancel').click()`); await wait(`!button('external.open')`);
    await run(`mount()`); await wait(`!button('external.open').disabled`);
    await run(`button('external.default').click()`); await wait(`document.querySelector('.external-player-selected strong')?.textContent===translate('external.default')`);
    systemError = 'No association'; await run(`button('external.open').click()`);
    await wait(`document.body.textContent.includes(translate('external.error.launch-failed'))`);
    assert.equal(await run(`externalLaunched`), 1); assert.equal(systemCalls.at(-1), disk);
    // A file may disappear after the readiness check. Do not launch or resume it.
    fs.unlinkSync(disk); systemError = ''; await run(`button('external.open').click()`);
    await wait(`document.body.textContent.includes(translate('external.error.missing-file'))`); assert.equal(await run(`externalLaunched`), 1);
    await run(`button('common.cancel').click()`); await wait(`!button('external.open')`);
    fs.writeFileSync(disk, '0123456789'); d.progress = 0.5; files = [{ ...files[0], downloaded: 5, progress: 0.5 }]; await run(`mount()`);
    await wait(`document.body.textContent.includes(translate('external.error.paused-file'))`); assert.equal(await run(`button('external.open').disabled`), true);
    await run(`button('common.cancel').click()`); await wait(`!button('external.open')`);
    d.status = 'downloading'; await run(`mount()`);
    await wait(`document.body.textContent.includes(translate('external.streaming'))`);
    assert.equal(await run(`button('external.open').disabled`), true);
    picker = 'select'; exe = mpv; await run(`button('external.choose').click()`); await wait(`!button('external.open').disabled`);
    await capture('external-stream-440.png');
    await run(`button('external.open').click()`); await wait(`!button('external.open')`);
    assert.equal(player.sessions().length, 1);
    for (let i=0;i<50&&!fs.existsSync(received);i++) await new Promise(r=>setTimeout(r,100));
    const receivedStream = fs.readFileSync(received, 'utf8').trim().split(/\r?\n/).at(-1); assert(receivedStream.startsWith('http://127.0.0.1:'));
    assert.equal(await (await fetch(receivedStream,{headers:{Range:'bytes=7-9'}})).text(),'789');
    await run(`reactRoot.render(React.createElement(load(path.join(root,'renderer/components/ExternalPlayerSessions.tsx')).ExternalPlayerSessions));`);
    await wait(`!!button('external.stop')`); await capture('external-sessions-440.png');
    await run(`button('external.stop').click()`); await wait(`!button('external.stop')`);
    assert.equal(player.sessions().length,0); await assert.rejects(fetch(receivedStream)); assert.equal(d.status,'downloading');
    d.status = 'paused';
    d.progress = 1; files = [{ ...files[0], downloaded: 10, progress: 1 }];
    await run(`reactRoot.render(React.createElement(Control,{download:${JSON.stringify(d)},onClose:()=>parentClosed++}));`);
    await wait(`!!button('downloads.files')`); await run(`button('downloads.files').click()`);
    await wait(`!!document.querySelector('.tcm-file-external')`); await run(`document.querySelector('.tcm-file-external').click()`);
    await wait(`button('external.open')&&!button('external.open').disabled`);
    // A parent dialog must not steal Tab focus from the nested player picker.
    assert.ok(await run(`button('external.choose').focus();button('external.choose').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));document.activeElement===button('external.choose')`));
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await wait(`!button('external.open')`);
    assert.equal(await run(`parentClosed`), 0); assert.ok(await run(`!!document.querySelector('.tcm-file-external')`));
    assert.equal(starts, 0); assert.equal(d.status, 'paused');
    player.select(mpv); assert.equal((await player.open('test', name, 123.456)).ok, true);
    assert.equal(fs.existsSync(path.join(folder, 'after-owner-exit.txt')), false, 'The external process must still be alive when its owner exits');
    console.log('PASS external player: real Windows argv launch for mpv/VLC templates, Unicode/spaces/shell characters, persisted selection, picker cancellation, missing app/file, missing association, partial paused/active files, real scoped stream Range and UI revocation, 1050/440 layout; screenshots: ' + out);
    player.close(); history.close(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); history?.close(); clearTimeout(deadline); app.exit(1); });
}
