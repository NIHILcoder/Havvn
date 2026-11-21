// Actual React controls and Electron desktop capture, using an isolated profile
// and only an owned synthetic window. No user's screen or microphone is captured.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, desktopCapturer } = require('electron');
  const { pathToFileURL } = require('node:url');
  const root = path.resolve(__dirname, '..'), out = path.resolve(root, process.env.HAVVN_SCREEN_SHARE_ARTIFACTS || 'artifacts/screen-share-settings-20261031');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const windows = [], result = { runtime: process.versions.electron, ui: [], capture: [], microphoneUsed: false, captureSource: 'owned synthetic window only' };
  const deadline = setTimeout(() => { console.error('Screen settings smoke deadline'); app.exit(1); }, 60000);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    const styles = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/ScreenShare.css'];
    const css = require('./smoke-ui-fonts.cjs')(root) + styles.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(out, 'ui.html');
    fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 900, height: 820, useContentSize: true, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    windows.push(win);
    win.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
    await win.loadFile(page);
    const run = code => win.webContents.executeJavaScript(`try { ${code} } catch (e) { console.error(e.stack || String(e)); throw e; }`);
    await run(`var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),pr=require('node:module').createRequire(path.join(root,'package.json')),ts=pr('typescript'),React=pr('react'),dom=pr('react-dom'),createRoot=pr('react-dom/client').createRoot,cache={};
      var language='ru',dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'))),selectedCalls=[],closed=0,sourceFailure=false;
      var sources=[{id:'screen:1:0',name:'Test screen',display:true,thumbnail:'',systemAudioSupported:true},{id:'window:12:0',name:'Synthetic window',display:false,thumbnail:'',systemAudioSupported:true}];
      window.api={rooms:{screen:{sources:async()=>{if(sourceFailure)throw Error('fixture sources failure');return sources;}}}};
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return {};if(name.includes('i18nContext'))return {useTranslation:()=>({t:key=>dict[key]||key,language})};if(name.includes('hostToast'))return {useHostToast:()=>({error:()=>{}})};if(name.startsWith('.')){var base=path.resolve(path.dirname(file),name);for(var ext of ['.ts','.tsx'])if(fs.existsSync(base+ext))return load(base+ext);throw Error('Missing fixture module '+base);}return pr(name);},m,m.exports);return m.exports;}
      var Picker=load(path.join(root,'renderer/components/ScreenShare.tsx')).ScreenSourcePicker,tree;
      function mount(){if(tree)dom.flushSync(()=>tree.unmount());tree=createRoot(document.querySelector('#root'));dom.flushSync(()=>tree.render(React.createElement(Picker,{onClose:()=>closed++,onPick:(...args)=>selectedCalls.push(args),bitrateLimitKbps:2500})));}
      function setLanguage(value){language=value;dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/'+value+'.json')));document.documentElement.lang=value;}
      function choose(index,value){dom.flushSync(()=>document.querySelectorAll('[role=combobox]')[index].click());var option=[...document.querySelectorAll('[role=option]')].find(el=>el.textContent===value);if(!option)throw Error('Missing option '+value);dom.flushSync(()=>option.click());}
      mount();true;`);
    for (const language of ['ru', 'en']) for (const width of [360, 640, 900]) {
      win.setContentSize(width, 820);
      await run(`setLanguage('${language}');mount();true;`); await pause(200);
      const geometry = await run(`(()=>{const dialog=document.querySelector('[role=dialog]'),r=dialog.getBoundingClientRect();return {inside:r.left>=-1&&r.right<=innerWidth+1,selectors:document.querySelectorAll('[role=combobox]').length,startDisabled:document.querySelector('.ssp-footer .btn').disabled,overflow:dialog.scrollWidth>dialog.clientWidth+1};})()`);
      assert(geometry.inside && !geometry.overflow && geometry.selectors === 3 && geometry.startDisabled, JSON.stringify(geometry));
      result.ui.push({ language, width, ...geometry });
      if (language === 'ru' && width === 900) fs.writeFileSync(path.join(out, 'picker-ru.png'), (await win.webContents.capturePage()).toPNG());
      if (language === 'en' && width === 360) fs.writeFileSync(path.join(out, 'picker-en-narrow.png'), (await win.webContents.capturePage()).toPNG());
    }
    await run(`choose(0,'720p');true;`); await pause(100);
    await run(`choose(1,'60 FPS');true;`); await pause(100);
    await run(`choose(2,'1 '+dict['rooms.screen.mbps']);true;`); await pause(100);
    await run(`document.querySelector('.ssp-audio input').click();document.querySelectorAll('.ssp-tile')[1].click();true;`); await pause(100);
    await run(`document.querySelector('.ssp-footer .btn').click();true;`); await pause(100);
    assert.deepEqual(await run('selectedCalls'), [['window:12:0', true, { height: 720, fps: 60, bitrateKbps: 1000 }]]);
    result.selectionReachesStartCallback = true;
    await run('mount();true;'); await pause(150);
    assert.deepEqual(await run(`[...document.querySelectorAll('[role=combobox]')].map(el=>el.textContent.trim())`), ['720p', '60 FPS', '1 Mbit/s']);
    assert.equal(await run('document.querySelector(".ssp-audio input").checked'), false);
    result.qualityRememberedAndAudioOptInReset = true;
    await run(`sources=sources.map(s=>({...s,systemAudioSupported:false}));mount();true;`); await pause(150);
    assert.equal(await run('document.querySelector(".ssp-audio input").disabled'), true);
    result.linuxAudioToggleDisabled = true;
    await run(`document.querySelector('.ssp-tile').click();true;`); await pause(100);
    await run(`sources=[];document.querySelector('.ssp-refresh').click();true;`); await pause(150);
    assert.equal(await run('document.querySelector(".ssp-footer .btn").disabled'), true);
    result.removedSourceCannotStart = true;
    await run(`sourceFailure=true;document.querySelector('.ssp-refresh').click();true;`); await pause(150);
    assert.equal(await run('!!document.querySelector(".ssp-error[role=alert]")'), true);
    result.sourceErrorShown = true;

    // Capture only our own visible fixture, through the actual room engine policy.
    const title = 'Havvn owned quality fixture';
    const fixture = new BrowserWindow({ width: 1100, height: 750, show: true, focusable: false, skipTaskbar: true, title, webPreferences: { sandbox: true } });
    windows.push(fixture);
    await fixture.loadURL('data:text/html,' + encodeURIComponent('<title>' + title + '</title><body style="background:#16324f;color:white;font:32px sans-serif">Havvn synthetic capture quality</body>'));
    const source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find(s => s.name === title);
    assert(source, 'owned fixture must be capturable');
    const engine = new BrowserWindow({ show: false, webPreferences: { partition: 'quality-capture-fixture', sandbox: true, contextIsolation: true } });
    windows.push(engine);
    const enginePage = path.join(root, 'dist/electron/electron/sharing/room-engine.html');
    require(path.join(root, 'dist/electron/electron/sharing/room-engine-policy.js')).installRoomEnginePolicy(engine, pathToFileURL(enginePage).href, () => ({ audio: false, video: true }));
    await engine.loadFile(enginePage);
    const quality = require(path.join(root, 'dist/electron/shared/screen-share.js'));
    const voiceSource = fs.readFileSync(path.join(root, 'electron/sharing/room-voice.ts'), 'utf8');
    const begin = voiceSource.indexOf('async function applyShareCaps('), end = voiceSource.indexOf('// Voice-link quality poll', begin);
    assert(begin >= 0 && end > begin);
    const applyCaps = require('typescript').transpileModule(voiceSource.slice(begin, end), { compilerOptions: { target: require('typescript').ScriptTarget.ES2022 } }).outputText;
    for (const options of [{ height: 480, fps: 15, bitrateKbps: 1000 }, { height: 1080, fps: 60, bitrateKbps: 5000 }]) {
      const video = quality.screenCaptureVideo(source.id, options);
      const actual = await engine.webContents.executeJavaScript(`(async()=>{${applyCaps}
        const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:${JSON.stringify(video)}}),track=stream.getVideoTracks()[0],pc=new RTCPeerConnection({iceServers:[]});
        try{const sender=pc.addTrack(track,stream);await pc.setLocalDescription();let failed=false;await applyShareCaps(sender,${options.bitrateKbps * 1000},${options.fps},()=>failed=true);return {capture:track.getSettings(),encodings:sender.getParameters().encodings,capFailed:failed};}
        finally{pc.close();stream.getTracks().forEach(track=>track.stop());}})()`);
      assert(!actual.capFailed, JSON.stringify(actual));
      assert(actual.capture.width <= video.mandatory.maxWidth && actual.capture.height <= options.height, JSON.stringify(actual));
      assert(actual.capture.frameRate <= options.fps + 0.1, JSON.stringify(actual));
      assert.equal(actual.encodings[0].maxFramerate, options.fps);
      assert.equal(actual.encodings[0].maxBitrate, options.bitrateKbps * 1000);
      result.capture.push({ requested: options, actual });
    }
    result.status = 'passed';
  }).catch(error => { console.error(error); result.status = 'failed'; result.error = String(error); }).finally(() => {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    clearTimeout(deadline);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2)); app.exit(result.status === 'passed' ? 0 : 1);
  });
}
