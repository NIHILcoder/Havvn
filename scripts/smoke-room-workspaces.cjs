// Production React components in an isolated Electron profile. Fixture IPC only.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron smoke harness uses CommonJS. */
(function smoke() {
  if (!process.versions.electron) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-workspaces-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  const deadline = setTimeout(() => { console.error('Workspace UI smoke deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 940, height: 860, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') { errors.push(details.message); console.error('Renderer:', details.message); } });
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/DropdownMenu.css', 'renderer/components/Toggle.css', 'renderer/components/NumberInput.css', 'renderer/pages/RoomsPage.css', 'renderer/pages/rooms/RoomServerPanel.css']
      .filter(p => fs.existsSync(path.join(root, p))).map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'ui.html');
    fs.writeFileSync(html, `<html data-theme="dark" lang="ru"><meta charset="utf-8"><style>${css}\n#root{container:dock / inline-size;height:calc(100vh - 32px);padding:16px;display:flex;flex-direction:column;overflow:auto}body{overflow:auto}*{transition:none!important;animation:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = code => win.webContents.executeJavaScript(/\bawait\b/.test(code) ? `(async () => {${code}})()` : code);
    await win.webContents.executeJavaScript(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), ReactDOM=require(path.join(root,'node_modules/react-dom/client')), flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k, cache={}, notes=[];
      var toast=Object.assign(v=>notes.push(v),{success:v=>notes.push(v),error:v=>notes.push(v)});
      function load(p){
        if(cache[p])return cache[p].exports;
        if(p.endsWith('.json'))return JSON.parse(fs.readFileSync(p,'utf8'));
        var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.includes('hostToast'))return {useHostToast:()=>toast};
          if(s.endsWith('/components'))return Object.assign({},...['Avatar','Button','Icon','Select','Toggle','DropdownMenu','Modal','NumberInput'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['', '.tsx','.ts','.json'])if(fs.existsSync(q+ext)&&fs.statSync(q+ext).isFile())return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      var tree=ReactDOM.createRoot(document.querySelector("#root"));
      var settle=()=>new Promise(r=>setTimeout(r,35));
      var mount=async(component,props)=>{flush(()=>tree.render(React.createElement(component,props)));await settle();};
      var change=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      var button=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===text);
      var workspace=load(path.join(root,'renderer/pages/rooms/roomWorkspace.ts'));
      var workspaceMenu=load(path.join(root,'renderer/pages/rooms/RoomWorkspaceMenu.tsx')).RoomWorkspaceMenu;
      var consoleComponent=load(path.join(root,'renderer/pages/rooms/ServerConsole.tsx')).ServerConsole;
      var prep=load(path.join(root,'renderer/pages/rooms/ServerPreparation.tsx')).ServerPreparation;
      var panel=load(path.join(root,'renderer/pages/rooms/RoomServerPanel.tsx')).RoomServerPanel;
      var consoleSubs=new Set(), serverSubs=new Set(), roomSubs=new Set(), sent=[], fetched=[], selectedWorkspace=null;
      var initial=[{seq:1,at:1,stream:'out',text:'[INFO] Server ready'},{seq:2,at:2,stream:'out',text:'[WARN] Slow chunk'},{seq:3,at:3,stream:'out',text:'[ERROR] Port unavailable'}];
      var room={roomId:'r',files:[{fileId:'mod',name:'Example.jar',infoHash:'hash',folderId:'mods'}],transfers:{},lan:{available:true,active:true,isHost:false,selfVip:'100.88.0.2',participants:[{memberId:'host',vip:'100.88.0.1',admitted:true,status:'connected'}]}};
      var server={instanceId:'s',moduleId:'minecraft',name:'Друзья — Minecraft',version:'Fabric 1.21',hostId:'host',isHost:false,role:'viewer',remote:true,status:'running',since:Date.now(),address:'100.88.0.1:25565',port:25565,autoRestart:false,updatable:false,sharedContent:[{slotId:'mods',folderId:'mods',extensions:['.jar']}]};
      var state={available:true,modules:[],instances:[server,{...server,instanceId:'second',name:'Второй сервер'}]};
      var stateReply=null;
      window.api={onRoomUpdate:cb=>{roomSubs.add(cb);return()=>roomSubs.delete(cb)},rooms:{get:async()=>structuredClone(room),fetchFile:async(id,file)=>{fetched.push(file);room.transfers[file]={haveLocally:true};return structuredClone(room)},servers:{
        state:async()=>stateReply?await stateReply:structuredClone(state),onUpdate:cb=>{serverSubs.add(cb);return()=>serverSubs.delete(cb)},systemJava:async()=>({available:false}),
        watchConsole:async()=>{},onConsole:cb=>{consoleSubs.add(cb);return()=>consoleSubs.delete(cb)},console:async()=>structuredClone(initial),command:async(id,text)=>{sent.push([id,text]);return{ok:true}}
      }}};
      var configForm=load(path.join(root,'renderer/pages/rooms/ServerConfigForm.tsx')).ServerConfigForm;
        var healthPanel=load(path.join(root,'renderer/pages/rooms/ServerHealthPanel.tsx')).ServerHealthPanel;
        var backupPanel=load(path.join(root,'renderer/pages/rooms/ServerBackupPanel.tsx')).ServerBackupPanel;
        var configSaves=[], backupCalls=[], tickCalls=0;
        var configData={schema:[{key:'server-port',t:'int',min:1,max:65535,labelKey:'rooms.server.cfg.port'},
          {key:'havvn-memory-mb',t:'int',min:512,max:65536,labelKey:'rooms.server.cfg.memory'},
          {key:'view-distance',t:'int',min:3,max:32,labelKey:'rooms.server.cfg.viewDistance'},
          {key:'simulation-distance',t:'int',min:3,max:32,labelKey:'rooms.server.cfg.simDistance'},
          {key:'max-players',t:'int',min:1,max:1000,labelKey:'rooms.server.cfg.maxPlayers'}],
          values:{'server-port':'25567','havvn-memory-mb':'2048','view-distance':'10','simulation-distance':'8','max-players':'10','online-mode':'true'}};
        var now=Date.now(), healthData={current:{at:now,cpuPercent:22.5,rssBytes:536870912,freeDiskBytes:40000000000,tps:19.8,mspt:8.2,tickAt:now,tickSource:'paper'},
          history:Array.from({length:16},(_,i)=>({at:now-(15-i)*5000,cpuPercent:10+i,rssBytes:350000000+i*12500000})),running:true,remote:false};
        var backupData=[{id:'full-test',label:'До обновления',kind:'server',version:'Paper 1.21',createdAt:now,bytes:600000,auto:true}];
        Object.assign(window.api.rooms.servers,{getConfig:async()=>structuredClone(configData),saveConfig:async(id,values)=>{configSaves.push(structuredClone(values));return{ok:true}},
          health:async()=>structuredClone(healthData),queryTicks:async()=>{tickCalls++;return{available:false}},
          backups:async()=>structuredClone(backupData),createBackup:async(id,label,kind)=>{backupCalls.push([id,label,kind]);return backupData[0]},
          restoreBackup:async(id,backupId)=>{backupCalls.push(['restore',id,backupId]);return{ok:true}}});
        var choose=async(label,text)=>{document.querySelector('[aria-label="'+label+'"]').click();await settle();Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()===text).click();await settle();};
      true;
    `);
    const step = async (name, code) => { try { return await run(code); } catch (e) { console.error('UI step:', name, await run('document.body.innerText')); throw e; } };
    const capture=async name=>{win.webContents.invalidate();await new Promise(r=>setTimeout(r,350));fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG());};

    await step('preset', `await mount(workspaceMenu,{roomId:'r',dock:workspace.builtinWorkspace('game').dock,widths:{railW:280,chatW:360},onApply:p=>selectedWorkspace=p});button('Раскладка').click();await settle();button('Администрирование').click();await settle();`);
    assert.equal(await run('selectedWorkspace.server.tab'), 'console');
    await step('save layout', `button('Раскладка').click();await settle();button('Сохранить и настроить раскладки').click();await settle();change(document.querySelector('.room-workspace-name'),'Моя игра');await settle();button('Сохранить текущую').click();await settle();`);
    assert.equal(await run('workspace.loadWorkspaces()[0].name'), 'Моя игра');
    await step('long workspace', "change(document.querySelector('.room-workspace-name'),'Игра с друзьями — сервер Minecraft с модами и общими картами');button('Сохранить текущую').click();await settle();");
    for(const width of [260,400]){
      win.setSize(width,620);await new Promise(r=>setTimeout(r,150));
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".room-workspace-save,.room-workspace-entry")].every(el=>el.scrollWidth<=el.clientWidth+1) && [...document.querySelectorAll(".room-workspace-entry .btn")].every(el=>el.scrollWidth<=el.clientWidth+1)'),true,'workspace name and actions must fit at '+width);
      await capture('workspace-layout-'+width);
    }
    win.setSize(940,860);

    await step('console', `await mount(consoleComponent,{instanceId:'s',roomId:'r',canSend:true});`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 3);
    await step('search', `change(document.querySelector('.server-console-filters input'),'Port');await settle();`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 1);
    await step('pause', `change(document.querySelector('.server-console-filters input'),'');await settle();document.querySelector('[aria-label="Приостановить вывод"]').click();await settle();for(var cb of consoleSubs)cb({instanceId:'s',lines:[{seq:4,at:4,stream:'out',text:'New line while paused'}]});await settle();`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 3);
    await step('resume', `document.querySelector('[aria-label="Возобновить вывод"]').click();await settle();`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 4);
    await step('error', `document.querySelector('[aria-label="Перейти к последней ошибке"]').click();await settle();`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 1);
    await step('shortcut', `document.querySelector('.server-console-saved').open=true;change(document.querySelector('.server-console-prompt input'),'save-all');change(document.querySelector('.server-console-save-row input'),'Сохранить мир');await settle();button('Сохранить команду из поля').click();await settle();change(document.querySelector('.server-console-prompt input'),'');await settle();button('Сохранить мир').click();await settle();`);
    assert.equal(await run('document.querySelector(".server-console-prompt input").value'), 'save-all');
    assert.equal(await run('sent.length'), 0);
    for(const width of [260,600]){
      win.setSize(width,640);await new Promise(r=>setTimeout(r,150));
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".server-console-filters,.server-console-save-row,.server-console-saved-row")].every(el=>el.scrollWidth<=el.clientWidth+1)'),true,'console fields and saved commands must fit at '+width);
      await capture('console-layout-'+width);
    }
    win.setSize(940,860);

    win.webContents.invalidate(); await new Promise(r => setTimeout(r, 350));
    fs.writeFileSync(path.join(out, 'console-dark.png'), (await win.webContents.capturePage()).toPNG());
    await step('send', `button('Отправить').click();button('Отправить').click();await settle();`);
    assert.equal(await run('sent.length'), 1);
    await step('cap', `for(var cb of consoleSubs)cb({instanceId:'s',lines:Array.from({length:1250},(_,i)=>({seq:i+5,at:5,stream:'out',text:'line '+i}))});await settle();`);
    assert.equal(await run('document.querySelectorAll(".server-console-line").length'), 1200);
    await step('preparation', `await mount(prep,{instance:server,roomId:'r',onConsole:()=>{},onContent:()=>{}});`);
    assert.equal(await run('button("Скопировать адрес подключения").disabled'), true);
    await step('receive', `button('Получить недостающие файлы').click();await settle();`);
    assert.deepEqual(await run('fetched'), ['mod']);
    await step('confirm', `document.querySelector('[role=switch]').click();await settle();`);
    assert.equal(await run('button("Скопировать адрес подключения").disabled'), false);
    await step('network pause', `room.lan.suspended=true;for(var cb of roomSubs)cb(structuredClone(room));await settle();`);
    assert.equal(await run('button("Скопировать адрес подключения").disabled'), true);
    await run(`room.lan.suspended=false;for(var cb of roomSubs)cb(structuredClone(room));await settle();`);
    // A delayed reception reply must not overwrite a newer network pause.
    await step('late receive reply', `delete room.transfers.mod;for(var cb of roomSubs)cb(structuredClone(room));await settle();window.fetchSnapshot=structuredClone(room);window.api.rooms.fetchFile=()=>new Promise(r=>window.finishFetch=r);button('Получить недостающие файлы').click();await settle();room.lan.suspended=true;for(var cb of roomSubs)cb(structuredClone(room));await settle();finishFetch(fetchSnapshot);await settle();`);
    assert.equal(await run('button("Скопировать адрес подключения").disabled'), true);
    await run(`room.lan.suspended=false;room.transfers.mod={haveLocally:true};for(var cb of roomSubs)cb(structuredClone(room));await settle();`);
    win.setSize(400, 860);
    await run(`document.documentElement.dataset.theme='light';await settle();`);
    win.webContents.invalidate(); await new Promise(r => setTimeout(r, 350));
    fs.writeFileSync(path.join(out, 'preparation-light-narrow.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#root").scrollWidth <= document.querySelector("#root").clientWidth'), true);
    await step('stored selection', `workspace.saveServerView('r',{instanceId:'second',tab:'console'});stateReply=new Promise(r=>window.resolveState=r);await mount(panel,{roomId:'r'});`);
    assert.equal(await run('workspace.loadServerView("r").instanceId'), 'second');
    await run(`resolveState(structuredClone(state));stateReply=null;await settle();`);
    assert.equal(await run('document.querySelector(".room-server-name").textContent'), 'Второй сервер');
    assert.equal(await run('document.querySelector(".room-server-viewtab.is-active").textContent.trim()'), 'Консоль');
    await run(`workspace.applyServerView('r',{instanceId:'s',tab:'overview'});await settle();`);
    assert.equal(await run('document.querySelector(".room-server-name").textContent'), 'Друзья — Minecraft');
    assert.equal(await run('document.querySelector(".room-server-viewtab.is-active").textContent.trim()'), 'Обзор');
    win.setSize(640, 900);
      await step('config template preview', `await mount(configForm,{instanceId:'s',locked:false});await choose('Шаблоны настроек','Ресурсы для сервера с модами');`);
      assert.equal(await run('configSaves.length'), 0);
      for(const width of [260,640]){
        win.setSize(width,920);await new Promise(r=>setTimeout(r,150));
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".server-preset-preview > div,.server-preset-save")].every(el=>el.scrollWidth<=el.clientWidth+1) && [...document.querySelectorAll(".server-config-field input,.server-preset-save input")].every(el=>el.getBoundingClientRect().height>=36)'),true,'template comparison and form fields must fit at '+width);
        await capture('templates-layout-'+width);
      }
      win.setSize(640,900);

      await step('config template apply', `button('Применить к форме').click();await settle();button(t('rooms.server.saveSettings')).click();await settle();`);
      assert.equal(await run('configSaves[0]["havvn-memory-mb"]'), '4096');
      assert.equal(await run('configSaves[0]["server-port"]'), '25567');
      assert.equal(await run('configSaves[0]["online-mode"]'), 'true');
      await step('config template persistence', `change(document.querySelector('.server-preset-save input'),'Мой сервер');await settle();button('Сохранить свой шаблон').click();await settle();`);
      win.webContents.invalidate(); await new Promise(r => setTimeout(r, 350));
      fs.writeFileSync(path.join(out, 'settings-templates.png'), (await win.webContents.capturePage()).toPNG());
      await step('health', `await mount(healthPanel,{instance:{...server,remote:false},roomId:'r'});button('Измерить TPS / MSPT').click();button('Измерить TPS / MSPT').click();await settle();`);
      assert.equal(await run('tickCalls'), 1);
      assert.equal(await run('document.querySelectorAll(".server-health-metric svg").length'), 2);
      assert.equal(await run('document.body.innerText.includes("22.5%")'), true);
      win.setSize(400, 800); win.webContents.invalidate(); await new Promise(r => setTimeout(r, 350));
      fs.writeFileSync(path.join(out, 'server-health-narrow.png'), (await win.webContents.capturePage()).toPNG());
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#root").scrollWidth <= document.querySelector("#root").clientWidth'), true);
      await step('full backup', `await mount(backupPanel,{instanceId:'s',locked:false});await choose('Содержимое бэкапа','Вся сборка сервера');button(t('rooms.server.backup.create')).click();await settle();`);
      assert.equal(await run('backupCalls[0][2]'), 'server');
      await step('full restore confirmation', `button('Восстановить').click();await settle();`);
      assert.equal(await run('backupCalls.length'), 1);
      assert.equal(await run('document.body.innerText.includes("права операторов остаются текущими")'), true);
      for(const width of [260,400]){
        win.setSize(width,800);await new Promise(r=>setTimeout(r,150));
        assert.equal(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".room-server-backup-create,.room-server-backup-actions")].every(el=>el.scrollWidth<=el.clientWidth+1)'),true,'backup fields and confirmation actions must fit at '+width);
        await capture('backup-layout-'+width);
      }

      win.webContents.invalidate(); await new Promise(r => setTimeout(r, 350));
      fs.writeFileSync(path.join(out, 'full-restore-narrow.png'), (await win.webContents.capturePage()).toPNG());
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#root").scrollWidth <= document.querySelector("#root").clientWidth'), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks: ['layout menu and persistence', 'console search, error filter, frozen output, bounded buffer', 'saved command prefill and duplicate send guard', 'preparation content reception and network changes', 'stored server selection while loading and preset application', 'narrow layout', 'server config templates', 'health panel and tick query guard', 'full backup type and restore confirmation'], screenshots: out }));
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
})();
