// Real React/Electron UI with synthetic reports only: no rooms, network or user clipboard.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-diagnostics-'));
  app.setPath('userData', path.join(output, 'profile'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Diagnostics UI deadline'); app.exit(1); }, 60_000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 900,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file|data|blob):/.test(details.url) }));
    win.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message); });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/components/Modal.css', 'renderer/components/RoomDiagnostics.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(output, 'preview.html');
    fs.writeFileSync(page, '<html lang="ru"><style>' + css + '</style><div id="root"></div></html>');
    await win.loadFile(page);
    await win.webContents.executeJavaScript(`
      var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),cache={};
      var helpers=require(path.join(root,'dist/electron/shared/room-diagnostics.js'));
      var monitor=new helpers.RoomConnectionMonitor(2,()=>1000);monitor.trackerAck(0);monitor.identified();monitor.synced();
      window.report=helpers.buildRoomDiagnosticReport({name:'PRIVATE',code:'PRIVATE',members:[],files:[],transfers:{},
        connection:monitor.snapshot({pending:0,open:1,identified:1,syncing:0,direct:1,turn:0,unknown:0},false,false)},
        {state:'ready'},false,'3.0.7');
      window.mode='normal';window.copied='';window.retryCount=0;window.exportSuccess=false;window.exportCount=0;
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text}}});
      window.api={rooms:{diagnose:async()=>mode==='defer'?await new Promise((resolve,reject)=>{window.pending={resolve,reject}}):structuredClone(report),
        retryConnection:async()=>{retryCount++;return structuredClone(report)},exportDiagnostics:async()=>{exportCount++;return {success:exportSuccess}}}};
      function load(p){
        if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
        const src=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',src)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t:k=>dict[k]||k,language:'ru'})};
          if(s==='./index')return {Button:load(path.join(root,'renderer/components/Button.tsx')).Button,
            Icon:load(path.join(root,'renderer/components/Icon.tsx')).default,Modal:load(path.join(root,'renderer/components/Modal.tsx')).Modal};
          if(s.startsWith('.')){const q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}
          return require(path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      window.view=ReactDOM.createRoot(document.getElementById('root'));
      window.mount=id=>require(path.join(root,'node_modules/react-dom')).flushSync(()=>view.render(React.createElement(
        load(path.join(root,'renderer/components/RoomDiagnostics.tsx')).RoomDiagnostics,{roomId:id,onClose:()=>{window.closed=true}})));
      window.click=key=>{const b=Array.from(document.querySelectorAll('.um-foot button')).find(b=>b.textContent.trim()===dict[key]);if(!b)throw Error(key);b.click();return b.disabled};
      mount('room-a');void 0;
    `);
    const run = code => win.webContents.executeJavaScript(code);
    const settle = () => new Promise(resolve => setTimeout(resolve, 120));
    await settle();
    assert.equal(await run('document.querySelectorAll(".room-diag-features section").length'), 3);
    assert.equal(await run('document.body.innerText.includes("rooms.diag.")'), false);
    await run('click("rooms.diag.copy")'); await settle();
    assert.equal(await run('copied.includes("PRIVATE")'), false); assert.equal(await run('JSON.parse(copied).schema'), 1);
    await run('click("rooms.diag.export")'); await settle();
    assert.equal(await run('exportCount'), 1); assert.equal(await run('document.body.innerText.includes(dict["rooms.diag.exported"])'), false);
    await run('exportSuccess=true;click("rooms.diag.export")'); await settle();
    assert.equal(await run('document.body.innerText.includes(dict["rooms.diag.exported"])'), true);
    await run('mode="defer";void 0');
    for (let i = 0; i < 40 && !await run('!!window.pending'); i++) await settle();
    assert.equal(await run('!!window.pending'), true);
    await run('click("rooms.diag.retry")'); await settle();
    await run('pending.reject(new Error("STALE_REFRESH_ERROR"));mode="normal";void 0'); await settle();
    assert.equal(await run('retryCount'), 1); assert.equal(await run('document.body.innerText.includes("STALE_REFRESH_ERROR")'), false);
    await run('report.connection.phase="suspended";mount("room-b")'); await settle();
    assert.equal(await run('click("rooms.diag.retry")'), true); assert.equal(await run('retryCount'), 1);
    await run('report.connection.phase="ready";mount("room-c");document.documentElement.style.setProperty("--radius-md","12px");document.documentElement.style.setProperty("--radius-lg","20px");void 0'); await settle();
    assert.equal(await run('getComputedStyle(document.querySelector(".room-diag-features section")).borderRadius'), '12px');
    for (const width of [1100, 700, 400]) {
      win.setContentSize(width, 900); await settle();
      const fits = await run(`Array.from(document.querySelectorAll('.um-foot button,.room-diag-features section')).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})`);
      assert.equal(fits, true, `controls fit at ${width}px`);
      fs.writeFileSync(path.join(output, `diagnostics-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await run('view.unmount();void 0'); win.destroy();
    console.log('Room diagnostics UI smoke passed:', output);
    clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
