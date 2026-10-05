// Real React controls in isolated Electron; fixture IPC only, no user's rooms.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-data-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  const deadline = setTimeout(() => { console.error('Room data UI smoke deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 760, height: 820, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') {errors.push(details.message);console.error('Renderer:',details.message);} });
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/components/Modal.css',
      'renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css','renderer/components/VoiceSettingsModal.css',
      'renderer/pages/RoomsPage.css','renderer/pages/rooms/RoomServerPanel.css','renderer/pages/rooms/RoomDataModal.css'].map(p => fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html = path.join(out, 'controls.html');
    fs.writeFileSync(html, `<html class="dark" lang="ru"><style>${css}\n#root{padding:16px;max-width:640px;margin:auto;height:740px;overflow:auto}body{overflow:auto}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch(e) {console.error('UI step:',code.slice(0,180));throw e;} };
    await run(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), ReactDOM=require(path.join(root,'node_modules/react-dom/client')), flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k, cache={}, notes=[];
      var toast=Object.assign(v=>notes.push(v),{success:v=>notes.push(v),error:v=>notes.push(v)});
      function load(p){
        if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.includes('hostToast'))return {useHostToast:()=>toast};
          if(s.includes('hostWindow'))return {REAL_HOST:window.realHost||(window.realHost={window,document}),useHostWindow:()=>window.realHost,usePortalTarget:()=>document.body,HostWindowProvider:({children})=>children};
          if(s.includes('popout'))return {usePopout:()=>({popout:null,portal:()=>null,openPopout:()=>{},closePopout:()=>{}})};
          if(s==='../../components')return Object.assign({},...['Button','Icon','Select','Toggle','Modal','ConfirmDialog'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      window.calls=[];window.failRead=false;window.failClean=false;window.failExport=false;window.failImport=false;window.closeCount=0;
      var usage={previewId:'preview',plaintext:4000,ciphertext:8000,protectedCiphertext:6000,originals:10000,removable:6000,skipped:1,files:[{fileId:'one',name:'Downloaded file with a long name.bin',plaintext:4000,ciphertext:2000,removable:6000,original:false},{fileId:'source',name:'My protected source file.bin',plaintext:0,ciphertext:6000,removable:0,original:true}]};
      var records=Array.from({length:123},(_,i)=>({kind:'chat',message:{id:String(i),memberId:'peer',name:'Alice',text:'Message '+i,at:Date.now()}}));
      window.api={rooms:{diskUsage:async()=>{if(failRead)throw Error('Storage unavailable');return structuredClone(usage)},
        localHistory:async(id,kind,before)=>{calls.push(['page',before]);var end=before===undefined?records.length:records.findIndex(item=>item.message.id===before),start=Math.max(0,end-50);return {items:records.slice(start,end),next:start?records[start].message.id:undefined,cursorExpired:false,retentionDays:30}},
        cleanupCopies:async(id,preview,ids)=>{calls.push(['clean',preview,ids]);if(failClean)throw Error('File changed; refresh');usage.removable=0;usage.files[0].removable=0;return {bytes:6000,files:1}},
        setHistoryRetention:async(id,days)=>{calls.push(['retention',days]);return days},
        exportIdentity:async(password)=>{calls.push(['export',password]);if(failExport)throw Error('Disk full');return {success:true}},
        importIdentity:async(password)=>{calls.push(['import',password]);if(failImport)throw Error('Incorrect password');return {success:true,rooms:1}}},relaunchApp:async()=>{calls.push(['restart']);return {ok:true}}};
      var mounted=null;
      window.mount=(name,props={})=>{if(mounted)flush(()=>mounted.unmount());document.getElementById('root').replaceChildren();mounted=ReactDOM.createRoot(document.getElementById('root'));
        var C=load(path.join(root,'renderer/pages/rooms/'+name+'.tsx'))[name],Provider=load(path.join(root,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
        flush(()=>mounted.render(React.createElement(Provider,null,React.createElement(C,{roomId:'room',onClose:()=>{window.closeCount++},...props}))));};
      window.setInput=(index,value)=>{var el=document.querySelectorAll('input')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      window.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
      mount('RoomDataModal');void 0;
    `);
    const wait=(ms=100)=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async(code,label)=>{const end=Date.now()+10000;while(!await run(code)){if(Date.now()>end)throw Error('UI timeout: '+label);await wait(50)}};
    const capture=async(name)=>{win.webContents.invalidate();await wait(350);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG())};
    await until(`document.querySelectorAll('.room-data-stats span').length===4`,'usage loaded');
    assert.equal(await run(`document.querySelectorAll('select').length`),0,'custom themed selects');
    assert.equal(await run(`document.querySelector('.room-data-list label:last-child [role=switch]').disabled`),true,'source protection');
    await run(`button(t('rooms.chatShowEarlier')).click()`);await wait();
    assert.equal(await run(`document.querySelectorAll('.room-data-history article').length`),100,'local history pages');
    await run(`document.querySelector('.room-data-toggle [role=switch]').click();failClean=true`);await wait();
    await run(`button('Очистить локальные копии').click()`);await wait();
    await until(`!!button('Подтвердить')`,'cleanup confirmation');await run(`button('Подтвердить').click()`);await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent.includes('File changed')`),true,'cleanup failure');
    assert.equal(await run(`document.querySelector('.room-data-toggle [role=switch]').getAttribute('aria-checked')`),'true','selection retained');
    await run(`failClean=false;button('Очистить локальные копии').click()`);await wait();await run(`button('Подтвердить').click()`);await wait();
    assert.equal(await run(`!!document.querySelector('[role=status]')`),true,'cleanup result');
    assert.equal(await run(`calls.filter(c=>c[0]==='clean').every(c=>c[2].length===1&&c[2][0]==='one')`),true,'no protected source selected');
    await capture('data-dark');
    const themePath=path.join(root,'themes/nihil-aero-midnight.havvn-theme.json');
    if(fs.existsSync(themePath)){const theme=JSON.parse(fs.readFileSync(themePath,'utf8'));await run(`for(var [key,value] of Object.entries(${JSON.stringify(theme.dark)}||{}))document.documentElement.style.setProperty(key,value)`)}
    win.setSize(380,760);await wait();await run(`mount('RoomDataModal')`);await wait();
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`),true,'data narrow layout');await capture('data-aero-narrow');
    await run(`mount('RoomBackupModal',{mode:'export'})`);await wait();
    assert.equal(await run(`button('Защищённая резервная копия').disabled`),true,'blank password blocked');
    await run(`setInput(0,'long backup password');setInput(1,'mismatched password');document.querySelector('[role=switch]').click()`);await wait();
    assert.equal(await run(`button('Защищённая резервная копия').disabled`),true,'password repeat mismatch blocked');
    await run(`setInput(1,'long backup password');failExport=true;button('Защищённая резервная копия').click()`);await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent`),'Disk full');
    assert.equal(await run(`document.querySelector('input').value`),'long backup password','failed export retry');
    assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth`),true,'backup narrow layout');await capture('backup-aero-narrow');
    await run(`failExport=false;button('Защищённая резервная копия').click()`);await wait();
    assert.equal(await run(`document.querySelector('input').value`),'','clear password after export');
    await run(`mount('RoomBackupModal',{mode:'import'});failImport=true;setInput(0,'long backup password');document.querySelector('[role=switch]').click()`);await wait();
    await run(`button('Восстановить копию').click()`);await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent`),'Incorrect password');
    await run(`failImport=false;button('Восстановить копию').click()`);await wait();
    assert.equal(await run(`document.querySelectorAll('input').length`),0,'no password retained after restore');
    assert.equal(await run(`!!button('Перезапустить Havvn')`),true,'restoration requires restart');await run(`button('Перезапустить Havvn').click()`);await wait();
    assert.equal(await run(`calls.some(c=>c[0]==='restart')`),true);
    assert.deepEqual(errors,[]);
    console.log('Room data UI smoke passed. Screenshots: '+out);clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
