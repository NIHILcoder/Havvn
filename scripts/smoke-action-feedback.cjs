// Real components/hooks; fixture IPC and clipboard, a tiny generated video,
// isolated Electron profile. No user shares, rooms or clipboard are changed.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts/action-feedback-20261029');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-'))); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Action feedback deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const video = path.join(out, 'fixture.mp4');
    require('node:child_process').execFileSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=5:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', video], { windowsHide: true, timeout: 15000 });
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css',
      'renderer/components/Modal.css','renderer/components/ShareLinkModal.css','renderer/components/StreamPlayerModal.css','renderer/components/PlayerControls.css',
      'renderer/components/PlayerPreferencesPanel.css','renderer/components/Select.css','renderer/components/NumberInput.css','renderer/components/MediaBufferStatus.css','renderer/components/EpisodePrefetchControl.css'];
    const html = path.join(out, 'ui.html'); fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + require('./smoke-ui-fonts.cjs')(root) + css.map(f=>fs.readFileSync(path.join(root,f),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n') + 'html,body,#root{height:100%;margin:0}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1000, height: 820, useContentSize: true, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = [], checks = []; win.webContents.on('console-message', e => { if(e.level==='error') { errors.push(e.message); console.error(e.message); } });
    const run = code => win.webContents.executeJavaScript(code), pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const wait = async (label, expression) => { for(let i=0;i<80;i++){if(await run(expression)){checks.push(label);return;}await pause(60);}console.error(await run('({text:document.body.innerText,calls,notices})'));throw Error(label); };
    await win.loadFile(html);
    await run(`var root=${JSON.stringify(root)},videoData=${JSON.stringify('data:video/mp4;base64,' + fs.readFileSync(video).toString('base64'))};
      var fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript')),React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={},calls=[],notices=[],clipJob,stopJob,requestJob,audioJob;
      var toast=Object.assign(message=>notices.push({kind:'notice',message}),{error:message=>notices.push({kind:'error',message}),success:message=>notices.push({kind:'success',message})});
      var closeCount=0,audioMode='fail',audioList=[{index:0,label:'English',lang:'en',isDefault:true}],subMode='empty';
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{calls.push({kind:'copy',text});return new Promise((resolve,reject)=>clipJob={resolve,reject});}}});
      window.api={shareStart:async id=>({link:'https://example.test/share/'+id,peers:0}),shareGet:async()=>({peers:0}),shareStop:id=>{calls.push({kind:'stop',id});return new Promise((resolve,reject)=>stopJob={resolve,reject});},
        rooms:{broadcastSync:(id,input)=>{calls.push({kind:'request',id,...input});return new Promise((resolve,reject)=>requestJob={resolve,reject});}},
        getDownloads:async()=>[{id:'movie',infoHash:'fixture-hash',progress:1,status:'completed'}],getTorrentFiles:async()=>[0,1].map(i=>({index:i,name:'Episode'+i+'.mp4',path:'Episode'+i+'.mp4',length:100-i})),
        getStreamUrl:async(id,i,options)=>({url:videoData+'#'+i+'-'+options.audioTrack,kind:'video',transcoded:!!options.transcode,startTime:0}),stopStream:async()=>{},
        getEpisodePrefetchSupport:async()=>({supported:false}),onDownloadStats:()=>()=>{},
        audioTracks:{list:async(id,i)=>{calls.push({kind:'audio',i});if(audioMode==='fail')throw Error('probe failed');if(audioMode==='hold'||audioMode==='hold-first'&&i===0)return await new Promise((resolve,reject)=>audioJob={resolve,reject});return audioList;}},
        subtitles:{list:async()=>{if(subMode==='fail')throw Error('subtitle failure');return [];},get:async()=>''},cast:{start:async()=>({url:'https://example.test/cast',lan:'127.0.0.1',port:1})}};
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.endsWith('/popout'))return {usePopout:()=>({popout:null,portal:()=>null,openPopout:()=>false,closePopout:()=>{}})};
          if(s.includes('dockWindowChrome'))return {useDockWindowMaximized:()=>false};if(s.endsWith('/QRCode'))return {QRCode:()=>null};if(s.includes('WindowControls'))return {WindowControls:()=>null};
          if(s==='react-hot-toast')return {__esModule:true,default:toast,toast};
          if(s.startsWith('.')){var q=path.resolve(path.dirname(file),s);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var tree=createRoot(document.querySelector('#root')),Share=load(path.join(root,'renderer/components/ShareLinkModal.tsx')).ShareLinkModal;
      function mountShare(id){dom.flushSync(()=>tree.render(React.createElement(Share,{downloadId:id,downloadName:'Fixture',onClose:()=>{closeCount++;}})));}
      function click(label){var node=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===label||n.title===label);if(!node)throw Error('Missing '+label);dom.flushSync(()=>node.click());}
      mountShare('one');void 0;`);
    await wait('Share result ready', '!!document.querySelector(".share-copy-btn")');
    await run('click(t("share.copy"))'); await pause(50);
    assert.equal(await run('document.querySelector(".share-copy-btn").disabled'), true);
    await run('clipJob.reject(Error("denied"))'); await wait('Copy failure is visible', 'document.body.textContent.includes(t("common.copyFailed"))');
    await run('click(t("share.copy"));clipJob.resolve()'); await wait('Copy retry acknowledges completion', 'document.querySelector(".share-copy-btn").textContent.trim()===t("share.copied")');
    await run('click(t("share.stop"));click(t("share.stop"))'); await pause(50);
    assert.equal(await run('closeCount'),0); assert.equal(await run('calls.filter(x=>x.kind==="stop").length'),1);
    assert.equal(await run('[...document.querySelectorAll("button")].find(n=>n.textContent.trim()===t("share.done")).disabled'),true);
    await run('stopJob.reject(Error("stop failed"))'); await wait('Failed stop retains the link and retry', 'document.body.textContent.includes(t("share.stopFailed"))&&!document.querySelector(".share-link-input").disabled');
    assert.equal(await run('closeCount'),0);
    win.setContentSize(440,820); await pause(80); fs.writeFileSync(path.join(out,'share-stop-failed.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);
    await run('click(t("share.stop"));stopJob.resolve({ok:false})'); await pause(80); assert.equal(await run('closeCount'),0);
    await run('click(t("share.stop"));stopJob.resolve({ok:true})'); await wait('Successful stop closes only after reply','closeCount===1');
    await run('click(t("share.stop"));var oldStop=stopJob;mountShare("two");oldStop.resolve({ok:true})'); await wait('New share does not inherit old result','document.querySelector(".share-link-input")?.value.endsWith("/two")');
    assert.equal(await run('closeCount'),1);
    // Use the iframe clipboard for controls rendered in another document.
    await run(`var frame=document.createElement('iframe');document.body.append(frame);var frameCopies=[];Object.defineProperty(frame.contentWindow.navigator,'clipboard',{configurable:true,value:{writeText:async text=>frameCopies.push(text)}});`);
    await run(`load(path.join(root,'renderer/utils/clipboard.ts')).writeClipboardText('child text',frame.contentWindow)`);
    assert.deepEqual(await run('frameCopies'),['child text']);
    // A request has no success notification until IPC acknowledges sending.
    await run(`var useSender=load(path.join(root,'renderer/utils/useRoomPlaybackSender.ts')).useRoomPlaybackSender;
      function Sender(props){var send=useSender('room',props.policy,{sent:()=>notices.push({kind:'sent'}),failed:()=>notices.push({kind:'failed'})});return React.createElement('button',{id:'request',onClick:()=>void send({fileId:'file',action:'request',requested:'play',position:0,rate:1,playing:true,together:true})},'Request');}
      var sender=policy=>dom.flushSync(()=>tree.render(React.createElement(Sender,{policy})));sender('one');dom.flushSync(()=>document.querySelector('#request').click());void 0;`);
    assert.equal(await run('notices.filter(x=>["sent","failed"].includes(x.kind)).length'),0);
    await run('requestJob.reject(Error("engine failed"))'); await wait('Request rejection has error instead of success','notices.some(x=>x.kind==="failed")&&!notices.some(x=>x.kind==="sent")');
    await run('document.querySelector("#request").click();requestJob.resolve({ok:false})'); await wait('Explicit refusal is not success','notices.filter(x=>x.kind==="failed").length===2');
    await run('document.querySelector("#request").click();requestJob.resolve({ok:true})'); await wait('Request success follows acknowledgment','notices.filter(x=>x.kind==="sent").length===1');
    await run('document.querySelector("#request").click();sender("two");requestJob.resolve({ok:true})'); await pause(80);
    assert.equal(await run('notices.filter(x=>x.kind==="sent").length'),1);
    // Actual player menus distinguish failed loading from empty catalogs.
    win.setContentSize(1000,820);
    await run(`localStorage.setItem('playerAutoNext','0');var Player=load(path.join(root,'renderer/components/StreamPlayerModal.tsx')).StreamPlayerModal;
      var player=key=>dom.flushSync(()=>tree.render(React.createElement(Player,{key,downloadId:'movie',downloadName:'Fixture',onClose:()=>{}})));player('one');`);
    await wait('Player audio control is available after a probe failure','!!document.querySelector("button[title=\\""+t("player.audioTracks")+"\\"]")');
    await run('click(t("player.audioTracks"))'); await wait('Audio failure is not an empty catalog','document.body.textContent.includes(t("player.audioLoadFailed"))&&!document.body.textContent.includes(t("player.audioNone"))');
    win.setContentSize(440,820); await pause(80); fs.writeFileSync(path.join(out,'audio-probe-failed.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await run('(()=>{var menu=document.querySelector(".player-sub-panel").getBoundingClientRect(),frame=document.querySelector(".player-modal").getBoundingClientRect();return menu.left>=frame.left&&menu.right<=frame.right})()'),true);
    await run('audioMode="hold";click(t("common.retry"))'); await wait('Retry shows loading rather than empty','document.body.textContent.includes(t("player.tracksLoading"))');
    await run('audioJob.resolve(audioList)'); await wait('Recovered audio catalog is selectable','[...document.querySelectorAll(".player-sub-item")].some(n=>n.textContent.includes("English"))');
    await run('audioMode="hold-first";player("two")'); await wait('New file starts an independent probe','!!audioJob&&!!document.querySelector(".player-file-chip")');
    await run('var oldAudio=audioJob;audioList=[{index:0,label:"Second episode",lang:"fr"}];dom.flushSync(()=>[...document.querySelectorAll(".player-file-chip")].find(n=>n.textContent.includes("Episode1")).click());');
    await pause(100); await run('oldAudio.resolve([{index:0,label:"Stale episode",lang:"en"}]);click(t("player.audioTracks"))');
    await wait('Old probe cannot replace the new file catalog','document.body.textContent.includes("Second episode")&&!document.body.textContent.includes("Stale episode")');
    await run('click(t("player.cast"))'); await wait('Cast link ready','!!document.querySelector(".player-cast-url")');
    await run('click(t("player.castCopy"));clipJob.reject(Error("denied"))'); await wait('Player copy failure is visible','document.body.textContent.includes(t("common.copyFailed"))');
    // Empty metadata is retried once, never an unbounded polling loop.
    await run(`var useCatalog=load(path.join(root,'renderer/utils/useTrackCatalog.ts')).useTrackCatalog,catalogJobs=[],emptyCalls=0;
      function Catalog(){var c=useCatalog('empty-file',()=>{emptyCalls++;return new Promise(resolve=>catalogJobs.push(resolve));});return React.createElement('button',{id:'metadata',onClick:c.afterMetadata},c.status+':'+c.tracks.length);}
      dom.flushSync(()=>tree.render(React.createElement(Catalog)));`);
    await pause(80); await run('document.querySelector("#metadata").click();catalogJobs.shift()([])');
    await wait('Metadata schedules a bounded empty-list refresh','emptyCalls===2'); await run('catalogJobs.shift()([])'); await pause(80);
    await run('document.querySelector("#metadata").click();document.querySelector("#metadata").click()'); await pause(80); assert.equal(await run('emptyCalls'),2);
    // Browser guest copy failures stay visible and never change a detached row.
    await run(`dom.flushSync(()=>tree.unmount());var guestCopy=load(path.join(root,'guest/clipboard.ts')).copyGuestText;document.querySelector('#root').innerHTML='<p><button id="guest-copy">Copy</button></p>';var target=document.querySelector('#guest-copy');var guestTask=guestCopy(target,'guest text',{copied:'Copied',failed:'Copy failed'});clipJob.reject(Error('denied'));void 0;`);
    await wait('Guest copy failure has an accessible message','document.querySelector("[data-copy-status]")?.textContent==="Copy failed"');
    await run('guestTask=guestCopy(target,"guest text",{copied:"Copied",failed:"Copy failed"});clipJob.resolve()'); await wait('Guest retry succeeds','target.textContent==="Copied"');
    await run('guestTask=guestCopy(target,"guest text",{copied:"Copied",failed:"Copy failed"});target.remove();clipJob.resolve()'); await pause(80); assert.equal(await run('target.textContent'),'Copy');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'ui-report.json'),JSON.stringify({passed:true,checks,errors},null,2));
    console.log('Action feedback UI passed:',out);clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
