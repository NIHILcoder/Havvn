// Isolated Electron UI check with synthetic results, no sites or real profile.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const out=fs.mkdtempSync(path.join(require('os').tmpdir(),'havvn-groups-'));
app.setPath('userData',path.join(out,'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('UI deadline');app.exit(1)},50000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1500,height:950,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
 const css=['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/layout.css','renderer/styles/components.css','renderer/styles/hud.css','renderer/pages/SearchPage.css','renderer/components/ProviderConnectionSettings.css'].map(p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
 for(const width of [1500,700,400]){
  win.setContentSize(width,900);
  const file=path.join(out,'preview.html');
  fs.writeFileSync(file,'<html lang="ru"><style>'+css+'#root{height:100vh}</style><div id="root"></div></html>');
  await win.loadFile(file);
  await win.webContents.executeJavaScript(`
   var root=${JSON.stringify(root)},fs=require('fs'),path=require('path'),ts=require(path.join(root,'node_modules/typescript'));
   var React=require(path.join(root,'node_modules/react')),ReactDOM=require(path.join(root,'node_modules/react-dom/client'));
   var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),cache={};
   window.added=[];window.resolved=[];
   window.downloads=[{id:'existing',infoHash:'a'.repeat(40),status:'completed',progress:1}];
   window.api={getDownloads:async()=>downloads,onDownloadStats:fn=>{window.emitStats=fn;return ()=>{}},addDownload:async value=>{added.push(value);const record={...value,id:'new-'+added.length,status:'downloading',progress:0};downloads.push(record);return record;},search:{cancel:async()=>{},getProviders:async()=>[{id:'one',name:'Test',type:'script',url:'test.py',enabled:true}],getCategories:async()=>[],onProgress:fn=>{window.progress=fn;return ()=>{}},start:async()=>({searchId:'sample',providers:['Test']}),resolveSource:async refs=>{resolved.push(refs);return {sourceType:'magnet',sourceUri:'magnet:'+refs[0]}},getNetworkSettings:async()=>({profiles:[],access:{}})}};
   function load(p){
    if(cache[p])return cache[p].exports;const m={exports:{}};cache[p]=m;
    const src=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
    new Function('require','module','exports',src)(s=>{
     if(s.endsWith('.css'))return {};
     if(s.includes('i18nContext'))return {useTranslation:()=>({t:k=>dict[k]||k})};
     if(s==='../components')return {Button:load(path.join(root,'renderer/components/Button.tsx')).Button,Icon:load(path.join(root,'renderer/components/Icon.tsx')).default,EmptyState:()=>null,CategorySelect:()=>React.createElement('select'),DropdownMenu:()=>null,TorrentFileSelector:()=>null,useConfirm:()=>({confirm:async()=>true,alert:async v=>{throw Error(JSON.stringify(v))}})};
     if(s.startsWith('.')){let q=path.resolve(path.dirname(p),s);for(const ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q)}
     return require(path.join(root,'node_modules',s));
    },m,m.exports);return m.exports;
   }
   localStorage.clear();window.mountSearch=()=>{window.searchRoot=ReactDOM.createRoot(document.getElementById('root'));searchRoot.render(React.createElement(load(path.join(root,'renderer/pages/SearchPage.tsx')).default));};mountSearch();
   window.makeRow=(title,id,seeds)=>({title,infoHash:id,size:seeds*1024**3,seeds,leechers:1,provider:'Test',sourceRefs:[id]});
   void 0;
  `);
  const wait=()=>new Promise(r=>setTimeout(r,120));
  await wait();
  const run=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(error){console.error('Failed UI step:',code);throw error}};
  await run(`{const input=document.querySelector('.search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Film');input.dispatchEvent(new Event('input',{bubbles:true}));}`);await wait();
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Найти').click()`);await wait();
  await run(`progress({searchId:'sample',results:[makeRow('Film (2024) 1080p HEVC DUB WEB-DL','one',10),makeRow('Film (2024) 720p H.264','two',5),makeRow('Film (1984) 1080p','remake',3)]})`);await wait();
  assert.equal(await run(`document.querySelectorAll('.release-group-row').length`),1);
  assert.equal(await run(`document.querySelectorAll('.results-row').length`),1);
  await run(`document.querySelector('.release-group-row').click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('.release-variant').length`),2);
  await run(`progress({searchId:'sample',results:[makeRow('Film (2024) 2160p HEVC','three',8)]})`);await wait();
  assert.equal(await run(`document.querySelector('.release-group-row').getAttribute('aria-expanded')`),'true');
  assert.equal(await run(`document.querySelectorAll('.release-variant').length`),3);
  await run(`document.querySelector('.release-variant .action-col button').click()`);await wait();
  assert.deepEqual(await run(`resolved`),[['one']]);
  assert.equal(await run(`added[0].name`),'Film (2024) 1080p HEVC DUB WEB-DL');
  assert.equal(await run(`document.querySelector('.release-variant .added-badge').textContent.trim()`),'В загрузках');
  await run(`downloads[1].progress=1;emitStats([{id:downloads[1].id,status:'seeding',progress:1}])`);await wait();
  assert.equal(await run(`document.querySelector('.release-variant .added-badge').textContent.trim()`),'Скачано');
  const dimensions=await run(`({overflow:document.querySelector('.results-table').scrollWidth>document.querySelector('.results-table').clientWidth,heights:[...document.querySelectorAll('.results-row,.release-group-row')].map(e=>e.getBoundingClientRect().height)})`);
  assert.equal(dimensions.overflow,false);assert.ok(dimensions.heights.every(h=>h===52));
  fs.writeFileSync(path.join(out,'groups-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  await run(`const select=document.querySelector('.release-filter-fields select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'720p');select.dispatchEvent(new Event('change',{bubbles:true}));`);await wait();
  assert.equal(await run(`document.querySelectorAll('.release-group-row').length`),0);
  assert.equal(await run(`document.querySelectorAll('.results-row').length`),1);
  await run(`document.querySelector('.release-filter-footer button').click()`);await wait();
  assert.equal(await run(`document.querySelectorAll('.release-variant').length`),3);
  await run(`document.querySelector('[aria-pressed]').click()`);await wait();
  assert.equal(await run(`localStorage.getItem('havvn.search.groupResults.v1')`),'false');
  assert.equal(await run(`document.querySelectorAll('.results-row').length`),4);
  await run(`progress({searchId:'sample',results:[makeRow('Known release (1999) 1080p','a'.repeat(40),2)]})`);await wait();
  assert.equal(await run(`document.querySelectorAll('.added-badge').length`),2);
  await run(`downloads=[];window.dispatchEvent(new Event('focus'))`);await wait();
  assert.equal(await run(`document.querySelectorAll('.added-badge').length`),0);
  await run(`progress({searchId:'sample',results:[{...makeRow('Unknown quality','unknown',99),size:0}]})`);await wait();
  assert.equal(await run(`document.querySelector('.results-row .result-title').textContent`),'Unknown quality');
  await run(`const preset=document.querySelector('.preference-preset');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(preset,'hd');preset.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.search-preferences').open=true;`);await wait();
  assert.equal(await run(`document.querySelector('.results-row .result-title').textContent`),'Film (2024) 1080p HEVC DUB WEB-DL');
  assert.equal(await run(`document.querySelectorAll('.results-row').length`),6);
  assert.ok((await run(`document.querySelector('.preference-match').title`)).includes('1080p'));
  assert.equal(await run(`document.querySelector('.search-preferences').scrollWidth>document.querySelector('.search-preferences').clientWidth`),false);
  fs.writeFileSync(path.join(out,'preferences-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  await run(`document.querySelector('.results-th.seeds-col').click()`);await wait();
  assert.equal(await run(`document.querySelector('.results-row .result-title').textContent`),'Known release (1999) 1080p');
  assert.equal(await run(`document.querySelector('.search-preference-footer input').checked`),false);
  await run(`document.querySelector('.search-preference-footer input').click()`);await wait();
  await run(`searchRoot.unmount();mountSearch();`);await wait();
  await run(`const input=document.querySelector('.search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Film');input.dispatchEvent(new Event('input',{bubbles:true}));`);await wait();
  await run(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Найти').click()`);await wait();
  await run(`progress({searchId:'sample',results:[makeRow('Film (2024) 1080p','restore',10)]})`);await wait();
  assert.equal(await run(`document.querySelector('.preference-preset').value`),'hd');
  assert.equal(await run(`document.querySelector('.search-preference-footer input').checked`),true);
  console.log('PASS',width,'grouping, progressive results, source resolution, filtering, list toggle, layout');
 }
 console.log('Screenshots:',out);
 win.destroy();clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
}
