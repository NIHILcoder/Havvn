// Full player UI, real multi-audio MP4 and native HTTP/FFmpeg in a temporary profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-player-prefs-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const deadline = setTimeout(() => { console.error('player preferences deadline'); app.exit(1); }, 55000);
  app.on('window-all-closed', () => {});
  let server;
  app.whenReady().then(async () => {
    const ffmpeg = require('ffmpeg-static'), exec = require('node:child_process').execFileSync;
    fs.writeFileSync(path.join(out, 'source.ru.srt'), '1\n00:00:01,000 --> 00:00:02,000\nEarly caption\n\n2\n00:00:04,000 --> 00:00:06,000\nLater caption\n');
    const first = path.join(out, 'S01E01.mp4'), second = path.join(out, 'S01E02.mp4');
    exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=10:d=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-i', path.join(out, 'source.ru.srt'),
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'mov_text',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=rus', '-metadata:s:s:0', 'language=rus',
      '-disposition:a:0', 'default', '-disposition:a:1', '0', '-movflags', '+faststart', '-t', '8', first], { windowsHide: true, timeout: 15000 });
    exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', first, '-map', '0:v', '-map', '0:a:1', '-map', '0:a:0', '-map', '0:s', '-c', 'copy', '-movflags', '+faststart', second], { windowsHide: true, timeout: 15000 });
    const audio = require(path.join(root, 'dist/electron/electron/torrent/audio-probe.js'));
    const subs = require(path.join(root, 'dist/electron/electron/torrent/subtitle-probe.js'));
    const disk = [first, second];
    const catalogs = await Promise.all(disk.map(async p => audio.audioTrackList(await audio.probeAudioStreams(ffmpeg, p))));
    const subtitles = await Promise.all(disk.map(p => subs.listSubtitleTracks(ffmpeg, p)));
    const vtts = await Promise.all(disk.map((p, i) => subs.getSubtitleVtt(ffmpeg, p, subtitles[i].find(track => track.source === 'embedded').key)));
    const { NativeMediaServer } = require(path.join(root, 'dist/electron/electron/torrent/native/media-server.js'));
    server = new NativeMediaServer((_id, i) => ({ diskPath: disk[i], length: fs.statSync(disk[i]).size, name: path.basename(disk[i]), kind: 'video' }),
      () => ffmpeg, async (_id, i) => fs.statSync(disk[i]).size, 'test-token');
    const port = await server.ensure();
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/StreamPlayerModal.css',
      'renderer/components/PlayerControls.css', 'renderer/components/MediaBufferStatus.css', 'renderer/components/EpisodePrefetchControl.css', 'renderer/components/PlayerPreferencesPanel.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(out, 'preview.html'); fs.writeFileSync(page, '<html><style>' + css + 'body{background:#101114}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(page);
    const run = code => win.webContents.executeJavaScript(code);
    const wait = async expression => {
      const until = Date.now() + 12000;
      while (Date.now() < until) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 80)); }
      console.error(await run(`JSON.stringify({calls:calls.slice(-5),menus:[...document.querySelectorAll('.player-sub-item')].map(b=>b.textContent),errors:[...document.querySelectorAll('.player-message')].map(e=>e.textContent),prefs:localStorage.getItem('havvn.player.preferences.v1'),media:{time:document.querySelector('video')?.currentTime,duration:document.querySelector('video')?.duration,tracks:[...document.querySelector('video')?.textTracks||[]].map(tr=>({mode:tr.mode,cues:[...tr.cues||[]].map(c=>({text:c.text,start:c.startTime,end:c.endTime})),active:[...tr.activeCues||[]].map(c=>c.text)}))}})`));
      fs.writeFileSync(path.join(out, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      throw Error('UI wait failed: ' + expression);
    };
    await run(`
      var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),translate=k=>dict[k]||k,cache={};
      var catalogs=${JSON.stringify(catalogs)},subtitles=${JSON.stringify(subtitles)},vtts=${JSON.stringify(vtts)},calls=[],subscribers=[],toasts=[];
      window.api={getDownloads:async()=>[{id:'test',infoHash:'abc',status:'completed',progress:1,peers:0}],
        getTorrentFiles:async()=>[{name:'S01E01.mp4',path:'Season1/S01E01.mp4',length:200000},{name:'S01E02.mp4',path:'Season1/S01E02.mp4',length:100000}],
        getStreamUrl:async(id,i,opts)=>{calls.push({i,...opts});var mode=opts.transcode?'transcode':'direct',offset=opts.transcode?Math.round(opts.startTime*1000)/1000:0;
          return{url:'http://127.0.0.1:${port}/'+mode+'/test/'+i+'?k=test-token&t='+Date.now()+(opts.audioTrack===undefined?'':'&a='+opts.audioTrack)+'&s='+offset,name:'episode',kind:'video',transcoded:!!opts.transcode,startTime:offset};},
        audioTracks:{list:async(id,i)=>catalogs[i]},subtitles:{list:async(id,i)=>subtitles[i],get:async(id,i)=>vtts[i]},
        stopStream:async()=>{},getEpisodePrefetchSupport:async()=>({supported:false}),stopEpisodePrefetch:async()=>{},
        onDownloadStats:fn=>{subscribers.push(fn);return()=>{subscribers=subscribers.filter(f=>f!==fn)}}};
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const source=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',source)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t:translate})};
          if(s.endsWith('/popout'))return{usePopout:()=>({popout:null,portal:()=>null,openPopout:()=>false,closePopout:()=>{}})};
          if(s.includes('dockWindowChrome'))return{useDockWindowMaximized:()=>false};if(s==='./QRCode')return{QRCode:()=>null};if(s.includes('WindowControls'))return{WindowControls:()=>null};
          if(s==='react-hot-toast')return{__esModule:true,default:Object.assign(()=>{},{error:message=>toasts.push(message)})};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var Player=load(path.join(root,'renderer/components/StreamPlayerModal.tsx')).StreamPlayerModal;
      function mount(){window.reactRoot=ReactDOM.createRoot(document.getElementById('root'));reactRoot.render(React.createElement(Player,{downloadId:'test',downloadName:'Series',onClose:()=>{}}));}
      function button(title){return [...document.querySelectorAll('button')].find(b=>b.title===translate(title));}
      function item(text){return [...document.querySelectorAll('.player-sub-item')].find(b=>b.textContent.trim().replace(/ ●$/,'')===text);}
      function setSelect(label,value){const node=[...document.querySelectorAll('.player-preferences label')].find(l=>l.textContent.startsWith(translate(label))).querySelector('select');node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));}
      mount();
    `);
    await wait(`document.querySelector('video')?.readyState>=3&&!!button('player.audioTracks')`);
    await run(`window.oldVideo=document.querySelector('video');oldVideo.pause();oldVideo.currentTime=2.5;oldVideo.volume=0.4;oldVideo.playbackRate=1.25;button('player.audioTracks').click();`);
    await wait(`!!item(catalogs[0][1].label)`);
    await run(`item(catalogs[0][1].label).click()`);
    await wait(`document.querySelector('video')!==oldVideo&&document.querySelector('video')?.readyState>=3&&document.querySelector('video').paused`);
    assert.equal(await run(`calls.at(-1).audioTrack`), 1);
    assert.ok(Math.abs(await run(`calls.at(-1).startTime`) - 2.5) < 0.15);
    assert.ok(Math.abs(await run(`document.querySelector('video').volume`) - 0.4) < 0.01);
    assert.equal(await run(`document.querySelector('video').playbackRate`), 1.25);
    assert.equal(await run(`document.querySelector('.pc-time').textContent`), '0:02');
    await run(`button('player.subtitles').click()`);
    await wait(`!!item(subtitles[0].find(s=>s.source==='embedded').label)`);
    await run(`item(subtitles[0].find(s=>s.source==='embedded').label).click()`);
    await wait(`[...document.querySelector('video')?.textTracks[0]?.cues||[]].some(c=>c.text.includes('Later caption'))`);
    const cueBefore = await run(`[...document.querySelector('video').textTracks[0].cues].find(c=>c.text.includes('Later caption')).startTime`);
    await run(`document.querySelector('.player-preferences').open=true;var delay=document.querySelector('.player-preferences input[type=number]');var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(delay,'1');delay.dispatchEvent(new Event('input',{bubbles:true}));`);
    await wait(`JSON.parse(localStorage.getItem('havvn.player.preferences.v1')).subtitleDelay===1`);
    assert.ok(Math.abs(await run(`[...document.querySelector('video').textTracks[0].cues].find(c=>c.text.includes('Later caption')).startTime`) - cueBefore - 1) < 0.01);
    await run(`var delay=document.querySelector('.player-preferences input[type=number]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(delay,'-0.5');delay.dispatchEvent(new Event('input',{bubbles:true}));setSelect('player.preferences.size','125');setSelect('player.preferences.background','none');`);
    await wait(`JSON.parse(localStorage.getItem('havvn.player.preferences.v1')).subtitleDelay===-0.5`);
    assert.ok(Math.abs(await run(`[...document.querySelector('video').textTracks[0].cues].find(c=>c.text.includes('Later caption')).startTime`) - cueBefore + 0.5) < 0.01);
    assert.ok(await run(`[...document.querySelectorAll('style')].some(s=>s.textContent.includes('::cue')&&s.textContent.includes('transparent'))`));
    assert.equal(await run(`[...document.querySelector('video').textTracks[0].activeCues||[]].some(c=>c.text.includes('Early caption'))`), false);
    await run(`var color=document.querySelector('.player-preferences input[type=color]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(color,'#ffee00');color.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.player-preferences').open=false;document.querySelector('video').play();`);
    await wait(`document.querySelector('video')?.textTracks[0]?.activeCues?.[0]?.text.includes('Later caption')&&JSON.parse(localStorage.getItem('havvn.player.preferences.v1')).subtitleColor==='#ffee00'`);
    fs.writeFileSync(path.join(out, 'styled-cue.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('video').pause();document.querySelector('.player-preferences').open=true;setSelect('player.preferences.subLanguage','ru');setSelect('player.preferences.subMode','auto');`);
    const switchPosition = await run(`document.querySelector('video').currentTime+calls.at(-1).startTime`);
    await run(`button('player.audioTracks').click()`); await wait(`!!item(translate('player.audioDefault'))`);
    await run(`window.oldVideo=document.querySelector('video');item(translate('player.audioDefault')).click()`);
    await wait(`document.querySelector('video')!==oldVideo&&document.querySelector('video')?.readyState>=3&&document.querySelector('video').paused`);
    assert.equal(await run(`calls.at(-1).transcode`), false);
    assert.ok(Math.abs(await run(`document.querySelector('video').currentTime`) - switchPosition) < 0.2);
    await run(`setSelect('player.preferences.audio','ru')`);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await run(`calls.at(-1).audioTrack===undefined`), true); // manual default beats general preference
    await run(`window.oldVideo=document.querySelector('video');[...document.querySelectorAll('.player-preferences-actions button')].find(b=>b.textContent===translate('player.preferences.resetFile')).click()`);
    await wait(`document.querySelector('video')!==oldVideo&&document.querySelector('video')?.readyState>=3&&calls.at(-1).audioTrack===1`);
    await wait(`!document.querySelector('video track')`); // Auto: Russian audio needs no Russian subtitles.
    await run(`[...document.querySelectorAll('.player-file-chip')].find(b=>b.textContent.includes('S01E02')).click()`);
    await wait(`calls.at(-1).i===1&&calls.at(-1).audioTrack===0&&document.querySelector('video')?.readyState>=3`);
    await run(`document.querySelector('video').pause();button('player.audioTracks').click()`); await wait(`!!item(catalogs[1][1].label)`);
    await run(`item(catalogs[1][1].label).click()`); await wait(`calls.at(-1).i===1&&calls.at(-1).audioTrack===1&&document.querySelector('video')?.readyState>=3`);
    await run(`reactRoot.unmount();mount()`);
    await wait(`calls.at(-1).i===0&&calls.at(-1).audioTrack===1&&document.querySelector('video')?.readyState>=3`);
    await run(`document.querySelector('video').pause();[...document.querySelectorAll('.player-file-chip')].find(b=>b.textContent.includes('S01E02')).click()`);
    await wait(`calls.at(-1).i===1&&calls.at(-1).audioTrack===1&&document.querySelector('video')?.readyState>=3`);
    await wait(`document.querySelector('video')?.textTracks[0]?.cues?.length>=2`); // Auto: English audio + Russian subtitles.
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.player.preferences.v1')).audioLanguage`), 'ru');
    await run(`document.querySelector('video').pause();document.querySelector('.player-preferences').open=true;`);
    for (const width of [1000, 440]) {
      win.setContentSize(width, 700); await new Promise(resolve => setTimeout(resolve, 160));
      fs.writeFileSync(path.join(out, 'preferences-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
      assert.equal(await run(`document.querySelector('.player-preferences').scrollWidth>document.querySelector('.player-preferences').clientWidth`), false);
      const controlsBottom = await run(`document.querySelector('.pc').getBoundingClientRect().bottom`);
      const preferencesTop = await run(`document.querySelector('.player-preferences').getBoundingClientRect().top`);
      assert.ok(controlsBottom <= preferencesTop + 1, JSON.stringify({width, controlsBottom, preferencesTop, out}));
    }
    await run(`reactRoot.unmount()`);
    assert.equal(await run(`subscribers.length`), 0);
    assert.equal(await run(`document.querySelectorAll('style').length`), 1); // cue style removed
    assert.equal(await run(`toasts.length`), 0);
    console.log('PASS real multi-audio playback, timestamp/pause/volume/rate, subtitle cues/delay/styles, default override, reordered episodes, per-file persistence, responsive layout and cleanup');
    console.log('Screenshots:', out);
    server.close(); win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); if (server) server.close(); app.exit(1); });
}
