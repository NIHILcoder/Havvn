// Production room React components, isolated Electron profile and fixture IPC.
(function smoke() {
  if (!process.versions.electron) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; }); return;
  }
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-chat-tools-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Chat UI smoke deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 420, height: 840, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 420, height: 840, webPreferences: { offscreen: false, backgroundThrottling: false } } }));
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') { errors.push(details.message); console.error(details.message); } });
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/components/Select.css', 'renderer/pages/RoomsPage.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'ui.html');
    fs.writeFileSync(html, `<html data-theme="dark"><meta charset="utf-8"><style>${css}\n#root{container:dock / inline-size;height:100vh;padding:12px;box-sizing:border-box;display:flex;flex-direction:column}body{overflow:hidden}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`);
    await win.webContents.executeJavaScript(`
      var root=${JSON.stringify(root)}, css=${JSON.stringify(css)}, fs=require('fs'), path=require('path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), ReactDOM=require(path.join(root,'node_modules/react-dom/client')), flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k, cache={}, notes=[];
      var toast=Object.assign(v=>notes.push(v),{success:v=>notes.push(v),error:v=>notes.push(v)});
      function load(p){
        if(cache[p])return cache[p].exports;
        var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.includes('hostToast'))return {useHostToast:()=>toast};
          if(s.endsWith('/components'))return Object.assign({ProfileCard:()=>null},...['Button','Icon','Avatar','Identicon','Select'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['', '.tsx','.ts'])if(fs.existsSync(q+ext)&&fs.statSync(q+ext).isFile())return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      var tools=load(path.join(root,'shared/room-chat-tools.ts'));
      var RoomChat=load(path.join(root,'renderer/pages/rooms/RoomChat.tsx')).RoomChat;
      var Gate=load(path.join(root,'renderer/pages/rooms/WatchReadyGate.tsx')).WatchReadyGate;
      var tree=ReactDOM.createRoot(document.querySelector('#root')), portalDoc=null, focused=false, visibility='visible', readCalls=[], pinCalls=[], edits=[], searchCalls=[], slowResolve=null, starts=0;
      document.hasFocus=()=>focused;Object.defineProperty(document,'visibilityState',{get:()=>visibility});
      var message=i=>({id:'m'+String(i).padStart(3,'0'),memberId:'peer',name:'Анна',avatarSeed:'peer',text:'Сообщение '+i+'\\nОбсуждение сборки и настроек.',at:Date.now()-100000+i,receivedAt:10000+i});
      var room={roomId:'room-A',ownerId:'self',name:'Room',chat:Array.from({length:120},(_,i)=>message(i+1)),chatLastReadAt:10020,
        members:[{memberId:'self',name:'Владелец',avatarSeed:'self',isSelf:true},{memberId:'peer',name:'Анна',avatarSeed:'peer'}],files:[{fileId:'file-A',name:'Карта.zip'}],history:[],chatEdits:{},chatPins:[]};
      var archive=[{...message(0),id:'archive',text:'archive-hit https://example.org'}];
      var mountRoom=()=>flush(()=>tree.render(portalDoc?require(path.join(root,'node_modules/react-dom')).createPortal(React.createElement(RoomChat,{room,onAttachRequest:()=>{}}),portalDoc.body):React.createElement(RoomChat,{room,onAttachRequest:()=>{}})));
      window.api={rooms:{
        chatDraft:async()=>({text:''}),saveChatDraft:async()=>({ok:true}),typing:async()=>{},sendChat:async()=>({ok:true}),reactChat:async()=>{},
        markRead:async(id,msgId)=>{readCalls.push({id,msgId});var m=room.chat.find(m=>m.id===msgId);if(m){room={...room,chatLastReadAt:Math.max(room.chatLastReadAt,m.receivedAt)};mountRoom();}return {ok:true};},
        pinChat:async(id,msgId,on)=>{pinCalls.push({id,msgId,on});room={...room,chatPins:on?[...room.chatPins,{topic:'topic',message:room.chat.find(m=>m.id===msgId)}]:room.chatPins.filter(p=>p.message.id!==msgId)};mountRoom();return {ok:true};},
        searchChat:async(id,filter)=>{searchCalls.push({id,filter});if(filter.query==='slow')return new Promise(r=>slowResolve=r);return {messages:[...archive,...room.chat].filter(m=>tools.matchesChatFilter(m,room.chatEdits[m.id]?.text??m.text,filter,'Владелец')),edits:room.chatEdits};},
        editChat:async(id,msgId,text)=>{edits.push({id,msgId,text});room={...room,chatEdits:{...room.chatEdits,[msgId]:{text,at:Date.now()}}};mountRoom();return {ok:true};},
        fetchFile:async()=>({ok:true})
      }};
      var wait=ms=>new Promise(r=>setTimeout(r,ms)), change=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      var button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      var choose=async(label,text)=>{var trigger=document.querySelector('[aria-label="'+label+'"]');trigger.click();await wait(40);var option=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes(text));if(!option)throw Error('No option '+text);option.click();await wait(40);};
      mountRoom();
    `);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async (code, label) => {
      const end = Date.now() + 8000;
      while (!(await run(`return ${code}`))) { if (Date.now() > end) throw Error('UI timeout: ' + label); await wait(50); }
    };
    const capture = async name => { win.webContents.invalidate(); await wait(350); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    await wait(400);
    assert.equal(await run('return readCalls.length'), 0);
    assert.equal(await run('return document.querySelector(".room-chat-unread-marker")?.nextElementSibling.dataset.chatId'), 'm021');
    await run('focused=true;window.dispatchEvent(new Event("focus"));');
    await until('readCalls.length>0', 'visible read cursor');
    assert.equal(await run('return Number(readCalls[0].msgId.slice(1)) < 120 && Number(readCalls[0].msgId.slice(1)) >= 21'), true);
    await capture('unread-chat');
    await run('focused=false;readCalls=[];document.querySelector("#root").style.display="none";room={...room,chat:[...room.chat,message(121)]};mountRoom();');
    await wait(350); assert.equal(await run('return readCalls.length'), 0);
    await run('document.querySelector("#root").style.display="flex";document.querySelector("[data-chat-id=m021] [title=\\""+t("rooms.chatPin")+"\\"]").click();');
    await until('pinCalls.length===1', 'shared pin action');
    await run('document.querySelector("[aria-label=\\""+t("rooms.chatPins")+"\\"]").click();');
    await until('document.querySelectorAll(".room-chat-pin-card").length===1', 'pinned view');
    assert.equal(await run('return readCalls.length'), 0);
    await capture('pinned-message');
    await run('window.basePins=room.chatPins;window.baseMembers=room.members;var fence=String.fromCharCode(96).repeat(3);room={...room,members:room.members.map(m=>m.memberId==="peer"?{...m,name:"Анна — длинное имя участника комнаты"}:m),chatPins:[...room.chatPins,{topic:"code",message:{...message(2),id:"pinned-code",text:["Первая строка закреплённого сообщения.","Вторая строка и длинная ссылка:","https://example.org/"+"long-path-".repeat(15),fence,"const example = "+"value".repeat(30),fence].join(String.fromCharCode(10))}},{topic:"request",message:{...message(3),id:"pinned-request",text:tools.fileRequestText({title:"Нужна карта для нашей новой сборки сервера",status:"fulfilled",fileIds:["file-A"]})}}]};mountRoom();');
    for(const width of [260,340,600]) {
      win.setSize(width,840);await wait(120);
      const pinsFit=await run('return document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".room-chat-pin-card")].every(card=>{const body=card.querySelector(".room-chat-pin-body").getBoundingClientRect(),head=card.querySelector(".room-chat-pin-author").getBoundingClientRect(),actions=card.querySelector(".room-chat-pin-buttons").getBoundingClientRect(),bounds=card.getBoundingClientRect();return body.top>=head.bottom+4 && actions.top>=body.bottom+4 && bounds.left>=0 && bounds.right<=innerWidth && card.scrollWidth<=card.clientWidth+1 && [...card.querySelectorAll(".room-chat-bubble")].every(el=>el.getClientRects().length===1);});');
      assert.equal(pinsFit,true,'pin text, code and actions must stay in separate boxes at '+width);
      await capture('pins-layout-'+width);
    }
    await run('document.documentElement.dataset.theme="light";');await capture('pins-layout-light');
    win.setSize(420,840);await run('document.documentElement.dataset.theme="dark";room={...room,chatPins:basePins,members:baseMembers};mountRoom();');await wait(100);

    await run('button(t("rooms.chatGoTo")).click();');
    await until('document.querySelector("[data-chat-id=m021]").classList.contains("highlighted")', 'jump to pinned message');
    await run('document.querySelector("[title=\\""+t("rooms.chatSearch")+"\\"]").click();await wait(40);change(document.querySelector(".room-chat-search input"),"archive-hit");');
    await until('document.querySelector("[data-chat-id=archive]") !== null', 'archive search');
    assert.equal(await run('return readCalls.length'), 0);
    win.setSize(340,840);await wait(150);
    await capture('search-compact');
    await run('document.querySelector(".room-chat-search-clear").click();await wait(40);');
    assert.equal(await run('return document.activeElement===document.querySelector(".room-chat-search input") && document.activeElement.value===""'),true,'clearing keeps keyboard focus in search');
    await run('change(document.querySelector(".room-chat-search input"),"archive-hit");');
    await until('document.querySelector("[data-chat-id=archive]") !== null', 'query after clear');
    assert.equal(await run('return document.querySelector(".room-chat-search-filters")===null'),true);
    await run('document.querySelector(".room-chat-filter-toggle").click();');
    await until('document.querySelector(".room-chat-search-filters") !== null', 'expanded filters');
    await run('await choose(t("rooms.chatFilterKind"),t("rooms.chatFilter.mentions"));');
    await until('document.querySelector(".room-chat-filter-count")?.textContent==="1"', 'active filter count');
    for (const width of [340,260,600]) {
      win.setSize(width,840);await wait(150);
      assert.equal(await run('return [...document.querySelectorAll(".room-chat-search-field .custom-select-value")].every(el=>el.scrollWidth<=el.clientWidth)'),true,'selected filter labels must fit at '+width);
      assert.equal(await run('return [...document.querySelectorAll(".room-chat-search-field .custom-select-trigger,.room-chat-search-field input")].every(el=>Math.abs(el.getBoundingClientRect().height-36)<1)'),true,'all filter controls have the same usable height');
      assert.equal(await run('return document.querySelector(".room-chat-search-panel").scrollWidth<=document.querySelector(".room-chat-search-panel").clientWidth'),true,'search panel must not overflow at '+width);
      await capture('search-filters-'+width);
    }
    win.setSize(260,520);await wait(150);
    assert.equal(await run('return document.querySelector(".room-chat-compose").getBoundingClientRect().bottom<=innerHeight'),true,'expanded filters leave the composer accessible in a short window');
    assert.equal(await run('return document.querySelector(".room-chat-search-filters").scrollHeight>document.querySelector(".room-chat-search-filters").clientHeight'),true,'short windows scroll the filter group');
    await capture('search-filters-short');
    win.setSize(340,840);await wait(150);
    await run('window.aeroVars={"--color-bg-primary":"#0b293b","--color-bg-secondary":"#0f394f","--color-border-default":"#28657f","--color-text-primary":"#e3f6ff","--color-text-secondary":"#c5e7f5","--color-accent-primary":"#4edbff","--radius-md":"16px","--radius-sm":"12px","--clip-cut-sm":"none"};Object.entries(aeroVars).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));');
    await capture('search-filters-aero');
    await run('Object.keys(aeroVars).forEach(k=>document.documentElement.style.removeProperty(k));document.documentElement.dataset.theme="light";');
    await capture('search-filters-light');
    await run('document.documentElement.dataset.theme="dark";document.querySelector(".room-chat-filter-toggle").click();');
    await until('document.querySelector(".room-chat-search-filters")===null', 'filters collapse');
    assert.equal(await run('return document.querySelector(".room-chat-filter-count").textContent'), '1','collapsing keeps the active filter visible');
    await run('button(t("rooms.chatFilterClear")).click();await wait(40);change(document.querySelector(".room-chat-search input"),"archive-hit");');
    await until('document.querySelector("[data-chat-id=archive]") !== null', 'reset filters');
    assert.equal(await run('return document.documentElement.scrollWidth <= innerWidth && document.querySelector("#root").scrollWidth <= document.querySelector("#root").clientWidth'),true);
    await run('change(document.querySelector(".room-chat-search input"),"slow");');
    await until('slowResolve !== null', 'pending search');
    await run('change(document.querySelector(".room-chat-search input"),"archive-hit");');
    await until('document.querySelector("[data-chat-id=archive]") !== null', 'new search result');
    await run('slowResolve({messages:[{...message(1),id:"stale",text:"stale response"}],edits:{}});');
    await wait(100); assert.equal(await run('return document.querySelector("[data-chat-id=stale]")===null'), true);
    await run('button(t("rooms.chatFilterClear")).click();room={...room,chat:[...room.chat,{...message(122),memberId:"self",name:"Владелец",text:tools.fileRequestText({title:"Нужна карта для сервера",status:"open",fileIds:[]})}]};mountRoom();document.querySelector(".room-chat-log").scrollTop=100000;');
    await until('document.querySelector(".room-request-controls") !== null', 'structured request');
    await run('window.baseFiles=room.files;room={...room,files:room.files.map(f=>({...f,name:"Карта для друзей — версия 1.21 — клиентская сборка сервера.zip"}))};mountRoom();await choose(t("rooms.request.linkFile"),"Карта для друзей");');
    for(const width of [260,340,600]){
      win.setSize(width,840);await wait(120);await run('document.querySelector(".room-chat-log").scrollTop=100000;');await wait(80);
      assert.equal(await run('return document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".room-request-controls .custom-select-value")].every(el=>el.scrollWidth<=el.clientWidth+1) && [...document.querySelectorAll(".room-request-buttons .btn")].every(el=>el.scrollWidth<=el.clientWidth+1);'),true,'request controls must show long names without clipping at '+width);
      if(width===260) assert.equal(await run('return (()=>{const a=document.querySelector(".room-chat-input").getBoundingClientRect(),b=document.querySelector(".room-chat-compose-row > .btn").getBoundingClientRect();return Math.abs(a.left-b.left)<1 && a.width>innerWidth-60 && b.top>=a.bottom+6;})()'),true,'narrow composer keeps a full-width input above its send button');
      await capture('request-layout-'+width);
    }
    win.setSize(340,840);await run('room={...room,files:baseFiles};mountRoom();');await wait(80);

    await run('await choose(t("rooms.request.linkFile"),"Карта.zip");button(t("rooms.request.fulfill")).click();');
    await until('document.querySelector(".room-request-status.fulfilled") !== null', 'request fulfilled');
    assert.equal(await run('return tools.parseFileRequest(edits[0].text).fileIds[0]'), 'file-A');
    await capture('fulfilled-request');
    await run('document.documentElement.dataset.theme="light";');await capture('fulfilled-request-light');await run('document.documentElement.dataset.theme="dark";');
    assert.equal(await run('return document.documentElement.scrollWidth <= innerWidth && document.querySelector("#root").scrollWidth <= document.querySelector("#root").clientWidth'), true);
    await run(`
      var childWin=window.open('about:blank','chat-read-test');
      await wait(150);portalDoc=childWin.document;portalDoc.head.innerHTML='<style>'+css+'</style>';portalDoc.body.style.cssText='height:800px;display:flex;flex-direction:column;padding:12px;box-sizing:border-box';
      portalDoc.hasFocus=()=>false;Object.defineProperty(portalDoc,'visibilityState',{get:()=> 'visible'});
      room={...room,chatLastReadAt:0};readCalls=[];focused=true;mountRoom();
    `);
    await wait(350); assert.equal(await run('return readCalls.length'), 0);
    await run('portalDoc.hasFocus=()=>true;portalDoc.defaultView.dispatchEvent(new Event("focus"));');
    await until('readCalls.length>0', 'detached document focus');
    await run('portalDoc.defaultView.close();portalDoc=null;window.participants=[{memberId:"self",ready:true},{memberId:"peer",ready:false}];window.gateFile="movie";window.gateEnabled=true;window.mountGate=()=>flush(()=>tree.render(React.createElement(Gate,{fileId:gateFile,enabled:gateEnabled,participants,onStart:async()=>{starts++;}})));mountGate();button(t("rooms.watchReady.start")).click();');
    await until('document.body.innerText.includes(t("rooms.watchReady.waiting"))', 'waiting for viewers');
    await run('participants=participants.map(p=>({...p,ready:true}));mountGate();');
    await wait(1100);
    assert.equal(await run('return starts'), 0);
    await run('participants=[{memberId:"self",ready:true},{memberId:"peer",ready:false}];mountGate();');
    await wait(3100); assert.equal(await run('return starts'), 0);
    await run('participants=participants.map(p=>({...p,ready:true}));mountGate();');
    await until('starts===1', 'ready countdown start');
    await run('button(t("rooms.watchReady.start")).click();gateFile="other-movie";mountGate();');
    await wait(3200); assert.equal(await run('return starts'), 1);
    await capture('watch-readiness');
    assert.deepEqual(errors, []); assert.deepEqual(await run('return notes'), []);
    console.log(JSON.stringify({ ok: true, checks: ['first unread and visible receipt', 'hidden chat stays unread', 'shared pin and navigation', 'archive search and stale response', 'request status and linked file', 'narrow layout', 'detached window focus', 'ready countdown cancellation and source change'], screenshots: out }));
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
})();
