// Production React panels, theme editor and CSS in isolated Chromium. Only IPC,
// clipboard writes and sample people/servers are fixtures; user data is untouched.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.resolve(root, process.env.HAVVN_LAN_ARTIFACTS || 'artifacts/lan-acceptance', 'ui');
  fs.mkdirSync(out, { recursive: true });
  const privateDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-lan-ui-'));
  app.setPath('userData', path.join(privateDir, 'profile')); app.disableHardwareAcceleration();
  const checks = [], errors = [];
  let win, detached;
  const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
  const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('UI step:', code.slice(0, 200)); throw error; } };
  const wait = async (code, label) => { const end = Date.now() + 5000; while (!await run(code)) { if (Date.now() > end) throw Error('Timed out: ' + label); await pause(30); } };
  const check = async (label, fn) => { await fn(); checks.push(label); console.log('PASS', label); };
  const capture = async name => {
    win.webContents.invalidate(); await pause(150);
    const clip = ['lan-panel-ru','lan-joining-ru'].includes(name) ? await run(`({x:0,y:0,width:innerWidth,height:Math.ceil(document.querySelector('.fixture-body').getBoundingClientRect().bottom+18)})`) : undefined;
    fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage(clip)).toPNG());
  };
  const deadline = setTimeout(() => { console.error('LAN UI deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 410, height: 1040, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.setWindowOpenHandler(({ url, frameName }) => url === 'about:blank' && frameName === 'lan-acceptance'
      ? { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 380, height: 900, webPreferences: { backgroundThrottling: false } } } : { action: 'deny' });
    win.webContents.on('did-create-window', child => { detached = child; child.webContents.setBackgroundThrottling(false); });
    const files = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Modal.css',
      'renderer/components/Select.css', 'renderer/components/Toggle.css', 'renderer/components/ThemeEditor.css', 'renderer/components/GlassControls.css',
      'renderer/pages/settings/controls.css', 'renderer/pages/RoomsPage.css', 'renderer/pages/rooms/RoomLanPanel.css'];
    const css = files.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(privateDir, 'ui.html');
    fs.writeFileSync(html, `<html data-theme="dark" lang="ru"><head><meta charset="utf-8"><style id="fixture-css">${css}
      *{transition:none!important;animation:none!important}html,body{margin:0;overflow:auto}#root{padding:18px;box-sizing:border-box;width:100%;min-height:100vh}
      .fixture-title{font-size:16px;font-weight:600;margin:0 0 14px}.fixture-body{max-width:370px}.fixture-actions{display:flex;flex-direction:column;gap:12px;margin-top:24px;max-width:330px}
      </style></head><body><div id="root"></div></body></html>`);
    await win.loadFile(html);
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),DOM=require(path.join(root,'node_modules/react-dom')),ReactDOM=require(path.join(root,'node_modules/react-dom/client')),flush=DOM.flushSync;
      var language='ru',dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key,cache={},notes=[],copies=[],clipboardBlocked=false;
      var toast=Object.assign(value=>notes.push(value),{success:value=>notes.push(value),error:value=>notes.push(value)});
      function load(file) {if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;
        var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{
          if(name.endsWith('.css'))return {};
          if(name.includes('i18nContext'))return {useTranslation:()=>({t,language})};
          if(name.includes('hostToast'))return {useHostToast:()=>toast};
          if(name==='../../components')return Object.assign({},...['Avatar','Button','Icon','Select','Toggle','DropdownMenu'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(name.startsWith('.')){var p=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts'])if(fs.existsSync(p+ext))return load(p+ext);throw Error(p);}
          return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));
        },m,m.exports);return m.exports;}
      function installClipboard(target,owner) {Object.defineProperty(target.navigator,'clipboard',{configurable:true,value:{writeText:async value=>{if(clipboardBlocked)throw Error('Fixture permission denied');copies.push({owner,value})}}});}
      installClipboard(window,'main');
      var readers=[],listeners=new Set();
      var initialServers={available:true,modules:[],instances:[]};
      window.api={rooms:{servers:{state:roomId=>new Promise((resolve,reject)=>readers.push({roomId,resolve,reject})),onUpdate:cb=>{listeners.add(cb);return()=>listeners.delete(cb)}}},
        appearance:{setAcrylic:async()=>({enabled:false,supported:true}),getAcrylic:async()=>({enabled:false,supported:true}),onAcrylicChanged:()=>()=>{}},themes:{export:async theme=>{window.exportedTheme=theme;return {success:true}},import:async()=>({success:true,data:window.exportedTheme})}};
      var Lan=load(path.join(root,'renderer/pages/rooms/RoomLanPanel.tsx')).RoomLanPanel,Widget=load(path.join(root,'renderer/pages/rooms/RoomLanServerWidget.tsx')).RoomLanServerWidget;
      var Button=load(path.join(root,'renderer/components/Button.tsx')).Button;
      var people=[{memberId:'me',name:'Алексей',isSelf:true,avatarSeed:'me',online:true},{memberId:'creator',name:'Мария — организатор сети',avatarSeed:'creator',online:true},{memberId:'gamer',name:'Николай — создатель игры',avatarSeed:'gamer',online:true}];
      var lanState={available:true,active:true,isHost:false,hostId:'creator',sessionId:'fixture',selfVip:'100.88.12.34',participants:[
        {memberId:'me',admitted:true,status:'connected',vip:'100.88.12.34'},
        {memberId:'creator',admitted:true,status:'connected',vip:'100.88.56.78',quality:'good'},
        {memberId:'gamer',admitted:true,status:'connected',vip:'100.88.90.12',quality:'good'}]};
      var server={instanceId:'world',name:'Совместный мир',hostId:'gamer',status:'running',address:'100.88.90.12:25565',players:{online:2,max:8}};
      var mounted=ReactDOM.createRoot(document.getElementById('root')),mode='panel',currentRoom='A',active=true,editorOpen=false,child=null,startHeld=false,startCalls=0,finishStart;
      async function startConnection(){startCalls++;if(startHeld)await new Promise(resolve=>{finishStart=resolve})}
      function nameOf(id){return people.find(person=>person.memberId===id)?.name||'?'}
      function View(){var content=mode==='widget'?React.createElement(Widget,{roomId:currentRoom,lanActive:active,nameOf}):React.createElement(Lan,{roomId:currentRoom,lan:lanState,members:people,onStart:startConnection,onAccept:startConnection,onStop:async()=>{},onDiagnostics:async()=>({}),onOpenSettings:()=>{}});
        if(mode==='theme')content=React.createElement('div',{className:'fixture-actions'},React.createElement(Button,{className:'room-voice-join'},'Войти в голосовой чат'),React.createElement(Lan,{roomId:currentRoom,lan:{available:true,active:false,isHost:false,participants:[]},members:people,onStart:async()=>{},onStop:async()=>{}}),React.createElement(Button,{variant:'primary'},'Обычная акцентная кнопка'));
        return React.createElement(React.Fragment,null,React.createElement('main',{className:'fixture-body'},React.createElement('h1',{className:'fixture-title'},'Havvn · '+(mode==='theme'?'Оформление кнопок':'Виртуальная LAN')),child?DOM.createPortal(content,child.document.body):content),editorOpen?React.createElement(Editor,{onClose:()=>{editorOpen=false;render()}}):null);}
      function render(){flush(()=>mounted.render(React.createElement(View)))}
      function update(roomId,instances){for(var cb of listeners)cb({roomId,state:{...initialServers,instances}})}
      function resolveRead(index,instances){readers[index].resolve({...initialServers,instances})}
      function button(text){return [...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text)}
      function setInput(input,value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}
      render();true;
    `);
    await wait('readers.length===1', 'initial server read');
    await check('self, LAN creator and game host addresses have distinct roles', async () => {
      await run('resolveRead(0,[server])'); await wait(`!!document.querySelector('.room-lan-server-address')`, 'game address');
      assert.equal(await run(`document.querySelector('.room-lan-ip').getAttribute('aria-label')`), await run(`t('rooms.lan.copyYourIp')`));
      assert.equal(await run(`document.querySelectorAll('.room-lan-person').length`), 2);
      assert.equal(await run(`document.querySelector('.room-lan-peer-role').textContent.includes('Николай')`), true, 'server is hosted by the game host, independently of the LAN creator');
      assert.equal(await run(`[...document.querySelectorAll('.room-lan-person')].filter(el=>el.textContent.includes(t('rooms.lan.networkOrganizer'))).length`), 1);
      assert.equal(await run(`document.querySelector('.room-lan-servers-addr').textContent`), '100.88.90.12:25565');
      assert.equal(await run(`document.querySelector('.room-lan-addresses').textContent.includes(t('rooms.lan.peerAddressesHint'))`), true);
      await capture('lan-panel-ru');
    });
    await check('copy actions choose own IP, selected player IP and full server address', async () => {
      await run(`document.querySelector('.room-lan-ip').click();document.querySelectorAll('.room-lan-pip')[1].click();document.querySelector('.room-lan-server-address').click()`); await pause();
      assert.deepEqual(await run('copies.map(copy=>copy.value)'), ['100.88.12.34','100.88.90.12','100.88.90.12:25565']);
    });
    await check('clipboard refusal and missing clipboard both show a readable error', async () => {
      await run(`clipboardBlocked=true;document.querySelector('.room-lan-ip').click()`); await pause();
      assert.equal(await run('notes.at(-1)'), await run(`t('common.copyFailed')`));
      await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});document.querySelector('.room-lan-server-address').click()`); await pause();
      assert.equal(await run('notes.at(-1)'), await run(`t('common.copyFailed')`));
      await run(`clipboardBlocked=false;installClipboard(window,'main')`);
    });
    await check('a late snapshot cannot restore a stopped server', async () => {
      await run(`mode='widget';currentRoom='race';render()`); await wait(`readers.length===2`, 'race read');
      await run(`update('race',[]);resolveRead(1,[server])`); await pause();
      assert.equal(await run(`document.querySelector('.room-lan-servers')===null`), true);
    });
    await check('switching rooms hides previous addresses even if the new read fails', async () => {
      await run(`update('race',[server])`); await wait(`!!document.querySelector('.room-lan-servers-addr')`, 'race update');
      await run(`currentRoom='other';render()`);
      assert.equal(await run(`document.querySelector('.room-lan-servers')===null`), true);
      await wait(`readers.length===3`, 'other room read');
      await run(`readers[2].reject(Error('Fixture unavailable'));update('race',[server])`); await pause();
      assert.equal(await run(`document.querySelector('.room-lan-servers')===null`), true);
    });
    await check('stale reads from an unmounted room cannot affect the next room', async () => {
      await run(`currentRoom='slow';render()`); await wait(`readers.length===4`, 'slow read');
      await run(`currentRoom='new';render()`); await wait(`readers.length===5`, 'new read');
      await run(`resolveRead(4,[]);resolveRead(3,[server])`); await pause();
      assert.equal(await run(`document.querySelector('.room-lan-servers')===null`), true);
      await run(`active=false;render()`); await pause(); assert.equal(await run('listeners.size'), 0);
    });
    await check('inactive LAN never offers stale player IPs', async () => {
      await run(`mode='panel';lanState={...lanState,active:false};render()`); await pause();
      assert.equal(await run(`document.querySelector('.room-lan-ip,.room-lan-pip,.room-lan-servers')===null`), true);
    });
    await check('pending adapter setup shows progress and prevents duplicate join requests', async () => {
      await run(`startHeld=true;lanState={...lanState,selfAdmitted:true};render()`); await pause();
      await run(`document.querySelector('.room-lan-join').click();document.querySelector('.room-lan-join').click()`); await pause();
      assert.equal(await run('startCalls'),1);
      assert.equal(await run(`document.querySelector('.room-lan-join').disabled`),true);
      assert.equal(await run(`document.querySelector('.room-lan-join').getAttribute('aria-busy')`),'true');
      assert.equal(await run(`!!document.querySelector('.room-lan-join .spinner')`),true);
      await capture('lan-joining-ru');
      await run(`startHeld=false;finishStart()`); await pause();
      assert.equal(await run(`document.querySelector('.room-lan-join').disabled`),false);
      await run(`lanState={...lanState,selfAdmitted:false};render()`);
    });
    await check('Russian and English layouts fit a narrow panel and large text', async () => {
      await run(`lanState={...lanState,active:true};render()`); await pause(); await run(`update(currentRoom,[server])`);
      for (const lang of ['ru','en']) for (const size of [410,280,220]) {
        win.setSize(size,1040); await pause();
        await run(`language=${JSON.stringify(lang)};dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/'+language+'.json'),'utf8'));document.documentElement.style.setProperty('--font-size-xs','16px');document.documentElement.style.setProperty('--font-size-sm','18px');render()`); await pause();
        assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`), true, lang+' at '+size+' px');
        assert.equal(await run(`document.querySelector('.room-lan').scrollWidth<=document.querySelector('.room-lan').clientWidth`), true, 'panel overflow '+lang+' '+size);
      }
      await capture('lan-panel-en-narrow');
      win.setSize(410,1040); await pause();
      await run(`language='ru';dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8'));document.documentElement.style.cssText='';render()`); await pause();
    });
    await check('detached controls write through their own window clipboard', async () => {
      await run(`child=window.open('about:blank','lan-acceptance');true`); await wait('!!child?.document.body', 'detached window');
      await run(`child.document.head.innerHTML=document.head.innerHTML;installClipboard(child,'detached');copies=[];render()`); await pause();
      await run(`child.document.querySelector('.room-lan-ip').click();child.document.querySelector('.room-lan-pip').click()`); await pause();
      assert.deepEqual(await run('copies.map(copy=>copy.owner)'), ['detached','detached']);
      await run('child=null;render()'); if(detached)detached.close(); await pause();
    });
    await check('the actual theme editor changes both join buttons and persists the label colour', async () => {
      win.setSize(1220,920); await pause();
      await run(`mode='theme';active=false;var Editor=load(path.join(root,'renderer/components/ThemeEditor.tsx')).ThemeEditor;var library=load(path.join(root,'renderer/utils/theme-library.ts'));localStorage.setItem('theme','dark');editorOpen=true;render()`); await pause();
      await run(`button(t('settings.theme.new')).click()`); await wait(`!![...document.querySelectorAll('.cf-label')].find(el=>el.textContent===t('settings.theme.token.textOnAccent'))`, 'editable button colour');
      await run(`var field=[...document.querySelectorAll('.cf')].find(el=>el.textContent.includes(t('settings.theme.token.textOnAccent')));setInput(field.querySelector('input[type=text]'),'#172a45')`); await pause();
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-voice-join')).color`), 'rgb(23, 42, 69)');
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-lan-join')).color`), 'rgb(23, 42, 69)');
      assert.equal(await run(`getComputedStyle(document.querySelector('.fixture-actions .btn-primary')).color`), 'rgb(23, 42, 69)');
      await run(`button(t('settings.theme.save')).click()`); await pause();
      assert.equal(await run(`library.getActiveTheme().dark['--color-text-on-accent']`), '#172a45');
      await run(`button(t('settings.theme.base.light')).click()`); await pause();
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-lan-join')).color`), 'rgb(255, 255, 255)');
      await run(`field=[...document.querySelectorAll('.cf')].find(el=>el.textContent.includes(t('settings.theme.token.textOnAccent')));setInput(field.querySelector('input[type=text]'),'#e8ffe8')`); await pause();
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-lan-join')).color`), 'rgb(232, 255, 232)');
      await run(`button(t('settings.theme.save')).click();button(t('settings.theme.base.dark')).click()`); await pause();
      await run(`field=[...document.querySelectorAll('.cf')].find(el=>el.textContent.includes(t('settings.theme.token.textOnAccent')));field.scrollIntoView({block:'center'})`); await pause();
      await capture('lan-theme-editor');
      await run(`button(t('settings.theme.export')).click()`); await pause();
      assert.equal(await run(`exportedTheme.dark['--color-text-on-accent']`), '#172a45');
      assert.equal(await run(`exportedTheme.light['--color-text-on-accent']`), '#e8ffe8');
      await run(`editorOpen=false;render();library.bootApplyActiveTheme()`); await pause();
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-lan-join')).color`), 'rgb(23, 42, 69)');
    });
    await check('theme overview preview matches the edited button text colour and checks its contrast', async () => {
      await run(`editorOpen=true;render()`); await pause();
      assert.equal(await run(`document.querySelectorAll('.te-contrast-row').length>=11`),true);
      assert.equal(await run(`[...document.querySelectorAll('.te-contrast-pair')].filter(el=>el.textContent.includes('text-on-accent')).length`),2);
      await run(`document.querySelectorAll('.ted-tabs [role=tab]')[1].click()`); await pause();
      await wait(`!!document.querySelector('.te-pv-btn--primary')`,'overview sample');
      assert.equal(await run(`getComputedStyle(document.querySelector('.te-pv-btn--primary')).color`),'rgb(23, 42, 69)');
      await capture('theme-preview-buttons');
      await run(`editorOpen=false;render();library.bootApplyActiveTheme()`); await pause();
    });
    await check('palette generation and light-from-dark retain readable button labels', async () => {
      await run(`editorOpen=true;render()`); await pause();
      await run(`document.querySelectorAll('.ted-tabs [role=tab]')[0].click();button(t('settings.theme.base.dark')).click()`); await pause();
      await run(`button(t('settings.theme.generate')).click()`); await pause();
      await run(`button(t('settings.theme.save')).click()`); await pause();
      assert.equal(await run(`['#000000','#ffffff'].includes(library.getActiveTheme().dark['--color-text-on-accent'])`),true);
      await run(`var generatedText=library.getActiveTheme().dark['--color-text-on-accent'];button(t('settings.theme.adaptFromDark')).click()`); await pause();
      await run(`button(t('settings.theme.save')).click()`); await pause();
      assert.equal(await run(`library.getActiveTheme().light['--color-text-on-accent']===generatedText`),true);
      await run(`button(t('settings.theme.base.light')).click()`); await pause();
      assert.equal(await run(`getComputedStyle(document.querySelector('.room-lan-join')).color`),await run(`load(path.join(root,'shared/color.ts')).toRgbString(load(path.join(root,'shared/color.ts')).parseColor(generatedText))`));
      await run(`editorOpen=false;render();library.bootApplyActiveTheme()`); await pause();
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,checks,errors,scope:'Production UI/CSS/theme editor; fixture IPC and clipboard, no user rooms or real clipboard changes.'},null,2));
    clearTimeout(deadline); console.log('LAN UI:',checks.length,'passed'); app.exit(0);
  }).catch(async error => {
    try { await capture('failure'); } catch { /* preserve the primary failure */ }
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error.stack||error)},null,2));
    console.error(error);clearTimeout(deadline);app.exit(1);
  });
}
