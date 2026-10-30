// Actual React components with deferred fixture IPC/RTC, no capture, network,
// clipboard or user profile access. --probe records failures before a repair.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts/bug-regression-20261029');
  const probe = process.argv.includes('--probe'), checks = [], errors = [];
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(out, 'screen-profile-')));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const deadline = setTimeout(() => { console.error('Screen actions deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css',
      'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/ScreenShare.css', 'renderer/components/Toggle.css', 'renderer/components/NumberInput.css',
      'renderer/pages/SettingsPage.css', 'renderer/pages/settings/controls.css'];
    const html = path.join(out, 'screen.html');
    fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + require('./smoke-ui-fonts.cjs')(root)
      + css.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n')
      + 'html,body{margin:0;background:#101114}#root{padding:16px}.ssv-inline{height:300px!important}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 800, height: 800, useContentSize: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', detail => { if (detail.level === 'error') { errors.push(detail.message); console.error(detail.message); } });
    const run = code => win.webContents.executeJavaScript(code), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = async (label, expression) => { const passed = !!await run(expression); checks.push({ label, passed }); if (!probe) assert.ok(passed, label); };
    await win.loadFile(html);
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={},calls=[],notices=[],rejections=[];
      addEventListener('unhandledrejection',event=>{rejections.push(String(event.reason));event.preventDefault();});
      var toast=Object.assign(message=>notices.push(message),{error:message=>notices.push(message)});
      var NativeRTC=window.RTCPeerConnection,watchJobs=[],sourceJobs=[],remoteJobs=[],signalListeners=new Set(),pcs=[],holdDescription=false,descriptionJob,settingsCtx;
      var info={enabled:false,running:false,url:null,port:0},closeCount=0;
      window.api={rooms:{screen:{
        sources:()=>new Promise((resolve,reject)=>sourceJobs.push({resolve,reject})),
        watchStart:(roomId,memberId)=>new Promise((resolve,reject)=>watchJobs.push({roomId,memberId,resolve,reject})),
        watchStop:async(roomId,memberId)=>{calls.push({kind:'watchStop',roomId,memberId});return {ok:true};},
        signal:async(roomId,memberId,kind,data)=>{calls.push({kind:'signal',roomId,memberId,signal:kind,data});return {ok:true};}
      }},onRoomScreenSignal:fn=>{signalListeners.add(fn);return()=>signalListeners.delete(fn);},webRemote:{
        setEnabled:enabled=>new Promise((resolve,reject)=>remoteJobs.push({kind:'enabled',enabled,resolve,reject})),
        regenToken:()=>new Promise((resolve,reject)=>remoteJobs.push({kind:'regen',resolve,reject})),
        getInfo:async()=>{calls.push({kind:'remoteInfo'});if(info===null)throw Error('No IPC');return {...info};}
      }};
      window.RTCPeerConnection=class {
        constructor(){this.connectionState='new';this.acceptedIce=[];this.localDescription=null;pcs.push(this);}
        async setRemoteDescription(value){if(holdDescription)await new Promise(resolve=>descriptionJob={resolve});this.remoteDescription=value;}
        async setLocalDescription(){calls.push({kind:'localDescription',closed:this.connectionState==='closed'});this.localDescription={type:'answer',sdp:'fixture-answer'};}
        async addIceCandidate(value){if(!this.remoteDescription)throw Error('No remote description');this.acceptedIce.push(value);}
        close(){this.connectionState='closed';this.onconnectionstatechange?.();}
      };
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;
        var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{
          if(name.endsWith('.css'))return {};if(name.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(name.includes('hostToast'))return {useHostToast:()=>toast};
          if(name.endsWith('SettingsContext'))return {useSettings:()=>settingsCtx};
          if(name.endsWith('RoomBackupModal'))return {RoomBackupModal:()=>null};if(name.endsWith('/QRCode'))return {QRCode:()=>null};
          if(name.endsWith('/components')){var all={QRCode:()=>null};for(var key of ['Button','Icon','Toggle'])Object.assign(all,load(path.join(root,'renderer/components/'+key+'.tsx')));return all;}
          if(name.startsWith('.')){var p=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(p+ext))return load(p+ext);throw Error(p);}
          return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));
        },m,m.exports);return m.exports;
      }
      var tree=createRoot(document.getElementById('root')),screen=load(path.join(root,'renderer/components/ScreenShare.tsx'));
      var Sharing=load(path.join(root,'renderer/pages/settings/sections/SharingSection.tsx')).SharingSection;
      function mountView(memberId){dom.flushSync(()=>tree.render(React.createElement(screen.ScreenView,{roomId:'room',memberId,title:memberId,onClose:()=>{closeCount++;}})));}
      function mountPicker(key){dom.flushSync(()=>tree.render(React.createElement(screen.ScreenSourcePicker,{key,onClose:()=>{},onPick:(id,audio)=>calls.push({kind:'pick',id,audio})})));}
      function WebHarness(){var pair=React.useState({...info});settingsCtx={settings:{},webRemote:pair[0],setWebRemote:pair[1],shareUseTurn:false,turnUrl:'',turnUser:'',turnCred:'',customTrackers:'',netEnabled:false,netProfiles:[],netDraft:null,setMessage:message=>notices.push(message),setNetDraft:()=>{}};return React.createElement(Sharing);}
      function mountWeb(key){dom.flushSync(()=>tree.render(React.createElement(WebHarness,{key})));}
      function click(label){var node=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===label);if(!node)throw Error('Missing '+label);dom.flushSync(()=>node.click());}
      function emit(kind,data,memberId){signalListeners.forEach(fn=>fn({roomId:'room',memberId,kind,data}));}
      mountView('first');mountView('second');watchJobs[0].reject(Error('Old screen start failed'));void 0;
    `);
    await pause(80);
    await check('Late start rejection cannot close the next screen or show an obsolete error', 'closeCount===0&&notices.length===0');
    await run(`notices=[];holdDescription=true;emit('offer',{type:'offer',sdp:'fixture'},'second');`); await pause(40);
    await run(`mountView('third');holdDescription=false;descriptionJob.resolve();`); await pause(80);
    await check('A closed screen cannot send a late answer', '!calls.some(c=>c.kind==="signal"&&c.memberId==="second")&&!calls.some(c=>c.kind==="localDescription"&&c.closed)');
    await run(`emit('ice',{candidate:'fixture-ice'},'third');emit('offer',{type:'offer',sdp:'fixture'},'third');`); await pause(80);
    await check('ICE received before an offer survives until the remote description is ready', 'pcs.at(-1).acceptedIce.length===1');
    await run(`watchJobs.at(-1).resolve({ok:true});dom.flushSync(()=>tree.render(null));notices=[];mountView('current-failure');watchJobs.at(-1).reject(Error('Current screen start failed'));`); await pause(80);
    await check('The current screen still reports a start failure and closes', 'notices.length===1&&closeCount>0');
    await run('dom.flushSync(()=>tree.render(null));notices=[];mountPicker("closed");dom.flushSync(()=>tree.render(null));sourceJobs.at(-1).reject(Error("Old picker failed"));'); await pause(80);
    await check('A closed source picker cannot report a late failure', 'notices.length===0');
    await run('mountPicker("active");sourceJobs.at(-1).reject(Error("No capture permission"));'); await pause(80);
    await check('A source-list failure is different from a successful empty list', '!!document.querySelector(".ssp-body [role=alert]")&&!document.querySelector(".ssp-body").textContent.includes(t("rooms.screen.noSources"))');
    if (!probe) fs.writeFileSync(path.join(out, 'source-error.png'), (await win.webContents.capturePage()).toPNG());
    await run('click(t("rooms.screen.refresh"));sourceJobs.at(-1).resolve([]);'); await pause(80);
    await check('A successful empty list clears the source-list error', '!document.querySelector(".ssp-body [role=alert]")&&document.querySelector(".ssp-body").textContent.includes(t("rooms.screen.noSources"))');
    await run(`notices=[];dom.flushSync(()=>tree.render(null));info={enabled:false,running:false,url:null,port:0};mountWeb('off');var toggle=document.querySelector('[role=switch]');dom.flushSync(()=>{toggle.click();toggle.click();});`); await pause(40);
    await check('Enabling web access blocks a duplicate request', 'remoteJobs.length===1&&document.querySelector("[role=switch]").disabled');
    await run('remoteJobs.forEach(job=>job.reject(Error("Port in use")));'); await pause(100);
    await check('Web access failure is visible and handled', '!!document.querySelector(".web-remote-error[role=alert]")&&rejections.length===0');
    await run(`remoteJobs=[];dom.flushSync(()=>document.querySelector('[role=switch]').click());remoteJobs.at(-1).resolve({enabled:true,running:true,url:'http://fixture.test/?k=old',port:8788});`); await pause(80);
    await check('Web access can be retried after failure', 'document.querySelector(".web-remote-url")?.textContent.includes("k=old")');
    await run(`click(t('settings.webRemote.regen'));info={enabled:true,running:false,url:null,port:0};remoteJobs.at(-1).reject(Error('Restart failed after token change'));`); await pause(100);
    await check('A failed token change refreshes status and hides the obsolete URL', '!document.querySelector(".web-remote-url")&&!!document.querySelector(".web-remote-error[role=alert]")&&calls.some(c=>c.kind==="remoteInfo")');
    if (!probe) {
      win.setContentSize(440, 820); await pause(100);
      fs.writeFileSync(path.join(out, 'web-access-error.png'), (await win.webContents.capturePage()).toPNG());
      await check('Web access error fits a narrow window', 'document.documentElement.scrollWidth<=innerWidth');
      await run(`dom.flushSync(()=>tree.render(null));info={enabled:true,running:true,url:'http://fixture.test/?k=unknown',port:8788};mountWeb('unknown');click(t('settings.webRemote.regen'));info=null;remoteJobs.at(-1).reject(Error('IPC failed'));`); await pause(100);
      await check('Unknown web status hides its URL and blocks mutations', '!document.querySelector(".web-remote-url")&&document.querySelector("[role=switch]").disabled&&document.body.textContent.includes(t("settings.webRemote.unknown"))');
      await check('Unknown status and retry fit a narrow window', 'document.documentElement.scrollWidth<=innerWidth');
      await run(`info={enabled:false,running:false,url:null,port:0};click(t('settings.webRemote.refresh'));`); await pause(100);
      await check('A status refresh recovers from an unavailable bridge', '!document.querySelector(".web-remote-error")&&!document.querySelector("[role=switch]").disabled');

      // Real Chromium WebRTC + real VoiceSession/ScreenForwarder. The image and
      // silent microphone are generated locally; no desktop or hardware capture.
      win.setContentSize(800, 600);
      await run(`(async()=>{
        dom.flushSync(()=>tree.render(null));notices=[];window.RTCPeerConnection=NativeRTC;
        var voiceModule=load(path.join(root,'electron/sharing/room-voice.ts'));
        window.syntheticAudio=new AudioContext();window.syntheticMic=syntheticAudio.createMediaStreamDestination();
        window.originalGetUserMedia=navigator.mediaDevices.getUserMedia;
        Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,writable:true,value:async()=>syntheticMic.stream});
        window.syntheticCanvas=document.createElement('canvas');syntheticCanvas.width=160;syntheticCanvas.height=90;
        var paint=syntheticCanvas.getContext('2d'),frame=0;window.syntheticPaint=setInterval(()=>{paint.fillStyle='hsl('+((frame++*20)%360)+' 60% 35%)';paint.fillRect(0,0,160,90);},60);
        window.syntheticScreen=syntheticCanvas.captureStream(10);window.savedOffer=null;window.savedAnswer=null;window.forwardEarly=false;window.reverseEarly=false;
        var offerTimeout,answerTimeout;
        function flushOffer(){if(savedOffer){emit('offer',savedOffer,'native');savedOffer=null;}}
        function flushAnswer(){if(savedAnswer){nativeVoice.onLoopbackSignal('native','answer',savedAnswer);savedAnswer=null;}}
        window.nativeVoice=new voiceModule.VoiceSession({selfId:'native',iceServers:[],sendSignal:()=>{},announce:()=>{},announceShare:()=>{},onChange:()=>{},warn:message=>notices.push(message),log:message=>calls.push({kind:'nativeLog',message}),
          sendLoopback:(memberId,kind,data)=>{if(kind==='offer'){savedOffer=data;offerTimeout=setTimeout(flushOffer,150);}else if(kind==='ice'){if(savedOffer)forwardEarly=true;emit(kind,data,memberId);clearTimeout(offerTimeout);flushOffer();}else emit(kind,data,memberId);}
        },()=>Date.now(),()=>({...voiceModule.defaultVoiceSettings(),noiseSuppressionMode:'off'}));
        await nativeVoice.join();nativeVoice.startShare(syntheticScreen);
        window.api.rooms.screen.watchStart=async()=>{nativeVoice.watchStart('native');return {ok:true};};
        window.api.rooms.screen.watchStop=async()=>{nativeVoice.watchStop('native');return {ok:true};};
        window.api.rooms.screen.signal=async(roomId,memberId,kind,data)=>{if(kind==='answer'){savedAnswer=data;answerTimeout=setTimeout(flushAnswer,150);}else {if(savedAnswer)reverseEarly=true;nativeVoice.onLoopbackSignal(memberId,kind,data);clearTimeout(answerTimeout);flushAnswer();}return {ok:true};};
        mountView('native');
      })()`);
      let playing = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        playing = await run('document.querySelector("video")?.readyState>=2&&document.querySelector("video").currentTime>0.2');
        if (playing) break;
        await pause(80);
      }
      await check('Real generated screen reaches the actual ScreenView through Chromium WebRTC', String(playing));
      await check('Real loopback tolerates early ICE in both directions', 'forwardEarly&&reverseEarly&&notices.length===0&&!calls.some(c=>c.kind==="nativeLog"&&/error|failed/i.test(c.message))');
      fs.writeFileSync(path.join(out, 'screen-loopback.png'), (await win.webContents.capturePage()).toPNG());
      await run(`(async()=>{dom.flushSync(()=>tree.render(null));nativeVoice.leave();clearInterval(syntheticPaint);await syntheticAudio.close();navigator.mediaDevices.getUserMedia=originalGetUserMedia;})()`);
      await check('Screen cleanup releases generated media and signal subscriptions', 'signalListeners.size===0&&syntheticScreen.getTracks().every(track=>track.readyState==="ended")&&syntheticMic.stream.getTracks().every(track=>track.readyState==="ended")');
      assert.deepEqual(errors, []);
      assert.deepEqual(await run('rejections'), []);
    }
    await run('dom.flushSync(()=>tree.unmount())');
    fs.writeFileSync(path.join(out, probe ? 'screen-probe.json' : 'screen-ui-report.json'), JSON.stringify({ passed: checks.every(c=>c.passed), checks, errors, unhandled: await run('rejections') }, null, 2));
    console.log(probe ? 'Screen actions probe:' : 'Screen actions UI passed:', JSON.stringify(checks));
    clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
