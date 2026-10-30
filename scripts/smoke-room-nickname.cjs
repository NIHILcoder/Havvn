// Actual room-entry dialogs and profile field, isolated profile and fixture IPC.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const out = path.join(root, 'artifacts/room-nickname-20261028'); fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-'))); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {}); const deadline = setTimeout(() => app.exit(1), 60000);
  app.whenReady().then(async () => {
    const settings = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css',
      'renderer/components/Modal.css','renderer/components/Toggle.css','renderer/components/Select.css','renderer/pages/RoomsPage.css'];
    const html = path.join(out, 'ui.html'); fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + require('./smoke-ui-fonts.cjs')(root) + css.map(file => fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n') + 'html,body,#root{height:100%;margin:0}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 900, height: 900, useContentSize: true, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', e => { if(e.level === 'error') { errors.push(e.message); console.error(e.message); } });
    const run = code => win.webContents.executeJavaScript(code), pause = () => new Promise(resolve => setTimeout(resolve, 120));
    const ready = async () => {
      for (let attempt = 0; attempt < 40; attempt++) { if (await run('document.querySelector(".rooms-public-name-field input")?.value === nicknameProfile.name')) return; await pause(); }
      console.error(await run('document.body.innerText')); throw Error('Room entry dialog did not open');
    };
    await win.loadFile(html);
    await run('var fixtureRoot=' + JSON.stringify(root) + ',settingsFixture=' + JSON.stringify(settings) + `,testFirstSteps=true;
      localStorage.setItem('onboarded','1');
      var nicknameProfile={memberId:'a'.repeat(32),name:'Havvn-A7C4D2',avatarSeed:'a'},nicknameCalls=[],delayName=true,failName=false,nameSaved;
      var fixtureApiOverrides={rooms:{list:async()=>[],getProfile:async()=>structuredClone(nicknameProfile),get:async()=>null,engineStatus:async()=>({state:'ready'}),setActiveRoom:async()=>{},
        setProfile:async patch=>{nicknameCalls.push({kind:'profile',name:patch.name});if(failName)throw Error('fixture profile write failed');if(delayName)await new Promise(resolve=>nameSaved=resolve);nicknameProfile={...nicknameProfile,...patch};return structuredClone(nicknameProfile);},
        join:async()=>{nicknameCalls.push({kind:'join',name:nicknameProfile.name});throw Error('fixture join unavailable');},
        create:async name=>{nicknameCalls.push({kind:'create',name:nicknameProfile.name});throw Error('fixture create unavailable');},
        servers:{state:async()=>({available:false,modules:[],instances:[]}),onUpdate:()=>()=>{}},voice:{mute:async()=>{},deafen:async()=>{}}}};
      ` + fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8') + `
      Object.assign(components,...['Modal','Identicon','Avatar','Tabs'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var names=load(path.join(fixtureRoot,'shared/profile.ts'));nicknameProfile.name=names.defaultRoomName(nicknameProfile.memberId);
      dom.flushSync(()=>tree.unmount());tree=createRoot(document.querySelector('#root'));
      var Rooms=load(path.join(fixtureRoot,'renderer/pages/RoomsPage.tsx')).default;
      function showRooms(action,id){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Rooms,{key:id,taskRequest:{kind:'room-task',requestId:id,action},onTaskHandled:()=>{}}))));}
      function roomButton(key){var node=[...document.querySelectorAll('[role=dialog] button')].find(n=>n.textContent.trim()===t(key));if(!node)throw Error('Missing '+key);dom.flushSync(()=>node.click());}
      function roomInput(selector,value){var node=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));}
      showRooms('join',1);void 0;
    `); await ready();
    assert.equal(await run('document.querySelector(".rooms-public-name-field input").value'), await run('nicknameProfile.name'));
    assert.equal(await run('document.querySelector(".rooms-public-name-field input").maxLength'), 64);
    await run('roomInput(".rooms-public-name-field input","Новичок");roomInput(".rooms-input-code","swift-amber-calm-otter-comet-48219");roomButton("rooms.join")'); await pause();
    assert.deepEqual(await run('nicknameCalls.map(call=>call.kind)'), ['profile'], 'nickname must be saved before joining');
    await run('nameSaved();'); await pause();
    assert.deepEqual(await run('nicknameCalls'), [{kind:'profile',name:'Новичок'},{kind:'join',name:'Новичок'}]);
    await run('delayName=false;roomInput(".rooms-public-name-field input","")'); await pause();
    assert.equal(await run('document.querySelector(".rooms-public-name-field p").textContent.includes(names.defaultRoomName(nicknameProfile.memberId))'), true);
    win.setContentSize(440, 900); await pause();
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
    fs.writeFileSync(path.join(out,'join-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await run('roomButton("rooms.join")'); await pause();
    assert.equal(await run('nicknameCalls.at(-1).name'), await run('names.defaultRoomName(nicknameProfile.memberId)'));
    await run('failName=true;roomInput(".rooms-public-name-field input","Не сохранён");var beforeJoin=nicknameCalls.filter(call=>call.kind==="join").length;roomButton("rooms.join")'); await pause();
    assert.equal(await run('nicknameCalls.filter(call=>call.kind==="join").length'), await run('beforeJoin'));
    await run('failName=false;showRooms("create",2)'); await pause();
    assert.equal(await run('document.querySelector(".rooms-public-name-field input").value'), await run('nicknameProfile.name'));
    fs.writeFileSync(path.join(out,'create-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await run('roomInput(".rooms-public-name-field input","Мой ник");roomButton("rooms.create")'); await pause();
    assert.deepEqual(await run('nicknameCalls.slice(-2)'), [{kind:'profile',name:'Мой ник'},{kind:'create',name:'Мой ник'}]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out,'ui-report.json'), JSON.stringify({ passed:true,checks:['public nickname before join/create','save before entering room','blank field previews stable alias','failed profile save prevents join','nickname retained on next dialog','440px layout'],errors },null,2));
    console.log('Room nickname UI passed:',out); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
