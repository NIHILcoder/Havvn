// Real React dialog with fixture IPC in a hidden, isolated Electron profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..');
  const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-key-rotation-ui-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Key rotation UI deadline'); app.exit(1); }, 30_000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 820, height: 1000,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/components/Modal.css', 'renderer/components/NumberInput.css', 'renderer/pages/rooms/RoomKeyRotationModal.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'rotation.html');
    fs.writeFileSync(html, `<html class="dark" lang="ru"><style>${css}\n*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = code => win.webContents.executeJavaScript(code);
    await run(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
      var flush=require(path.join(root,'node_modules/react-dom')).flushSync, cache={};
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k;
      function load(p){
        if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{
          if(s.endsWith('.css'))return {};
          if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.includes('hostWindow'))return {useHostWindow:()=>({window,document})};
          if(s==='../../components')return {...load(path.join(root,'renderer/components/Button.tsx')),...load(path.join(root,'renderer/components/Modal.tsx'))};
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));
        },m,m.exports);return m.exports;
      }
      window.state={roomId:'fixture',code:'first',canManage:true,e2e:true};window.calls=[];window.fail=false;window.hold=false;
      window.api={rooms:{rotateKey:async id=>{calls.push(['now',id]);if(hold)await new Promise(r=>window.finish=r);if(fail)throw Error('Fixture rejection');state={...state,code:state.code+'-next'};return state;},
        setKeyRotation:async(id,plan)=>{calls.push(['schedule',id,plan]);state={...state,keyRotation:plan?{ownerId:'owner',intervalMinutes:plan.intervalMinutes,remaining:plan.repetitions||null,nextAt:Date.now()+plan.intervalMinutes*60000}:undefined};return state;}}};
      var C=load(path.join(root,'renderer/pages/rooms/RoomKeyRotationModal.tsx')).RoomKeyRotationModal;
      var mounted=ReactDOM.createRoot(document.getElementById('root'));
      window.render=()=>flush(()=>mounted.render(React.createElement(C,{room:state,onClose:()=>{}})));
      window.button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
      window.input=(index,value)=>{var el=document.querySelectorAll('input')[index];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
      render();void 0;
    `);
    const wait = () => new Promise(resolve => setTimeout(resolve, 100));
    await wait();
    assert.equal(await run(`document.querySelectorAll('input[type=number]').length`), 2);
    await run(`button('Сменить ключ сейчас').click()`); await wait();
    assert.equal(await run(`calls.filter(c=>c[0]==='now').length`), 1);
    assert.equal(await run(`document.body.textContent.includes('Ключ сменён')`), true);
    await run(`input(0,'5');input(1,'3')`); await wait();
    await run(`button('Запустить расписание').click()`); await wait();
    assert.deepEqual(await run(`calls.at(-1)`), ['schedule', 'fixture', { intervalMinutes: 5, repetitions: 3 }]);
    assert.equal(await run(`document.body.textContent.includes('Осталось смен: 3')`), true);
    await run(`button('Остановить расписание').click()`); await wait();
    assert.equal(await run(`calls.at(-1)[2]`), null);
    assert.equal(await run(`!!button('Остановить расписание')`), false);
    await run(`input(0,'0')`); await wait();
    assert.equal(await run(`button('Запустить расписание').disabled`), true);
    await run(`input(0,'60');input(1,'0')`); await wait();
    await run(`button('Запустить расписание').click()`); await wait();
    assert.equal(await run(`document.body.textContent.includes('Осталось смен: ∞')`), true);
    await run(`fail=true;button('Сменить ключ сейчас').click()`); await wait();
    assert.equal(await run(`document.querySelector('[role=alert]').textContent.includes('Не удалось выполнить действие')`), true);
    assert.equal(await run(`document.querySelector('[role=alert]').textContent.includes('Fixture rejection')`), false);
    await run(`fail=false;hold=true;button('Сменить ключ сейчас').click()`); await wait();
    assert.equal(await run(`button('Сменить ключ сейчас').disabled`), true);
    await run(`finish();hold=false`); await wait();
    win.webContents.invalidate(); await wait();
    fs.writeFileSync(path.join(out, 'rotation.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run(`document.querySelector('[role=dialog]').scrollWidth <= document.querySelector('[role=dialog]').clientWidth`), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, manual: true, finiteSchedule: true, unlimitedSchedule: true, cancellation: true, errors: true, pendingDisabled: true, screenshot: path.join(out, 'rotation.png') }));
    clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
