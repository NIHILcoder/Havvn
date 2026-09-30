// Real media playback plus deterministic gaps/stalls in an isolated Electron.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-buffer-'));
  app.setPath('userData', path.join(out, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('buffer UI deadline'); app.exit(1); }, 55000);
  app.whenReady().then(async () => {
    require('node:child_process').execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=10', '-t', '6', '-c:v', 'libvpx', '-an', path.join(out, 'clip.webm')], { windowsHide: true });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/StreamPlayerModal.css', 'renderer/components/PlayerControls.css', 'renderer/components/MediaBufferStatus.css', 'renderer/components/EpisodePrefetchControl.css'].map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const file = path.join(out, 'preview.html');
    fs.writeFileSync(file, '<html><style>' + css + 'body{margin:0;padding:16px;background:#101114}video{width:100%;height:240px;display:block;background:black}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1000, height: 550, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(file);
    const run = code => win.webContents.executeJavaScript(code);
    const wait = () => new Promise(resolve => setTimeout(resolve, 160));
    await run(`
      var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),cache={};
      window.subscribers=[];window.api={getDownloads:async()=>[{id:'test',status:'completed',progress:1,totalSize:100,peers:0,downSpeedBps:0}],onDownloadStats:fn=>{subscribers.push(fn);return()=>{subscribers=subscribers.filter(f=>f!==fn)}}};
      window.prefetchCalls=[];window.prefetchStops=[];window.nativeMode=false;
      window.api.getEpisodePrefetchSupport=async()=>({supported:!nativeMode});
      window.api.prefetchEpisode=async(id,request)=>{prefetchCalls.push({id,...request});return{state:'active',bytes:request.budgetBytes}};
      window.api.stopEpisodePrefetch=async(id,lease)=>{prefetchStops.push({id,lease})};
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const source=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',source)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t:k=>dict[k]||k})};if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var Status=load(path.join(root,'renderer/components/MediaBufferStatus.tsx')).MediaBufferStatus,Controls=load(path.join(root,'renderer/components/PlayerControls.tsx')).PlayerControls;
      var Prefetch=load(path.join(root,'renderer/components/EpisodePrefetchControl.tsx')).EpisodePrefetchControl;
      function Demo(){const [media,setMedia]=React.useState(null);return React.createElement('div',{className:'player-modal'},React.createElement('div',{className:'player-header'},'Series S01E01.webm'),React.createElement('div',{className:'player-body'},React.createElement('div',{className:'player-stage'},React.createElement('video',{className:'player-video',src:'clip.webm',ref:setMedia}),React.createElement(Controls,{media}),React.createElement(Status,{media,downloadId:'test'}))),React.createElement(Prefetch,{media,downloadId:'test',currentFile:0,nextFile:1,nextName:'Series S01E02.webm'}),React.createElement('div',{className:'player-files'},'S01E01 / S01E02'));}
      window.reactRoot=ReactDOM.createRoot(document.getElementById('root'));reactRoot.render(React.createElement(Demo));
    `);
    await wait();
    await run(`window.video=document.querySelector('video');new Promise((resolve,reject)=>{if(video.readyState>=3)return resolve();video.addEventListener('canplay',resolve,{once:true});setTimeout(()=>reject(Error('real clip not ready')),8000)});`);
    await run(`video.play()`); await wait();
    assert.equal(await run(`document.querySelector('.media-buffer-phase').textContent`), 'Воспроизведение');
    assert.ok(await run(`parseInt(document.querySelector('.media-buffer-ahead').textContent.match(/\\d+/)[0])>=4`));
    await run(`video.pause()`); await wait();
    assert.equal(await run(`document.querySelector('.media-buffer-phase').textContent`), 'Просмотр на паузе');
    // A real DOM media element with controlled event snapshots to test ranges
    // that would require unreliable network timing to reproduce otherwise.
    await run(`
      for(const [key,value] of Object.entries({currentTime:5,duration:100,readyState:2,paused:false,seeking:false,ended:false,buffered:{length:2,start:i=>[0,50][i],end:i=>[10,80][i]}}))Object.defineProperty(video,key,{configurable:true,value});
      window.stats={id:'test',status:'downloading',progress:0.4,peers:0,downSpeedBps:0};subscribers.forEach(fn=>fn([stats]));video.dispatchEvent(new Event('waiting'));video.dispatchEvent(new Event('progress'));
    `); await wait();
    assert.equal(await run(`document.querySelector('.media-buffer-ahead').textContent`), 'Доступно впереди: 5 с');
    assert.equal(await run(`document.querySelector('.media-buffer-phase').textContent`), 'Ожидание пиров раздачи…');
    assert.deepEqual(await run(`[...document.querySelectorAll('.pc-buffer')].map(e=>[e.style.left,e.style.width])`), [['0%', '10%'], ['50%', '30%']]);
    await run(`Object.defineProperty(video,'currentTime',{configurable:true,value:20});Object.defineProperty(video,'seeking',{configurable:true,value:true});video.dispatchEvent(new Event('seeking'))`); await wait();
    assert.equal(await run(`document.querySelector('.media-buffer-ahead').textContent`), 'Доступно впереди: 0 с');
    assert.equal(await run(`document.querySelector('.media-buffer-phase').textContent`), 'Переход к выбранному участку видео…');
    await run(`Object.defineProperty(video,'seeking',{configurable:true,value:false});stats.status='paused';subscribers.forEach(fn=>fn([stats]));video.dispatchEvent(new Event('seeked'));`); await wait();
    assert.ok((await run(`document.querySelector('.media-buffer-phase').textContent`)).startsWith('Загрузка на паузе'));
    await run(`Object.defineProperty(video,'error',{configurable:true,value:{code:3}});video.dispatchEvent(new Event('error'));`); await wait();
    assert.ok((await run(`document.querySelector('.media-buffer-phase').textContent`)).includes('декодировать'));
    // Prefetch remains opt-in and stops as soon as the current playback stalls.
    assert.equal(await run(`prefetchCalls.length`), 0);
    await run(`
      for(const [key,value] of Object.entries({error:null,currentTime:900,duration:1000,readyState:4,paused:false,seeking:false,buffered:{length:1,start:()=>0,end:()=>950}}))Object.defineProperty(video,key,{configurable:true,value});
      document.querySelector('.episode-prefetch').open=true;
      document.querySelector('.episode-prefetch input[type=checkbox]').click();video.dispatchEvent(new Event('canplay'));
    `); await wait();
    assert.ok(await run(`prefetchCalls.some(r=>r.currentFile===0&&r.nextFile===1&&r.budgetBytes===64*1024*1024&&!r.allowExcluded)`));
    const stopsBeforeStall = await run(`prefetchStops.length`);
    await run(`video.dispatchEvent(new Event('waiting'));`); await wait();
    assert.ok(await run(`prefetchStops.length>${stopsBeforeStall}`));
    const callsAtStall = await run(`prefetchCalls.length`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await run(`prefetchCalls.length`), callsAtStall);
    await run(`video.dispatchEvent(new Event('canplay'))`); await wait();
    assert.ok(await run(`prefetchCalls.length>${callsAtStall}`));
    await run(`Object.defineProperty(video,'paused',{configurable:true,value:true});video.dispatchEvent(new Event('pause'))`); await wait();
    const callsAtPause = await run(`prefetchCalls.length`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await run(`prefetchCalls.length`), callsAtPause);
    await run(`Object.defineProperty(video,'paused',{configurable:true,value:false});Object.defineProperty(video,'seeking',{configurable:true,value:true});video.dispatchEvent(new Event('seeking'))`); await wait();
    assert.equal(await run(`prefetchCalls.length`), callsAtPause);
    await run(`Object.defineProperty(video,'seeking',{configurable:true,value:false});video.dispatchEvent(new Event('seeked'));var select=document.querySelector('.episode-prefetch select');select.value='16';select.dispatchEvent(new Event('change',{bubbles:true}));`); await wait();
    assert.equal(await run(`prefetchCalls.at(-1).budgetBytes`), 16*1024*1024);
    await run(`document.querySelectorAll('.episode-prefetch input[type=checkbox]')[1].click()`); await wait();
    assert.equal(await run(`prefetchCalls.at(-1).allowExcluded`), true);
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.player.episodePrefetch.v1')).budgetMiB`), 16);
    for (const width of [1000, 400]) {
      win.setContentSize(width, 550); await wait();
      assert.equal(await run(`document.querySelector('.media-buffer-status').scrollWidth>document.querySelector('.media-buffer-status').clientWidth`), false);
      assert.equal(await run(`document.querySelector('.episode-prefetch').scrollWidth>document.querySelector('.episode-prefetch').clientWidth`), false);
      assert.equal(await run(`document.querySelector('.player-files').getBoundingClientRect().bottom<=document.querySelector('.player-modal').getBoundingClientRect().bottom+1`), true);
      assert.equal(await run(`document.querySelector('.pc').getBoundingClientRect().bottom<=document.querySelector('.episode-prefetch').getBoundingClientRect().top+1`), true);
      fs.writeFileSync(path.join(out, 'buffer-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await run(`reactRoot.unmount()`); await wait();
    assert.equal(await run(`subscribers.length`), 0);
    const callsAfterClose = await run(`prefetchCalls.length`);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await run(`prefetchCalls.length`), callsAfterClose);
    await run(`window.nativeMode=true;window.reactRoot=ReactDOM.createRoot(document.getElementById('root'));reactRoot.render(React.createElement(Prefetch,{media:video,downloadId:'test',currentFile:0,nextFile:1}));`); await wait();
    assert.equal(await run(`document.querySelector('.episode-prefetch input').disabled`), true);
    assert.equal(await run(`document.querySelector('.episode-prefetch input').checked`), false);
    assert.equal(await run(`prefetchCalls.length`), callsAfterClose);
    await run(`reactRoot.unmount()`);
    await run(`window.nativeMode=false;window.reactRoot=ReactDOM.createRoot(document.getElementById('root'));reactRoot.render(React.createElement(Prefetch,{media:video,downloadId:'test',currentFile:0,nextFile:1}));`); await wait();
    assert.equal(await run(`document.querySelector('.episode-prefetch input').checked`), true);
    assert.equal(await run(`document.querySelector('.episode-prefetch select').value`), '16');
    await run(`reactRoot.unmount()`);
    console.log('PASS real WebM, buffer gaps, seek, peers, download pause, decode error; prefetch opt-in, stalls, pause, seek, budgets, persistence, Native limit, layout and cleanup');
    console.log('Screenshots:', out);
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
}
