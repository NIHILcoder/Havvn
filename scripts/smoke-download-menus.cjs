// Production Downloads header menus and transfer row, fixture actions only.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-download-menus-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Download menu deadline:', out); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 680, height: 480, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') { errors.push(d.message); console.error('Renderer:', d.message); } });
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/pages/DownloadsPage.css', 'renderer/components/HealthBadge.css', 'renderer/styles/base.css', 'renderer/styles/layout.css', 'renderer/styles/components.css', 'renderer/styles/appearance.css']
      .map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'menus.html'); fs.writeFileSync(html, `<html data-theme="dark" data-material="glass" data-glass-scopes="header menus"><style>${css}\n#root{height:100dvh}*{animation:none!important;transition:none!important}</style><div id=root></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (e) { console.error('UI step:', code.slice(0, 240)); throw e; } }, pause = ms => new Promise(r => setTimeout(r, ms));
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript')),React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={},calls=[];
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return{};if(s.includes('i18nContext'))return{useTranslation:()=>({t,language:'ru'})};if(s.includes('useCategories'))return{useCategories:()=>[],categoryLabel:()=>''};if(s.endsWith('/components'))return Object.assign({},...['Button','Icon','ProgressBar','Badge','HealthBadge'].map(n=>load(path.join(root,'renderer/components/'+n+'.tsx'))));
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      var Button=load(path.join(root,'renderer/components/Button.tsx')).Button,Icon=load(path.join(root,'renderer/components/Icon.tsx')).Icon,DropdownMenu=load(path.join(root,'renderer/components/DropdownMenu.tsx')).DropdownMenu,DownloadItem=load(path.join(root,'renderer/pages/DownloadItem.tsx')).DownloadItem;
      var onDoneAvailable=['none','sleep','shutdown','quit'],onDoneAction='none',onDoneLabel=a=>t('downloads.onDone.'+a),handleSelectOnDone=a=>{calls.push(a);onDoneAction=a;mount();},handleExport=format=>calls.push('export-'+format);
      var source=fs.readFileSync(path.join(root,'renderer/pages/DownloadsPage.tsx'),'utf8'),ast=ts.createSourceFile('menus.tsx',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX),headers=[];
      function visit(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='DropdownMenu')headers.push(node.getText(ast));ts.forEachChild(node,visit);}visit(ast);if(headers.length!==2)throw Error('Expected the two production Downloads menus');
      var m={exports:{}};new Function('module','exports',ts.transpileModule('export const Power=()=>('+headers[0]+');export const Export=()=>('+headers[1]+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText)(m,m.exports);var Power=m.exports.Power,Export=m.exports.Export;
      var row={id:'fixture',kind:'torrent',name:'Сборка.zip',status:'completed',progress:1,totalSize:1073741824,downloadedBytes:1073741824,uploadedBytes:0,savePath:'C:/Downloads',createdAt:Date.now(),fileCount:1};
      var tree=createRoot(document.querySelector('#root'));window.mount=()=>dom.flushSync(()=>tree.render(React.createElement('div',{className:'page-container'},React.createElement('div',{className:'page-header'},React.createElement('div',{className:'page-title-block'},React.createElement('h1',{className:'page-title'},t('downloads.title'))),React.createElement('div',{className:'page-actions'},React.createElement(Power),React.createElement(Export))),React.createElement('div',{className:'page-content'},React.createElement('div',{className:'downloads-list'},React.createElement(DownloadItem,{download:row,viewMode:'detailed',isSelected:true,onPause:()=>{},onResume:()=>{},onRemove:()=>{},onStopSeeding:()=>{},onRetry:()=>{},onOpenFolder:()=>{},onShowFiles:()=>{}}))))));
      window.openPower=()=>dom.flushSync(()=>document.querySelector('[title^="'+t('downloads.onDone')+'"]').click());window.openExport=()=>dom.flushSync(()=>document.querySelector('[title="'+t('downloads.exportList')+'"]').click());
      window.escape=()=>dom.flushSync(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));window.theme=(name,mode)=>{var palette=JSON.parse(fs.readFileSync(path.join(root,'themes/'+name+'.havvn-theme.json'),'utf8'))[mode];document.documentElement.style.cssText='';for(var [key,value]of Object.entries(palette))document.documentElement.style.setProperty(key,value);document.documentElement.dataset.theme=mode;document.documentElement.style.setProperty('--ap-opacity','90%');document.documentElement.style.setProperty('--ap-blur','18px');document.documentElement.style.setProperty('--ap-tint','5%');document.documentElement.style.setProperty('--ap-highlight','15%');document.documentElement.style.setProperty('--ap-depth','.3');};
      mount();theme('nihil-aero-midnight','dark');void 0;
    `);
    const fit = async () => {
      assert.equal(await run('(()=>{var menu=document.querySelector("[role=menu]"),r=menu.getBoundingClientRect(),items=[...menu.querySelectorAll("[role=menuitem]")];return menu.parentElement===document.body&&r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8&&items.every((item,i)=>{var b=item.getBoundingClientRect(),label=item.querySelector("span").getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&label.top>=b.top&&label.bottom<=b.bottom&&(i===0||b.top>=items[i-1].getBoundingClientRect().bottom)&&document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest("[role=menuitem]")===item;});})()'), true, 'every menu item must fit and receive the click above the transfer row');
    };
    const capture = async name => { win.webContents.invalidate(); await pause(200); const r = await run('(()=>{var menu=document.querySelector("[role=menu]").getBoundingClientRect();return{x:Math.max(0,Math.floor(menu.left)-12),y:0,width:Math.min(innerWidth-Math.max(0,Math.floor(menu.left)-12),Math.ceil(menu.width)+24),height:Math.ceil(menu.bottom)+12}})()');fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage(r)).toPNG()); };
    for (const [mode, width] of [['dark', 680], ['dark', 260], ['light', 680]]) {
      win.setSize(width,480); await pause(80);await run(`theme('nihil-aero-midnight',${JSON.stringify(mode)});openPower()`);await fit();await capture('completion-'+mode+'-'+width);await run('escape();openExport()');await fit();await run('escape()');
    }
    await run('openPower();dom.flushSync(()=>[...document.querySelectorAll("[role=menuitem]")].find(item=>item.textContent.trim()===t("downloads.onDone.shutdown")).click())');
    assert.deepEqual(await run('calls'), ['shutdown']);assert.equal(await run('!document.querySelector("[role=menu]")'),true);
    await run('openPower()');assert.equal(await run('document.querySelector("[title^="+JSON.stringify(t("downloads.onDone"))+"]").classList.contains("btn-primary")'),true);await run('escape();openExport();dom.flushSync(()=>[...document.querySelectorAll("[role=menuitem]")].find(item=>item.textContent.trim()===t("downloads.exportCsv")).click())');assert.deepEqual(await run('calls'),['shutdown','export-csv']);
    await run('openPower();dom.flushSync(()=>document.body.dispatchEvent(new MouseEvent("mousedown",{bubbles:true})))');assert.equal(await run('!document.querySelector("[role=menu]")'),true);
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:true,calls:await run('calls'),errors},null,2));console.log('Download menu regression passed:',out);clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(e => { console.error(e); console.error('Fixture output:',out);clearTimeout(deadline);app.exit(1); });
}
