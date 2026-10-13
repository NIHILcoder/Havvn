// Real RoomDetail header, dock chrome/model and mount registry; isolated fixture IPC.
// Unrelated networking/media panels are replaced with inert mounted bodies.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-people-toggle-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('People toggle deadline:', out); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, width: 420, height: 600, webPreferences: { backgroundThrottling: false } } }));
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') { errors.push(d.message); console.error('Renderer:', d.message); } });
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/pages/RoomsPage.css', 'renderer/pages/rooms/dock/DockZone.css', 'renderer/pages/rooms/dock/DockTabStrip.css', 'renderer/pages/rooms/dock/DockTabMenu.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'people.html');
    fs.writeFileSync(html, `<html data-theme="dark"><style>${css}\n#root{container:room / inline-size;height:100dvh;padding:20px}*{transition:none!important;animation:none!important}</style><div id=root></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (e) { console.error('UI step:', code.slice(0, 240)); throw e; } }, pause = ms => new Promise(r => setTimeout(r, ms));
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript')),React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={},notes=[],mounts={},unmounts={},announcements=[],popups={};
      var toast=Object.assign(v=>notes.push(v),{error:v=>notes.push(v),success:v=>notes.push(v)});
      function fixturePanel(id){return function Panel(){React.useEffect(()=>{mounts[id]=(mounts[id]||0)+1;return()=>{unmounts[id]=(unmounts[id]||0)+1;};},[]);return React.createElement('div',{'data-fixture-body':id},id);};}
      function WindowHost({frameName,children,onRealm}){var child=popups[frameName];React.useLayoutEffect(()=>{onRealm(child);return()=>onRealm(null);},[frameName]);return dom.createPortal(children,child.document.body);}
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;var source=fs.readFileSync(p,'utf8');
        if(p===path.join(root,'renderer/pages/RoomsPage.tsx')){var ast=ts.createSourceFile(p,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX),wanted=new Set(['RoomDetail','RoomStage','RoomMembersList','DOCK_ZONE_NAME','DOCK_ZONE_TABS','DOCK_REFUSAL_TEXT','sessionDock','dockPanelBadge','dockPanelTab']);source=ast.statements.filter(n=>ts.isImportDeclaration(n)||ts.isFunctionDeclaration(n)&&wanted.has(n.name?.text)||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>wanted.has(d.name.getText(ast)))).map(n=>n.getText(ast)).join('\\n');source+='\\nconst RoomVoicePanel=fixturePanel("voice"),RoomFilesPanel=fixturePanel("files");module.exports.__Detail=RoomDetail;module.exports.__setDock=l=>sessionDock=l;module.exports.__getDock=()=>sessionDock;';}
        var js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t,language:'ru'})};if(s.includes('hostToast'))return{useHostToast:()=>toast,bindToastRealm:()=>toast,ToastRealmProvider:({children})=>children};if(s.includes('liveAnnouncer'))return{LiveAnnouncer:()=>null,useAnnounce:()=>value=>announcements.push(value),announcerHub:{announce:(realm,value)=>announcements.push(value)}};
          if(s.endsWith('/RoomChat'))return{RoomChat:fixturePanel('chat')};if(s.endsWith('/RoomLanPanel'))return{RoomLanPanel:fixturePanel('lan')};if(s.endsWith('/RoomServerPanel'))return{RoomServerPanel:fixturePanel('server')};if(s.endsWith('/RoomWorkspaceMenu'))return{RoomWorkspaceMenu:()=>null};if(s.endsWith('/DockWindowHost'))return{DockWindowHost:WindowHost};
          if(s.endsWith('/components')){var all={useConfirm:()=>({confirm:async()=>true})};for(var n of ['Button','Icon','Avatar','Toggle','ProfileCard','Tabs','Modal','NumberInput'])Object.assign(all,load(path.join(root,'renderer/components/'+n+'.tsx')));return all;}
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}if(s==='react-hot-toast')return toast;return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var mod=load(path.join(root,'renderer/pages/RoomsPage.tsx')),model=load(path.join(root,'renderer/pages/rooms/dock/dockModel.ts')),tree=null;
      var room={roomId:'fixture',name:'Комната',connected:true,peerCount:0,canManage:false,files:[],members:[{memberId:'self',name:'Дима',avatarSeed:'self',isSelf:true,online:true,role:'owner',have:[]}],voice:{inVoice:false,participants:[]},upKbps:0,downKbps:0};
      window.api={onRoomSync:()=>()=>{},win:{onPopoutClosed:()=>()=>{},onPopoutDenied:()=>()=>{}}};
      window.seed=layout=>{if(tree)dom.flushSync(()=>tree.unmount());mod.__setDock(layout);tree=createRoot(document.querySelector('#root'));dom.flushSync(()=>tree.render(React.createElement(mod.__Detail,{room,busy:false,...Object.fromEntries(['onDiagnostics','onAddFiles','onDropFiles','onCreateFolder','onUpdateFolder','onDeleteFolder','onAssignFile','onOpenFolder','onInvite','onLeave','onCopyCode','onShared','onToggleAutoFetch','onSetLimits'].map(key=>[key,()=>{}]))})));};
      window.current=()=>mod.__getDock();window.clickChip=()=>dom.flushSync(()=>document.querySelector('.room-people-chip').click());window.panel=(id,doc=document)=>doc.querySelector('[data-dock-panel="'+id+'"]');window.tab=(id,doc=document)=>doc.querySelector('[data-dock-tab="'+id+'"]');
      window.menu=id=>dom.flushSync(()=>tab(id).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:160})));
      window.item=text=>[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.trim()===text);
      seed(model.resetDockLayout());void 0;
    `);
    const checks = [];
    for (const zone of ['left', 'centre', 'right']) {
      await run(`seed(model.movePanel(model.resetDockLayout(),'people',${JSON.stringify(zone)}).layout)`); await pause(50);
      const before = await run('current().zones'); const voiceMounts = await run('mounts.voice'), voiceUnmounts = await run('unmounts.voice||0');
      assert.equal(await run('document.querySelector(".room-people-chip").getAttribute("aria-expanded")'), 'true');
      await run('clickChip()'); await pause(50);
      assert.equal(await run('model.isPanelHidden(current(),"people")&&!tab("people")&&!panel("people")'), true);
      assert.equal(await run('!document.querySelector(".room-detail-grid").classList.contains("rail-collapsed")'), true);
      for (const other of ['left', 'centre', 'right'].filter(id => id !== zone)) assert.deepEqual(await run(`current().zones[${JSON.stringify(other)}]`), before[other]);
      assert.equal(await run('mounts.voice'), voiceMounts); assert.equal(await run('unmounts.voice||0'), voiceUnmounts);
      assert.equal(await run('document.querySelector(".room-people-chip").getAttribute("aria-expanded")'), 'false');
      await run('clickChip()'); await pause(50);
      assert.equal(await run('model.zoneOfPanel(current(),"people")'), zone); assert.equal(await run(`current().zones[${JSON.stringify(zone)}].active`), 'people');
      assert.equal(await run('document.querySelector(".room-people-chip").getAttribute("aria-expanded")'), 'true');
      checks.push('hide/restore People in ' + zone + ' while preserving other zones and Voice mount');
    }
    await run('seed(model.resetDockLayout());menu("people");dom.flushSync(()=>item(t("rooms.dock.hidePanel")).click())'); await pause(50);
    assert.equal(await run('document.querySelector(".room-people-chip").getAttribute("aria-expanded")'), 'false');
    await run('clickChip();menu("people");dom.flushSync(()=>item(t("rooms.dock.hidePanel")).click());document.querySelector(".room-splitter-rail").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))'); await pause(50);
    assert.equal(await run('document.querySelector(".room-detail-grid").classList.contains("rail-collapsed")'), true);
    await run('clickChip()'); await pause(50);
    assert.equal(await run('!document.querySelector(".room-detail-grid").classList.contains("rail-collapsed")&&!!panel("people")&&!panel("people").hidden'), true);
    checks.push('chip reflects menu hiding and expands the left column when restoring there');

    await run('var solo=model.resetDockLayout();for(var id of ["voice","lan"])solo=model.movePanel(solo,id,"centre").layout;seed(solo);clickChip()'); await pause(50);
    assert.equal(await run('document.querySelector(".room-detail-grid").classList.contains("left-empty")'), true);
    await run('clickChip()'); await pause(50); assert.equal(await run('!document.querySelector(".room-detail-grid").classList.contains("left-empty")'), true);
    checks.push('empty People column collapses and restores through the dock model');

    await run('window.child=window.open("about:blank","people-toggle");void 0'); await pause(150);
    await run('child.document.head.innerHTML=document.head.innerHTML;popups[model.dockWindowFrameName("w1")]=child;var detached=model.movePanel(model.resetDockLayout(),"people","right").layout;seed(model.detachPanel(detached,"people").layout);void 0'); await pause(100);
    const leftBefore = await run('current().zones.left');
    assert.equal(await run('!!tab("people",child.document)&&!tab("people")'), true);
    await run('clickChip()'); await pause(100); assert.equal(await run('!tab("people",child.document)&&model.isPanelHidden(current(),"people")'), true);assert.deepEqual(await run('current().zones.left'),leftBefore);
    await run('clickChip()'); await pause(100); assert.equal(await run('model.zoneOfPanel(current(),"people")'), 'right');
    checks.push('hide People in a separate window and restore to its home column');

    await run('var last=model.resetDockLayout();for(var id of model.DOCK_PANEL_IDS.filter(id=>id!=="people"))last=model.hidePanel(last,id).layout;seed(last);clickChip()'); await pause(50);
    assert.equal(await run('!model.isPanelHidden(current(),"people")&&!!tab("people")&&document.querySelector(".room-people-chip").getAttribute("aria-expanded")==="true"'), true);
    assert.equal(await run('notes.includes(t("rooms.dock.refuse.lastGroup"))'), true);
    checks.push('last docked panel remains visible and the refusal is explained');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    console.log('People toggle regression:', JSON.stringify({ ok: true, checks, output: out }));
    await run('dom.flushSync(()=>tree.unmount());child.close();void 0');clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(e => { console.error(e); console.error('Fixture output:', out); clearTimeout(deadline); app.exit(1); });
}
