// Regression for browser pointer/focus ordering, not programmatic option.click().
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawn(require('electron'),[__filename,...process.argv.slice(2)],{env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
}else{
  const{app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/select-input-20261031');
  const probe=process.argv.includes('--probe'),result={runtime:process.versions.electron,checks:[],nativePointerEvents:true};
  fs.mkdirSync(out,{recursive:true});app.setPath('userData',fs.mkdtempSync(path.join(out,'profile-')));app.disableHardwareAcceleration();
  const deadline=setTimeout(()=>{console.error('Select input deadline');app.exit(1);},45000);let win;
  app.whenReady().then(async()=>{
    const css=require('./smoke-ui-fonts.cjs')(root)+['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/components/Select.css'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');
    const page=path.join(out,'fixture.html');fs.writeFileSync(page,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'body{padding:24px}#root{max-width:420px}section{margin-bottom:20px}</style><div id="root"></div></html>');
    win=new BrowserWindow({show:false,width:640,height:650,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true,backgroundThrottling:false}});
    await win.loadFile(page);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    const run=code=>win.webContents.executeJavaScript(code),pause=ms=>new Promise(r=>setTimeout(r,ms));
    await run(`var root=${JSON.stringify(root)},probe=${probe},fs=require('node:fs'),path=require('node:path'),pr=require('node:module').createRequire(path.join(root,'package.json')),ts=pr('typescript'),React=pr('react'),dom=pr('react-dom'),createRoot=pr('react-dom/client').createRoot,cache={},calls=[],trace=[];
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;var source=fs.readFileSync(file,'utf8');if(probe&&file.endsWith('Select.tsx'))source=source.replace('onMouseDown={event => event.preventDefault()}','');var js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
      new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return {};if(name.includes('i18nContext'))return {useTranslation:()=>({t:key=>key,language:'ru'})};if(name.startsWith('.')){var p=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts'])if(fs.existsSync(p+ext))return load(p+ext);throw Error(p);}return pr(name);},m,m.exports);return m.exports;}
      var Select=load(path.join(root,'renderer/components/Select.tsx')).Select;
      var definitions=[['language','en',[['en','English'],['ru','Русский']]],['style','dark',[['dark','Dark'],['light','Light']]],['background','none',[['none','None'],['grid','Grid']]]];
      function Field({item}){var [value,setValue]=React.useState(()=>localStorage.getItem(item[0])||item[1]);return React.createElement('section',{'data-field':item[0]},React.createElement(Select,{ariaLabel:item[0],value,options:item[2].map(([value,label])=>({value,label})),onChange:next=>{calls.push([item[0],next]);localStorage.setItem(item[0],next);setValue(next);}}));}
      var tree;function mount(){if(tree)dom.flushSync(()=>tree.unmount());tree=createRoot(document.querySelector('#root'));dom.flushSync(()=>tree.render(React.createElement(React.Fragment,null,...definitions.map(item=>React.createElement(Field,{key:item[0],item})),React.createElement('button',{id:'outside'},'Outside'))));}
      for(var name of ['mousedown','focusout','click'])document.addEventListener(name,event=>trace.push({event:name,role:event.target.getAttribute?.('role'),relatedRole:event.relatedTarget?.getAttribute?.('role')}),true);mount();true;`);
    const click=async selector=>{
      const rect=await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      await win.webContents.sendInputEvent({type:'mouseMove',...rect});await win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...rect});
      await pause(35);await win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...rect});await pause(180);
    };
    const check=async(label,expression)=>{const passed=!!await run(expression);result.checks.push({label,passed});if(!probe)assert(passed,label);};
    for(const [field,value]of[['language','ru'],['style','light'],['background','grid']]){
      await click('[data-field="'+field+'"] [role=combobox]');
      await run(`document.querySelector('[data-field="${field}"] [role=combobox]').focus();true;`);
      await click('[data-field="'+field+'"] [role=option]:nth-child(2)');
      await check('Native click applies '+field,`localStorage.getItem('${field}')==='${value}'&&calls.filter(c=>c[0]==='${field}').length===1`);
      await check('Pointer choice preserves combobox focus '+field,`document.activeElement===document.querySelector('[data-field="${field}"] [role=combobox]')`);
    }
    await run('mount();true;');
    await check('Selections survive remount',`[...document.querySelectorAll('[role=combobox]')].map(el=>el.textContent.trim()).join('|')==='Русский|Light|Grid'`);
    await click('[data-field="language"] [role=combobox]');await click('#outside');
    await check('Outside click closes the list',`document.querySelector('[data-field="language"] [role=combobox]').getAttribute('aria-expanded')==='false'`);
    await run(`var trigger=document.querySelector('[data-field="language"] [role=combobox]');trigger.focus();function key(name){dom.flushSync(()=>trigger.dispatchEvent(new KeyboardEvent('keydown',{key:name,bubbles:true})));}key('ArrowDown');key('Home');key('Enter');true;`);
    await check('Keyboard choice still applies',`localStorage.getItem('language')==='en'`);
    await click('[data-field="style"] [role=combobox]');await run(`dom.flushSync(()=>document.querySelector('#outside').focus());true;`);
    await check('Focus leaving the control closes the menu',`document.querySelector('[data-field="style"] [role=combobox]').getAttribute('aria-expanded')==='false'`);
    result.trace=await run('trace');result.status=result.checks.every(c=>c.passed)?'passed':'failed';
    fs.writeFileSync(path.join(out,probe?'before.png':'after.png'),(await win.webContents.capturePage()).toPNG());
  }).catch(error=>{console.error(error);result.status='failed';result.error=String(error);}).finally(()=>{
    clearTimeout(deadline);if(win&&!win.isDestroyed())win.destroy();fs.writeFileSync(path.join(out,probe?'before.json':'after.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));app.exit(result.status==='passed'?0:1);
  });
}
