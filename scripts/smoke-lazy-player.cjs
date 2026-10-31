/* eslint-disable @typescript-eslint/no-require-imports -- Native acceptance of the actual loading shell. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-lazy-player-')),env={...process.env,HAVVN_LAZY_PLAYER:scratch};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1});child.on('close',code=>{
    const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('havvn-lazy-player-'))throw Error('Unexpected profile');
    fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});if(code!==0)process.exitCode=1;
  });
}else{
  const {app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_LAZY_PLAYER||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-lazy-player-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile'));const deadline=setTimeout(()=>app.exit(1),40000);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,width:480,height:700,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});win.webContents.setZoomFactor(1.25);
    const output=path.join(root,'artifacts/heavy-sections/lazy-player');fs.mkdirSync(output,{recursive:true});
    const css=require('./smoke-ui-fonts.cjs')(root)+['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/components/Modal.css'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');
    const html=path.join(scratch,'fixture.html');fs.writeFileSync(html,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'#root{padding:20px}.um-backdrop,.um-card{animation:none!important}</style><div id="root"></div></html>');
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});await win.loadFile(html);
    const run=code=>win.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),until=async code=>{const end=Date.now()+5000;while(!await run(code)){if(Date.now()>end)throw Error('UI deadline: '+code);await wait(20)}};
    await run(`var fixtureRoot=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),packageRequire=require('node:module').createRequire(path.join(fixtureRoot,'package.json')),React=packageRequire('react'),dom=packageRequire('react-dom'),createRoot=packageRequire('react-dom/client').createRoot,ts=packageRequire('typescript'),cache={},dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key;
      var resolvePlayer,loads=0,mounts=0,active=0,lastProps;window.__lazyPlayerModule=new Promise(resolve=>{resolvePlayer=resolve});
      function load(file){if(cache[file])return cache[file].exports;var module={exports:{}};cache[file]=module;var source=fs.readFileSync(file,'utf8');
        if(file.endsWith('LazyStreamPlayer.tsx')){if(!source.includes("import('./StreamPlayerModal')"))throw Error('Player import seam changed');source=source.replace("import('./StreamPlayerModal')",'(loads++,window.__lazyPlayerModule)')}
        var js=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return{};if(name.includes('i18nContext'))return{useTranslation:()=>({t,language:'ru'})};if(!name.startsWith('.'))return packageRequire(name);var target=path.resolve(path.dirname(file),name);if(!path.extname(target))target=['.tsx','.ts','.js'].map(ext=>target+ext).find(candidate=>fs.existsSync(candidate));return load(target)},module,module.exports);return module.exports}
      var Player=load(path.join(fixtureRoot,'renderer/components/LazyStreamPlayer.tsx')).StreamPlayerModal;
      function Surface(){var[open,setOpen]=React.useState(false);return React.createElement(React.Fragment,null,React.createElement('button',{'data-open':true,className:'btn btn-secondary',onClick:()=>setOpen(true)},'Открыть плеер'),open&&React.createElement(Player,{downloadId:'fixture',downloadName:'Очень длинное название видео для проверки окна загрузки плеера.webm',initialFilePath:'folder/movie.webm',historyPlayback:true,onClose:()=>setOpen(false)}))}
      function Loaded(props){mounts++;lastProps=props;React.useEffect(()=>{active++;return()=>active--},[]);return React.createElement('div',{'data-player':true},React.createElement('button',{'data-close':true,onClick:props.onClose},'Закрыть'))}
      var tree=createRoot(document.getElementById('root'));dom.flushSync(()=>tree.render(React.createElement(Surface)));document.querySelector('[data-open]').focus();void 0;`);
    const checks=[],record=(value,label)=>{assert(value,label);checks.push(label);console.log('PASS '+label)};
    record(await run('loads===0&&mounts===0'),'opening the page does not request player code');
    await run('document.querySelector("[data-open]").click()');await until('!!document.querySelector(".um-card [role=status]")');
    record(await run('loads===1&&mounts===0'),'pending player code shows the actual accessible loading modal');
    record(await run('document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll(".um-card button")].every(b=>b.scrollWidth<=b.clientWidth+1)'),'Russian loading dialog fits a narrow window at 125 percent');
    await wait(450);fs.writeFileSync(path.join(output,'loading-ru.png'),(await win.webContents.capturePage()).toPNG());
    await run('document.querySelector(".um-x").click()');await until('!document.querySelector(".um-card")');
    record(await run('document.activeElement.hasAttribute("data-open")'),'cancel restores focus before the chunk arrives');
    await run('resolvePlayer({default:Loaded});void 0');await wait(100);
    record(await run('mounts===0&&!document.querySelector("[data-player]")'),'late chunk completion does not reopen a canceled player');
    for(let index=0;index<3;index++){await run('document.querySelector("[data-open]").click()');await until('!!document.querySelector("[data-player]")');await run('document.querySelector("[data-close]").click()');await until('!document.querySelector("[data-player]")')}
    record(await run('loads===1&&mounts===3&&active===0'),'reopening reuses loaded code and releases every mounted player');
    record(await run('lastProps.downloadId==="fixture"&&lastProps.initialFilePath==="folder/movie.webm"&&lastProps.historyPlayback===true'),'history and selected-file props reach the loaded player');
    await run('tree.unmount();void 0');assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({checks,errors},null,2));clearTimeout(deadline);app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
