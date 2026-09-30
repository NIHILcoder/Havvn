// Full history page + actual media/FFmpeg over the read-only playback service.
// Runs in a separate Electron profile; never opens the user's downloads/account.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-watch-history-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const deadline = setTimeout(() => { console.error('watch history deadline'); app.exit(1); }, 55000);
  app.on('window-all-closed', () => {}); let service;
  app.whenReady().then(async () => {
    const ffmpeg = require('ffmpeg-static');
    const source = path.join(out, 'S01E01.mp4'), second = path.join(out, 'S01E02.mp4');
    require('node:child_process').execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=10:d=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=15',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=rus', '-disposition:a:0', 'default', '-disposition:a:1', '0', '-movflags', '+faststart', source], { windowsHide: true, timeout: 15000 });
    fs.copyFileSync(source, second);
    let d = { id: 'test', infoHash: 'abc', name: 'Test series', status: 'paused', progress: 1, savePath: out, peers: 0 };
    let files = [source, second].map(p => ({ name: path.basename(p), path: path.basename(p), length: fs.statSync(p).size, downloaded: fs.statSync(p).size, progress: 1 }));
    const externalOpened = []; let externalKind = 'default';
    const cache = new Map(); let streamStarts = 0;
    service = new (require(path.join(root, 'dist/electron/electron/services/history-playback.js')).HistoryPlayback)({
      download: async id => d?.id === id ? d : null, files: async () => files,
      stream: async () => { streamStarts++; throw Error('Must not start torrents'); }, ffmpeg: () => ffmpeg,
      cached: k => cache.get(k) || [], cache: (k, f) => cache.set(k, f),
    });
    for (const method of ['files', 'stream', 'audio', 'subtitles', 'vtt', 'duration', 'stop']) ipcMain.handle('test:' + method, (_e, ...args) => service[method](...args));
    ipcMain.handle('test:downloads', () => d ? [d] : []);
    ipcMain.handle('test:externalConfig', () => ({ kind: externalKind, executable: externalKind === 'mpv' ? 'fixture-mpv' : null, available: true }));
    ipcMain.handle('test:externalTarget', (_e, id, rel) => service.watchTarget(id, rel));
    ipcMain.handle('test:externalOpen', async (_event, id, relativePath, position, session) => {
      const file = await service.localFile(id, relativePath); if (!file.ok) return file;
      externalOpened.push({ id, relativePath, position, session });
      const target = session ? await service.watchTarget(id, relativePath) : null;
      return { ok: true, kind: externalKind, startTime: position, ...(target ? { update: { id: 'handoff', session, entry: { ...target,
        position: 8, duration: 15, completed: false, lastOpened: Date.now(), updatedAt: Date.now() } } } : {}) };
    });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/pages/WatchHistoryPage.css',
      'renderer/components/StreamPlayerModal.css', 'renderer/components/PlayerControls.css', 'renderer/components/MediaBufferStatus.css', 'renderer/components/PlayerPreferencesPanel.css', 'renderer/components/Modal.css', 'renderer/components/ExternalPlayer.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(out, 'preview.html'); fs.writeFileSync(page, '<html><style>' + css + 'body{background:#101114}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1050, height: 720, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => console.log('[renderer]', event.message));
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { offscreen: true, backgroundThrottling: false } } }));
    await win.loadFile(page);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(error) { console.error('Failed renderer step:', code); throw error; } };
    const wait = async expression => {
      for (let i = 0; i < 100; i++) { if (await run(expression)) return; await new Promise(r => setTimeout(r, 100)); }
      fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.log('Failure state', await run(`JSON.stringify({calls,toasts,video:current()?{time:current().currentTime,ready:current().readyState,paused:current().paused}:null,error:document.querySelector('.player-message')?.textContent})`),out); throw Error('UI wait failed: ' + expression);
    };
    const bootstrap = `
      var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client')),portal=require(path.join(root,'node_modules/react-dom')).createPortal;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),translate=k=>dict[k]||k,cache={},ipc=require('electron').ipcRenderer;
      var calls=[],subscribers=[],toasts=[];
      var unavailable=()=>{throw Error('Normal torrent API must not run in history')};
      window.api={getDownloads:()=>ipc.invoke('test:downloads'),getTorrentFiles:unavailable,getStreamUrl:unavailable,
        stopStream:async()=>{},audioTracks:{list:unavailable},subtitles:{list:unavailable,get:unavailable},
        onDownloadStats:fn=>{subscribers.push(fn);return()=>{subscribers=subscribers.filter(f=>f!==fn)}}};
      window.api.historyPlayback=Object.fromEntries(['files','stream','audio','subtitles','vtt','duration','stop'].map(method=>[method, (...args)=>{if(method==='stream')calls.push(args);return ipc.invoke('test:'+method,...args)}]));
      window.api.externalPlayer={inspect:async()=> 'local',sessions:async()=>[],stop:async()=>{},watchTarget:(id,rel)=>ipc.invoke('test:externalTarget',id,rel),watchUpdates:async()=>[],acknowledgeWatch:async()=>{},getConfig:()=>ipc.invoke('test:externalConfig'),useDefault:()=>ipc.invoke('test:externalConfig'),choose:async()=>({ok:true,config:null}),open:(...args)=>ipc.invoke('test:externalOpen',...args).then(result=>{if(result.update)watchStore.applyExternalWatch(result.update);return result})};
      function usePopout(){const[child,setChild]=React.useState(null);return{popout:child,portal:body=>child?portal(React.createElement(load(path.join(root,'renderer/utils/hostWindow.tsx')).HostWindowProvider,{window:child},body),child.document.body):null,
        openPopout:()=>{const w=window.open('about:blank','history-player');if(!w)return false;w.document.head.innerHTML=document.head.innerHTML;window.testPopout=w;setChild(w);return true;},
        closePopout:()=>{setChild(null);child?.close();}}}
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const source=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',source)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t:translate,language:'ru'})};
          if(s.endsWith('/popout'))return{usePopout};if(s.includes('dockWindowChrome'))return{useDockWindowMaximized:()=>false};
          if(s.endsWith('ConfirmDialog'))return{useConfirm:()=>({confirm:async()=>true})};if(s==='./QRCode')return{QRCode:()=>null};if(s.includes('WindowControls'))return{WindowControls:()=>null};
          if(s==='react-hot-toast')return{__esModule:true,default:Object.assign(()=>{},{error:message=>toasts.push(message)})};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var History=load(path.join(root,'renderer/pages/WatchHistoryPage.tsx')).default,watchStore=load(path.join(root,'renderer/utils/watchHistory.ts'));
      var historyKey='havvn.watchHistory.v1';
      if(!localStorage.getItem(historyKey)){localStorage.clear();localStorage.setItem('playerAutoNext','1');localStorage.setItem('playPositions',JSON.stringify({'abc:0':{t:6,d:15,at:100}}));}
      function mount(){window.reactRoot=ReactDOM.createRoot(document.getElementById('root'));reactRoot.render(React.createElement(History));}
      function button(text,doc=document){return [...doc.querySelectorAll('button')].find(b=>b.textContent.trim()===translate(text)||b.title===translate(text));}
      function playerExternal(doc=document){return [...doc.querySelectorAll('.player-cast-btn')].find(b=>b.title===translate('external.title'));}
      function current(){return window.testPopout&&!testPopout.closed?testPopout.document.querySelector('video'):document.querySelector('video');}
      mount();
    `;
    await run(bootstrap);
    await wait(`document.querySelector('.watch-history-card')&&!!button('history.resume')&&!button('history.resume').disabled`);
    assert.ok((await run(`document.querySelector('.watch-history-meta').textContent`)).includes('0:06'));
    await run(`button('external.title').click()`); await wait(`button('external.open')&&!button('external.open').disabled`);
    await run(`button('common.cancel').click()`); await wait(`!button('external.open')`); assert.equal(await run(`!!current()`), false);
    await run(`button('history.resume').click()`);
    await wait(`current()?.readyState>=3&&current().currentTime>=6`);
    await run(`current().pause();current().currentTime=7;`);
    await wait(`watchStore.watchEntries()[0].position>=7`);
    await run(`playerExternal().click()`); await wait(`!!document.querySelector('.external-player-backdrop')`);
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await wait(`!document.querySelector('.external-player-backdrop')&&!!current()`);
    externalKind = 'mpv';
    await run(`playerExternal().click()`); await wait(`button('external.open')&&!button('external.open').disabled`);
    await run(`button('external.open').click()`); await wait(`!current()&&!document.querySelector('.external-player-backdrop')`);
    assert.equal(externalOpened.length, 1); assert.equal(externalOpened[0].relativePath, 'S01E01.mp4'); assert.ok(externalOpened[0].position >= 7);
    assert(externalOpened[0].session, 'The mpv handoff must pass a history guard');
    assert.equal(await run(`watchStore.watchEntries()[0].position`), 8, 'Closing the old builtin player cannot overwrite mpv history');
    externalKind = 'default';
    await run(`button('history.resume').click()`); await wait(`current()?.readyState>=3`); await run(`current().pause();current().currentTime=7`);
    assert.equal(await run(`calls[0][1]`), 0);
    assert.equal(await run(`calls[0][2].startTime`), 6);
    // Source remount must retain the absolute clock, including live transcoding.
    await wait(`!!button('player.audioTracks')`);
    await run(`button('player.audioTracks').click()`);
    await wait(`[...document.querySelectorAll('.player-sub-item')].some(b=>b.textContent.includes('RUS'))`);
    await run(`[...document.querySelectorAll('.player-sub-item')].find(b=>b.textContent.includes('RUS')).click()`);
    await wait(`current()?.readyState>=3&&current().paused&&calls.at(-1)[2].audioTrack===1`);
    assert.ok(Math.abs(await run(`calls.at(-1)[2].startTime`) - 7) < 0.15);
    const callCount = await run(`calls.length`);
    await run(`current().dispatchEvent(new Event('ended'))`);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await run(`calls.length`), callCount, 'Truncated transcode must not advance to another episode');
    await run(`button('player.detach').click()`);
    await wait(`window.testPopout?.document.querySelector('video')?.readyState>=3`);
    await run(`playerExternal(testPopout.document).click()`);
    await wait(`!!testPopout.document.querySelector('.external-player-backdrop')`);
    assert.equal(await run(`!!document.querySelector('.external-player-backdrop')`), false);
    await run(`testPopout.dispatchEvent(new testPopout.KeyboardEvent('keydown',{key:'Escape'}))`);
    await wait(`!testPopout.document.querySelector('.external-player-backdrop')&&!!testPopout.document.querySelector('video')`);
    assert.ok((await run(`watchStore.watchEntries()[0].position`)) >= 6.8);
    await run(`button('player.attach',testPopout.document).click()`);
    await wait(`document.querySelector('video')?.readyState>=3&&document.querySelector('video').paused`);
    await run(`reactRoot.unmount()`);
    d = { ...d, id: 'readded', name: 'Renamed series' }; files.reverse();
    await win.loadFile(page); await run(bootstrap); // new renderer realm, persistent position/track choices

    await wait(`!!button('history.resume')&&!button('history.resume').disabled`);
    assert.equal(await run(`document.querySelector('.watch-history-card h2').textContent`), 'Renamed series');
    fs.writeFileSync(path.join(out, 'history-1050.png'), (await win.webContents.capturePage()).toPNG());
    await run(`button('history.resume').click()`);
    await wait(`current()?.readyState>=3`);
    assert.equal(await run(`calls.at(-1)[1]`), 1); // path wins over the stale index
    assert.ok((await run(`calls.at(-1)[2].startTime`)) >= 6.8);
    await run(`current().play()`); await run(`playerExternal().click()`);
    await wait(`!!document.querySelector('.external-player-backdrop')&&current().paused`);
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await wait(`!document.querySelector('.external-player-backdrop')&&!current().paused`);
    await run(`document.querySelector('.player-close').click()`);
    await wait(`!document.querySelector('video')`);
    await run(`button('history.markWatched').click()`);
    await wait(`!document.querySelector('.watch-history-card')`);
    await run(`document.querySelectorAll('[role=tab]')[1].click()`);
    await wait(`!!button('history.replay')`);
    await run(`button('history.start').click()`);
    await wait(`current()?.readyState>=3`);
    assert.ok((await run(`calls.at(-1)[2].startTime`)) < 0.2); // default audio may play a frame before the saved track is selected
    await run(`document.querySelector('.player-close').click();reactRoot.unmount();`);
    // Windows releases FFmpeg's input handle shortly after the close IPC arrives.
    await service.stop(d.id);
    for (let i = 0; i < 20; i++) {
      try { fs.unlinkSync(source); break; } catch (error) { if (error.code !== 'EBUSY' || i === 19) throw error; await new Promise(r => setTimeout(r, 50)); }
    }
    await run(`mount()`);
    await wait(`document.querySelector('.watch-history-card')&&!!button('history.resume')&&button('history.resume').disabled`);
    win.setSize(440, 720);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(await run(`document.documentElement.scrollWidth<=innerWidth`));
    fs.writeFileSync(path.join(out, 'history-440.png'), (await win.webContents.capturePage()).toPNG());
    await run(`button('history.clear').click()`);
    await wait(`watchStore.watchEntries().length===0&&!document.querySelector('.watch-history-card')`);
    await run(`reactRoot.unmount();mount()`);
    await wait(`!!document.querySelector('.watch-history-empty')`);
    assert.equal(await run(`watchStore.watchEntries().length`), 0); assert.equal(streamStarts, 0);
    console.log('PASS watch history: migration, renderer restart, resume, paused local file, tracks, popout, external handoff/pause/cancel/Escape in both windows, truncated end, re-add/index/name, watched/start, missing file, clear, 1050/440 layout; screenshots: ' + out);
    service.close(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); service?.close(); clearTimeout(deadline); app.exit(1); });
}
