// Real React overlays in isolated Electron; no IPC, accounts or user rooms.
if (!process.versions.electron) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {env, windowsHide:true, stdio:'inherit'});
  child.on('error', e => {console.error(e);process.exitCode=1;});
  child.on('exit', code => {process.exitCode=code??1;});
} else {
  const {app,BrowserWindow}=require('electron'), fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
  const root=path.resolve(__dirname,'..'), out=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'havvn-room-overlays-'));
  app.setPath('userData',path.join(out,'profile'));app.disableHardwareAcceleration();app.commandLine.appendSwitch('in-process-gpu');
  const deadline=setTimeout(()=>{console.error('Overlay smoke deadline');app.exit(1);},60000);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:600,height:500,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
    win.webContents.setWindowOpenHandler(({url,frameName}) => url==='about:blank'&&frameName==='overlay-fixture'
      ? {action:'allow',overrideBrowserWindowOptions:{show:false,width:360,height:400,webPreferences:{backgroundThrottling:false,offscreen:false}}} : {action:'deny'});
    const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message);});
    const css=require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/pages/RoomsPage.css','renderer/components/ProfileCard.css'].map(p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html=path.join(out,'overlays.html');fs.writeFileSync(html,`<html class="dark"><style>${css}\n#root{padding:16px}#panel{height:130px;overflow:auto}#content{height:800px}.overlay-member-trigger{justify-content:flex-start;max-width:100%;min-height:42px;padding:8px 12px}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run=code=>win.webContents.executeJavaScript(code), pause=ms=>new Promise(r=>setTimeout(r,ms));
    await run(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), dom=require(path.join(root,'node_modules/react-dom')), createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/en.json'),'utf8')),cache={};
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t:k=>dict[k]||k})};
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var Profile=load(path.join(root,'renderer/components/ProfileCard.tsx')).ProfileCard, Menu=load(path.join(root,'renderer/components/DropdownMenu.tsx')).DropdownMenu;
      var Button=load(path.join(root,'renderer/components/Button.tsx')).Button, Avatar=load(path.join(root,'renderer/components/Avatar.tsx')).Avatar;
      var member={memberId:'fixture',name:'Анна',avatarSeed:'fixture',online:true,isSelf:true,have:[],protocolVersion:1};
      window.selected=0;window.longStatus=false;window.manage=false;window.mode='profile';var mounted=null;
      function Fixture(){var [anchor,setAnchor]=React.useState(null);return React.createElement('div',{id:'panel'},React.createElement('div',{id:'content'},
        mode==='profile'?React.createElement(Button,{id:'trigger',type:'button',variant:'secondary',size:'sm',className:'overlay-member-trigger',onClick:e=>setAnchor(e.currentTarget)},React.createElement(Avatar,{seed:member.avatarSeed,size:24,online:true}),member.name):React.createElement(Menu,{portal:true,renderTrigger:({toggle})=>React.createElement(Button,{id:'trigger',type:'button',variant:'secondary',size:'sm',onClick:toggle},'Меню'),items:Array.from({length:25},(_,i)=>({key:String(i),label:'Action '+i,onSelect:()=>selected++}))})),
        mode==='profile'&&anchor?React.createElement(Profile,{member:{...member,isSelf:!manage,status:longStatus?Array.from({length:40},()=> 'Long participant status').join('\\n'):''},totalFiles:0,anchor,canManage:manage,onMuteToggle:manage?()=>{}:undefined,onKick:manage?()=>{}:undefined,onTransfer:manage?()=>{}:undefined,onClose:()=>setAnchor(null)}):null);}
      window.reset=(kind,long=false)=>{if(mounted)dom.flushSync(()=>mounted.unmount());document.querySelector('#root').replaceChildren();mode=kind;longStatus=long;mounted=createRoot(document.querySelector('#root'));dom.flushSync(()=>mounted.render(React.createElement(Fixture)));};
      reset('profile');void 0;
    `);
    const open=async(kind,long=false)=>{await run(`reset(${JSON.stringify(kind)},${long});document.querySelector('#trigger').click()`);await pause(250);};
    const count=kind=>run(`document.querySelectorAll(${JSON.stringify(kind==='profile'?'.profile-card':'[role=menu]')}).length`);
    const report={};
    for(const kind of ['profile','menu']){
      await open(kind);assert.equal(await count(kind),1);
      await run(`document.querySelector('#panel').scrollTop=35`);await pause(250);report[kind+'ScrollDismissed']=(await count(kind))===0;
      await open(kind);await run(`document.querySelector('#panel').style.display='none'`);await pause(350);report[kind+'HiddenDismissed']=(await count(kind))===0;
      await open(kind);await run(`document.querySelector('#trigger').remove()`);await pause(350);report[kind+'RemovedDismissed']=(await count(kind))===0;
      await open(kind);win.setSize(590,480);await pause(250);report[kind+'ResizeDismissed']=(await count(kind))===0;win.setSize(600,500);await pause(100);
    }
    await run('manage=true;dict=JSON.parse(fs.readFileSync(path.join(root,"renderer/i18n/ru.json"),"utf8"));');
    for(const width of [260,400]){
      win.setSize(width,440);await pause(100);await open('profile');
      const fits=await run('(()=>{const card=document.querySelector(".profile-card"),bounds=card.getBoundingClientRect(),buttons=[...card.querySelectorAll(".profile-card-act")];return buttons.length===3 && buttons.every((button,i)=>{const r=button.getBoundingClientRect();return r.left>=bounds.left && r.right<=bounds.right && button.scrollWidth<=button.clientWidth+1 && (i===0||r.top>=buttons[i-1].getBoundingClientRect().bottom+4);});})()');
      assert.equal(fits,true,'all owner action labels must fit at '+width);
      win.webContents.invalidate();await pause(350);fs.writeFileSync(path.join(out,'profile-actions-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await run('manage=false;dict=JSON.parse(fs.readFileSync(path.join(root,"renderer/i18n/en.json"),"utf8"));');
    win.setSize(220,280);await pause(150);await open('profile',true);
    const geometry=await run(`(()=>{const el=document.querySelector('.profile-card'),r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,scrollable:el.scrollHeight>el.clientHeight};})()`);
    report.smallProfileFits=geometry.left>=7&&geometry.right<=geometry.w-7&&geometry.top>=7&&geometry.bottom<=geometry.h-7&&geometry.scrollable;
    await run(`document.querySelector('.profile-card').scrollTop=30`);await pause(200);report.internalProfileScrollRetained=(await count('profile'))===1;
    await open('menu');await run(`document.querySelector('[role=menu]').scrollTop=30`);await pause(200);report.internalMenuScrollRetained=(await count('menu'))===1;
    await run(`document.querySelector('[role=menuitem]').click()`);await pause(100);report.menuSelectionWorks=(await run('selected'))===1&&(await count('menu'))===0;
    win.setSize(600,500);await pause(100);await run("reset('profile')");
    await run("window.childView=window.open('about:blank','overlay-fixture');void 0");await pause(300);
    await run("childView.document.head.innerHTML=document.head.innerHTML;childView.document.body.innerHTML='<div id=root></div>';dom.flushSync(()=>mounted.render(dom.createPortal(React.createElement(Fixture),childView.document.querySelector('#root'))));childView.document.querySelector('#trigger').click()");await pause(350);
    report.detachedProfileUsesOwnDocument=await run("!document.querySelector('.profile-card') && !!childView.document.querySelector('.profile-card')");
    await run("document.dispatchEvent(new Event('scroll'))");await pause(150);
    report.mainScrollPreservesDetachedProfile=await run("!!childView.document.querySelector('.profile-card')");
    await run("childView.document.querySelector('#panel').scrollTop=30");await pause(250);
    report.detachedScrollDismissed=await run("!childView.document.querySelector('.profile-card')");
    await run("childView.document.querySelector('#panel').scrollTop=0;childView.document.querySelector('#trigger').click()");await pause(250);
    await run("document.querySelector('#root').appendChild(childView.document.querySelector('#panel'));void 0");await pause(250);
    report.reparentedAnchorDismissed=await run("!childView.document.querySelector('.profile-card') && !document.querySelector('.profile-card')");
    await run("childView.close()");
    report.rendererErrors=errors;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({report,geometry},null,2));console.log('Overlay regression:',JSON.stringify({report,geometry,output:out}));
    for(const [name,value] of Object.entries(report))if(name!=='rendererErrors')assert.equal(value,true,name);
    assert.deepEqual(errors,[]);clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(e=>{console.error(e);console.error('Fixture logs:',out);clearTimeout(deadline);app.exit(1);});
}
