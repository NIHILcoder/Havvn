// Actual RoomPlayer/GuestApp and native direct/HLS media. Synthetic files,
// isolated profile, loopback HTTP only; no user's rooms, clipboard or devices.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-playback-'));
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); app.commandLine.appendSwitch('mute-audio');
  const deadline = setTimeout(() => { console.error('Room playback smoke deadline'); app.exit(1); }, 60_000);
  let server;
  app.whenReady().then(async () => {
    const ffmpeg = require('ffmpeg-static'), exec = require('node:child_process').execFileSync;
    const source = path.join(output, 'movie.mp4'), audio = path.join(output, 'song.wav');
    exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=5:d=90',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-movflags', '+faststart', source], { windowsHide: true, timeout: 15000 });
    exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source, '-c', 'copy', '-hls_time', '5', '-hls_list_size', '0',
      path.join(output, 'stream.m3u8')], { windowsHide: true, timeout: 10000 });
    exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', audio], { windowsHide: true, timeout: 10000 });
    const requests = [];
    server = require('node:http').createServer((req, res) => {
      const name = new URL(req.url, 'http://localhost').pathname.slice(1), file = path.join(output, path.basename(name));
      if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
      const data = fs.readFileSync(file); requests.push(name);
      const send = () => {
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.ts') ? 'video/mp2t' : name.endsWith('.wav') ? 'audio/wav' : 'video/mp4');
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`); }
        res.end(data.subarray(start, end + 1));
      };
      if (/stream(?:1[0-9]|[7-9])\.ts$/.test(name)) setTimeout(send, 750); else send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { nodeIntegration: true,
      contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file|data|blob):/.test(d.url) && !d.url.startsWith(base + '/') }));
    win.webContents.on('console-message', d => { if (d.level === 'error') console.error('Renderer:', d.message); });
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/components/Select.css','renderer/components/PlayerControls.css','renderer/pages/RoomsPage.css'].map(p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const page = path.join(output, 'preview.html'); fs.writeFileSync(page, '<html lang="ru"><style>'+css+'</style><div id="root" style="width:100vw;height:100vh;display:flex"></div><div id="guest"></div></html>');
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code);
    async function wait(expression, timeout = 8000) {
      const until = Date.now() + timeout;
      while (Date.now() < until) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
      console.error(await run(`JSON.stringify({calls,errors:document.body.innerText,video:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,paused:v.paused,rate:v.playbackRate,ready:v.readyState,seeking:v.seeking,error:v.error?.message}))})`));
      throw Error('Wait failed: ' + expression);
    }
    await run(`
      var root=${JSON.stringify(root)},base=${JSON.stringify(base)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),translate=k=>dict[k]||k,cache={};
      function load(p){if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return{};
          if(s.includes('i18nContext'))return{useTranslation:()=>({t:translate,language:'ru'})};
          if(s==='./Icon')return load(path.join(root,'renderer/components/Icon.tsx'));
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.ts','.tsx'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var calls=[],subscribers=new Set(),seq=0,sessionStarted=Date.now()-1000;
      var files=[{fileId:'movie',name:'movie.mp4',size:1000},{fileId:'hls',name:'hls.mkv',size:1000},{fileId:'song1',name:'song1.wav',size:1000},{fileId:'song2',name:'song2.wav',size:1000}];
      window.api={rooms:{watchFile:async(id,fileId)=>fileId==='hls'?{direct:false,hlsUrl:base+'/stream.m3u8'}:{direct:true,directUrl:base+(fileId.startsWith('song')?'/song.wav':'/movie.mp4')},
        setWatchHost:async(id,hostId)=>{room={...room,watchPolicy:{by:'Z',ownerAt:0,hostId,at:Date.now()}};renderPlayer();return room},subtitleList:async()=>[{key:"fixture",label:"Synthetic subtitles"}],subtitleGet:async()=>["WEBVTT","","00:00:00.000 --> 00:00:30.000","Synthetic cue",""].join(String.fromCharCode(10)),broadcastSync:async(id,payload)=>{calls.push(payload);return{ok:true}}},
        onRoomSync:cb=>{subscribers.add(cb);return()=>subscribers.delete(cb)}};
      window.remote=(action,patch={})=>{const ev={roomId:'smoke',fileId:'movie',memberId:'A',name:'Peer',avatarSeed:'A',
        action,position:12,rate:2,playing:true,together:true,emoji:'',sessionId:'a'.repeat(32),startedAt:sessionStarted,seq:++seq,at:Date.now(),...patch};
        for(const cb of subscribers)cb(ev);return ev;};
      var prefs=load(path.join(root,'renderer/utils/audioPrefs.ts'));
      var deps={React,...React,...prefs,...load(path.join(root,'shared/room-playback.ts')),...load(path.join(root,'shared/room-watch-host.ts')),...load(path.join(root,'shared/media.ts')),
        Hls:require(path.join(root,'node_modules/hls.js')),
        PlayerControls:load(path.join(root,'renderer/components/PlayerControls.tsx')).PlayerControls,
        Select:load(path.join(root,'renderer/components/Select.tsx')).Select,Button:load(path.join(root,'renderer/components/Button.tsx')).Button,cleanError:e=>String(e),
        Icon:load(path.join(root,'renderer/components/Icon.tsx')).default,Identicon:()=>null,AudioSettings:()=>null,WindowControls:()=>null,
        useTranslation:()=>({t:translate}),usePopout:()=>({popout:null,portal:()=>null,openPopout:()=>false,closePopout:()=>{}}),
        useDockWindowMaximized:()=>false,minimizeDockWindow:()=>{},toggleMaximizeDockWindow:()=>{},isModalOpen:()=>false,
        PLAYER_ROOM_FRAME:'smoke',formatBytes:n=>String(n),toast:Object.assign(()=>{},{error:()=>{}})};
      var playerSource=fs.readFileSync(path.join(root,'renderer/pages/RoomsPage.tsx'),'utf8');
      playerSource=playerSource.slice(playerSource.indexOf('interface Watcher')).replace('export default RoomsPage;','exports.RoomPlayer=RoomPlayer;');
      var body=ts.transpileModule(playerSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
      var exports={};new Function('deps','exports','const {'+Object.keys(deps).join(',')+'}=deps;'+body)(deps,exports);
      var view=ReactDOM.createRoot(document.getElementById('root'));
      var room={files,transfers:Object.fromEntries(files.map(f=>[f.fileId,{haveLocally:true}])),members:[]};
      window.renderPlayer=()=>view.render(React.createElement(exports.RoomPlayer,{room,roomId:'smoke',file:files[0],self:{memberId:'Z',name:'Self',avatarSeed:'Z'},initialTogether:true,onClose:()=>{},theater:false,onToggleTheater:()=>{}}));renderPlayer();
      void 0;
    `);
    await wait(`document.querySelector('#root video')?.readyState>=3`);
    await wait(`!!document.querySelector('.room-sub-btn')`);
    await run(`document.querySelector('.room-sub-btn').click();void 0`);await wait(`document.querySelectorAll('.room-sub-item').length===2`);
    await run(`document.querySelectorAll('.room-sub-item')[1].click();void 0`);
    await wait(`document.querySelector('#root video').textTracks[0]?.cues?.length===1`);
    assert.equal(await run(`document.querySelector('#root video').textTracks[0].cues[0].text`),'Synthetic cue');
    await run(`document.querySelector('.room-sub-btn').click();void 0`);await wait(`!!document.querySelector('.room-sub-item')`);
    await run(`document.querySelector('.room-sub-item').click();void 0`);await wait(`document.querySelector('#root video track')===null`);
    await run(`remote('seek');void 0`); await wait(`document.querySelector('#root video').currentTime>=12&&!document.querySelector('#root video').seeking`);
    assert.equal(await run(`document.querySelector('#root video').playbackRate`), 2);
    await run(`remote('pause',{position:15,playing:false});void 0`); await wait(`document.querySelector('#root video').paused&&!document.querySelector('#root video').seeking`);
    assert.equal(await run(`calls.filter(c=>['play','pause','seek','rate'].includes(c.action)).length`), 0);
    await run(`remote('track',{fileId:'hls',position:0,rate:1.5});void 0`);
    await wait(`document.querySelector('.room-player-name').textContent==='hls.mkv'&&document.querySelector('#root video').readyState>=3`);
    await run(`remote('seek',{fileId:'hls',position:70,rate:1.5});window.seekStart=Date.now();void 0`);
    await wait(`document.querySelector('#root video').currentTime>=70&&!document.querySelector('#root video').seeking`, 12_000);
    const seekMs = await run(`Date.now()-seekStart`); assert.ok(seekMs > 250, 'HLS seek must exercise the old 250 ms guard failure');
    assert.equal(await run(`calls.filter(c=>['play','pause','seek','rate'].includes(c.action)).length`), 0);
    await run(`remote('track',{fileId:'song1',position:0,rate:1.5});void 0`);
    await wait(`document.querySelector('.room-player-name').textContent==='song1.wav'&&document.querySelector('#root video').readyState>=3`);
    await run(`[...document.querySelectorAll('#root button')].find(b=>b.title===translate('audio.next')).click();void 0`);
    await wait(`document.querySelector('.room-player-name').textContent==='song2.wav'&&document.querySelector('#root video').readyState>=3`);
    assert.equal(await run(`document.querySelector('#root video').playbackRate`), 1.5);
    assert.equal(await run(`calls.filter(c=>c.action==='track').length`), 1);
    assert.equal(await run(`calls.filter(c=>c.action==='join').length`), 1);
    assert.equal(await run(`calls.filter(c=>c.action==='leave').length`), 0);
    await run(`remote('pause',{fileId:'song2',position:8,rate:1.5,playing:false});void 0`);
    await wait(`document.querySelector('#root video').paused&&!document.querySelector('#root video').seeking`);
    await run(`document.querySelector('#root .room-queue-row.on').click();void 0`);
    await wait(`!document.querySelector('#root video').paused&&!document.querySelector('#root video').seeking&&document.querySelector('#root video').currentTime<1`);
    assert.equal(await run(`document.querySelector('#root video').playbackRate`), 1.5);
    assert.equal(await run(`calls.filter(c=>c.action==='track').length`), 2);
    assert.equal(await run(`calls.filter(c=>['play','pause','seek','rate'].includes(c.action)).length`), 0);
    // Host selection and viewer readiness in the actual desktop player.
    await run(`room={...room,canManage:true,members:[{memberId:'Z',name:'Self',isSelf:true,online:true,capabilities:['watch-host-v1']},{memberId:'A',name:'Peer',online:true,capabilities:['watch-host-v1']}]};renderPlayer();void 0`);
    await wait(`!!document.querySelector('.room-watch-host-choice .custom-select-trigger')`);
    await run(`document.querySelector('.room-watch-host-choice .custom-select-trigger').click();void 0`);
    await wait(`document.querySelector('.custom-select-dropdown')?.matches(':popover-open')`);
    await run(`[...document.querySelectorAll('.custom-select-option')].find(e=>e.textContent.trim()==='Peer').click();void 0`);
    await wait(`room.watchPolicy?.hostId==='A'`);
    await run(`remote('pause',{fileId:'song2',position:8,playing:false,v:3,readiness:'ready',policyBy:'Z',policyAt:room.watchPolicy.at,policyOwnerAt:0,hostSig:'verified'});void 0`);
    await wait(`document.querySelector('#root video').paused&&!document.querySelector('#root video').seeking`);
    await new Promise(resolve=>setTimeout(resolve,180));
    await run(`window.beforeHost=calls.length;document.querySelector('#root video').play();void 0`);
    await wait(`calls.slice(beforeHost).some(c=>c.action==='request'&&c.requested==='play')&&document.querySelector('#root video').paused`);
    assert.equal(await run(`calls.slice(beforeHost).some(c=>['play','pause','seek','rate'].includes(c.action))`),false);
    await run(`remote('beat',{fileId:'song2',position:8,playing:false,v:3,readiness:'buffering',policyBy:'Z',policyAt:room.watchPolicy.at,policyOwnerAt:0,hostSig:'verified'});void 0`);
    await wait(`!!document.querySelector('.room-watch-viewer.buffering')`);
    // Change the host without recreating media. Request approval executes one control.
    await run(`window.sameMedia=document.querySelector('#root video');window.api.rooms.setWatchHost('smoke','Z');void 0`);
    await wait(`room.watchPolicy?.hostId==='Z'`);
    assert.equal(await run(`document.querySelector('#root video')===sameMedia`),true);
    await run(`remote('request',{fileId:'song2',requested:'seek',position:12,v:3,readiness:'ready',policyBy:'Z',policyAt:room.watchPolicy.at,policyOwnerAt:0,hostSig:'verified'});void 0`);
    await wait(`!!document.querySelector('.room-watch-request')`);
    await run(`[...document.querySelectorAll('.room-watch-request button')].find(b=>b.textContent===translate('rooms.watchHost.accept')).click();void 0`);
    await wait(`!document.querySelector('.room-watch-request')&&document.querySelector('#root video').currentTime>=12`);
    await run(`remote('request',{fileId:'song2',requested:'pause',position:12,v:3,readiness:'ready',policyBy:'Z',policyAt:room.watchPolicy.at,policyOwnerAt:0,hostSig:'verified'});void 0`);
    await wait(`!!document.querySelector('.room-watch-request')`);
    fs.writeFileSync(path.join(output,'host-dark.png'),(await win.webContents.capturePage()).toPNG());
    await run(`var theme=JSON.parse(fs.readFileSync(path.join(root,'themes/nihil-aero-midnight.havvn-theme.json'),'utf8')).dark;for(const [k,v]of Object.entries(theme))document.documentElement.style.setProperty(k,v);void 0`);
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(await run(`getComputedStyle(document.querySelector('.room-watch-host-panel')).borderRadius`),await run(`theme['--radius-lg']`));
    fs.writeFileSync(path.join(output,'host-aero.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(520,800); await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(await run(`document.querySelector('.room-player-main').scrollWidth<=document.querySelector('.room-player-main').clientWidth`),true);
    fs.writeFileSync(path.join(output,'host-narrow.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(1000,800);await new Promise(resolve=>setTimeout(resolve,180));
    await run(`window.api.rooms.setWatchHost('smoke','');void 0`);
    await wait(`room.watchPolicy?.hostId===''`);
    await run(`view.unmount();void 0`);
    assert.equal(await run(`subscribers.size`), 0); assert.equal(await run(`calls.filter(c=>c.action==='leave').length`), 1);
    // Browser UI uses actual GuestApp and playMagnet with the torrent boundary injected.
    await run(`
      window.WebTorrent=class{add(m,opts,cb){setTimeout(()=>cb({files:[{name:files.find(f=>f.fileId===m).name,
        renderTo(media){media.src=base+(m.startsWith('song')?'/song.wav':'/movie.mp4')},getBlobURL(){}}]}),0)}remove(){}destroy(){}};
      window.guestCalls=[];window.guestApp=new (load(path.join(root,'guest/ui.ts')).GuestApp)(document.getElementById('guest'));
      var guestFiles=files.filter(f=>f.fileId!=='hls').map(f=>({...f,playable:true,magnetURI:f.fileId}));
      guestApp.room={identity:{memberId:'Z'},snapshot:()=>({files:guestFiles,members:[],chat:[],chatEdits:{},chatReacts:{},kicked:false}),sendSync:async m=>{guestCalls.push(m)},leave(){}};
      for(const key of ['patchHeader','patchBanner','patchMembers','patchVoice','patchFiles','patchChat','patchTyping','patchReply'])guestApp[key]=()=>{};
      guestApp.view='room';document.getElementById('guest').innerHTML='<div id="player-host"></div>';
      guestApp.openFile(guestFiles[0]);void 0;
    `);
    await wait(`document.querySelector('#guest video')?.readyState>=3`);
    await run(`guestApp.onSync(remote('pause',{position:8,rate:0.5,playing:false}));void 0`);
    await wait(`document.querySelector('#guest video').paused&&!document.querySelector('#guest video').seeking`);
    await run(`window.oldGuest=document.querySelector('#guest video');guestApp.setLang('en');void 0`);
    await wait(`document.querySelector('#guest video')!==oldGuest&&document.querySelector('#guest video')?.readyState>=3&&document.querySelector('#guest video').paused`);
    assert.equal(await run(`document.querySelector('#guest video').playbackRate`), 0.5);
    assert.ok(Math.abs(await run(`document.querySelector('#guest video').currentTime`) - 8) < 0.15);
    assert.equal(await run(`guestCalls.filter(c=>['play','pause','seek','rate'].includes(c.action)).length`), 0);
    assert.equal(await run(`guestCalls.filter(c=>c.action==='join').length`), 1);
    await run(`window.guestPolicy={t:'watch-policy-v1',by:'owner',ownerAt:0,hostId:'A',at:Date.now()};window.oldSnapshot=guestApp.room.snapshot;guestApp.room.snapshot=()=>({...oldSnapshot(),watchPolicy:guestPolicy});guestApp.patchPlayer();guestApp.onSync(remote('pause',{position:8,rate:0.5,playing:false,v:3,readiness:'ready',policyBy:'owner',policyAt:guestPolicy.at,policyOwnerAt:0,hostSig:'verified'}));void 0`);
    await wait(`document.querySelector('#guest video').paused&&!document.querySelector('#guest video').seeking`);
    await new Promise(resolve=>setTimeout(resolve,180));
    await run(`window.beforeGuest=guestCalls.length;document.querySelector('#guest video').play();void 0`);
    await wait(`guestCalls.slice(beforeGuest).some(c=>c.action==='request'&&c.requested==='play')&&document.querySelector('#guest video').paused`);
    assert.equal(await run(`guestCalls.slice(beforeGuest).some(c=>['play','pause','seek','rate'].includes(c.action))`),false);
    await run(`guestPolicy={...guestPolicy,hostId:'Z',at:guestPolicy.at+1};guestApp.patchPlayer();guestApp.onSync(remote('request',{requested:'seek',position:20,v:3,readiness:'ready',policyBy:'owner',policyAt:guestPolicy.at,policyOwnerAt:0,hostSig:'verified'}));void 0`);
    await wait(`!!document.querySelector('#guest [data-act="watch-accept"]')`);
    await run(`guestApp.onClick({target:document.querySelector('#guest [data-act="watch-accept"]')});void 0`);
    await wait(`document.querySelector('#guest video').currentTime>=20&&!document.querySelector('#guest [data-act="watch-accept"]')`);
    await run(`guestApp.shutdown();void 0`);
    assert.equal(await run(`guestApp.beatTimer`), null); assert.equal(await run(`guestCalls.filter(c=>c.action==='leave').length`), 1);
    const evidence = { realRoomPlayer: true, realGuestApp: true, directAndHls: true, nativeSubtitleCueAndOff: true, delayedHlsSegments: requests.some(n => /stream(?:1[0-9]|[7-9])\.ts$/.test(n)),
      hlsSeekMs: seekMs, rateAndPauseRetained: true, noControlEcho: true, queueKeepsSession: true, currentTrackRestart: true, guestLanguageRemountRetainsState: true, hostSelection: true, readiness: true, followerRequestsNoControl: true, desktopAndGuestApproveRequests: true, teardown: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Room playback smoke passed:', JSON.stringify(evidence)); console.log('Isolated evidence:', output);
    win.destroy(); await new Promise(resolve => server.close(resolve)); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); server?.close(); clearTimeout(deadline); app.exit(1); });
}
