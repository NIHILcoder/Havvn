/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS Electron fixture. */
// Actual swarm map, offline sample statistics, private Electron profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.resolve(root, process.env.HAVVN_SWARM_ARTIFACTS || 'artifacts/swarm-ui');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-swarm-ui-')));
  app.disableHardwareAcceleration();
  const checks = [], errors = []; let win;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = code => win.webContents.executeJavaScript(code);
  const until = async (code, label) => { const end = Date.now()+5000; while(!await run(code)){ if(Date.now()>end)throw Error(label); await pause(30); } };
  const deadline = setTimeout(() => { console.error('Swarm UI deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', details => { if(details.level==='error')errors.push(details.message); });
    const sheets = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/pages/SwarmPage.css'];
    const css = require('./smoke-ui-fonts.cjs')(root)+sheets.map(file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html = path.join(out,'fixture.html');
    fs.writeFileSync(html,`<!doctype html><html data-theme="dark"><meta charset="utf-8"><style>${css}html,body,#root{width:100%;height:100%;margin:0}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client')),flush=require(path.join(root,'node_modules/react-dom')).flushSync;
      var language='ru',dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key,cache={};
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;
        var code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',code)(name=>{
          if(name.endsWith('.css'))return {};
          if(name.includes('i18nContext'))return {useTranslation:()=>({t,language})};
          if(name.endsWith('/components'))return load(path.join(root,'renderer/components/Icon.tsx'));
          if(name.endsWith('.geojson'))return JSON.parse(fs.readFileSync(path.resolve(path.dirname(file),name),'utf8'));
          if(name.startsWith('.')){var p=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts'])if(fs.existsSync(p+ext))return load(p+ext);throw Error(p)}
          return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));
        },m,m.exports);return m.exports;}
      var populated={points:['RU','US','DE','FR','CA','GB'].map((country,index)=>({country,count:1532-index*200,seeds:index*100,downBps:(6-index)*5000000,upBps:index*1000000})),totalConns:6192,resolved:6192,torrents:42,dht:true,transport:{total:6192,utp:2000,tcp:4192,webrtc:0,encrypted:5192}};
      var empty={points:[],totalConns:0,resolved:0,torrents:0,dht:false,transport:{total:0,utp:0,tcp:0,webrtc:0,encrypted:0}};
      var geoData=populated,polls=0;
      window.api={getSwarmGeo:async()=>{polls++;return structuredClone(geoData)},getIpInfo:async()=>({country:'RU'})};
      var Swarm=load(path.join(root,'renderer/pages/SwarmPage.tsx')).SwarmPage,mounted=ReactDOM.createRoot(document.getElementById('root')),serial=0;
      function render(){flush(()=>mounted.render(React.createElement(Swarm,{key:++serial})))}
      render();true;
    `);
    await until(`document.querySelectorAll('.swarm-node').length===6`,'country nodes');
    for(const language of ['ru','en'])for(const theme of ['dark','light'])for(const width of [1280,800,520,360]){
      win.setContentSize(width,900);
      await run(`language=${JSON.stringify(language)};dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/'+language+'.json'),'utf8'));localStorage.setItem('language',language);document.documentElement.dataset.theme=${JSON.stringify(theme)};render();true`);
      await until(`document.querySelectorAll('.swarm-node').length===6`,'country map after resize');await pause(80);
      const geometry=await run(`({viewport:innerWidth,page:document.documentElement.scrollWidth,body:document.querySelector('.swarm-page').scrollWidth,map:document.querySelector('.swarm-map').getBoundingClientRect().width,side:document.querySelector('.swarm-side')?.getBoundingClientRect().right,title:document.querySelector('.swarm-title h1').textContent})`);
      assert.equal(geometry.page<=width+1&&geometry.body<=width+1,true,JSON.stringify({language,theme,width,geometry}));
      assert.equal(geometry.map>0,true);assert.equal(geometry.title,await run(`t('swarm.title')`));
      checks.push({language,theme,width,geometry});
      if(width===360||width===1280){win.webContents.invalidate();await pause(150);fs.writeFileSync(path.join(out,`${language}-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());}
    }
    win.setContentSize(520,600);win.webContents.setZoomFactor(1.25);await pause(150);
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth+1'),true,'125% zoom horizontal fit');
    const bottom = await run(`(()=>{var last=[...document.querySelectorAll('.swarm-pill')].at(-1),r=last.getBoundingClientRect(),scrollable=false;for(var p=last.parentElement;p;p=p.parentElement){if(/auto|scroll/.test(getComputedStyle(p).overflowY)&&p.scrollHeight>p.clientHeight)scrollable=true;}last.scrollIntoView({block:'end'});return {needed:r.bottom>innerHeight,scrollable,visible:last.getBoundingClientRect().bottom<=innerHeight+1}})()`);
    assert.equal(!bottom.needed||bottom.scrollable,true,'transport rows remain reachable with user scrolling');assert.equal(bottom.visible,true,'last transport row visible');
    win.webContents.invalidate();await pause(150);fs.writeFileSync(path.join(out,'zoom-125.png'),(await win.webContents.capturePage()).toPNG());
    checks.push({scenario:'125% zoom keeps the map inside the page and final rows reachable',passed:true});
    win.webContents.setZoomFactor(1);
    await run('geoData=empty;true');await until(`!!document.querySelector('.swarm-empty')&&document.querySelectorAll('.swarm-node').length===0`,'empty state updates');
    checks.push({scenario:'empty state updates through the real polling effect',passed:true});
    await run(`geoData={...empty,totalConns:3};true`);await until(`document.querySelector('.swarm-empty p')?.textContent===t('swarm.emptyResolving')`,'unresolved countries state');
    checks.push({scenario:'unresolved peer locations explain their state',passed:true});
    const count=await run('mounted.unmount();polls');await pause(2100);assert.equal(await run('polls'),count);
    checks.push({scenario:'leaving the page cancels its polling',passed:true});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:true,checks,errors,scope:'Actual map and renderer layout; offline fixture statistics only.'},null,2));
    console.log('PASS swarm UI:',checks.length,'checks');clearTimeout(deadline);app.exit(0);
  }).catch(async error=>{try{if(win)fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch{/* Preserve the original failure if the window has already closed. */}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({passed:false,checks,errors,error:String(error.stack||error)},null,2));console.error(error);clearTimeout(deadline);app.exit(1);});
}
