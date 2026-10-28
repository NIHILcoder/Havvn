// Real SearchPage with fixture API, isolated profile, no tracker/account access.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts/search-upgrade-20261028');
  fs.mkdirSync(out, { recursive: true });
  app.setPath('userData', fs.mkdtempSync(path.join(out, 'ui-profile-'))); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1120, height: 900, useContentSize: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', detail => { if (detail.level === 'error') { errors.push(detail.message); console.error('Renderer:', detail.message); } });
    const sheets = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/styles/appearance.css',
      'renderer/components/Select.css', 'renderer/components/NumberInput.css', 'renderer/components/ProviderConnectionSettings.css', 'renderer/components/SearchQueryInput.css',
      'renderer/components/Modal.css', 'renderer/components/TorrentSearchModal.css', 'renderer/components/ReleaseDetailsModal.css', 'renderer/components/DownloadDefaultsPreview.css', 'renderer/pages/SearchPage.css'];
    const html = path.join(out, 'ui.html');
    fs.writeFileSync(html, `<html class="dark" data-theme="dark" lang="ru"><style>${require('./smoke-ui-fonts.cjs')(root)}${sheets.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n')}html,body,#root{height:100%;margin:0}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript('try {\n' + code + '\n} catch (error) { console.error(error.stack); throw error; }'); } catch (error) { console.error('UI step:', code.slice(0, 160)); throw error; } }, pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key,cache={},calls=[],providers=[],listener,serial=0,fixtureError=false,fixtureMagnet=false,fixtureCopyFailure=false;
      var network={profiles:[],access:{}};
      var native={id:'native',name:'RuTracker',type:'rutracker',url:'https://rutracker.net/forum',enabled:true};
      function batch(id,topic,next){listener({searchId:id,done:false,stat:{providerId:'native',name:'RuTracker',count:1,ms:1,state:'ok',nextPage:next},results:[{deferredSource:'native:'+topic,sourceRefs:['source-'+topic],title:'Film '+topic,size:1000000,seeds:12,leechers:1,provider:'RuTracker',...(fixtureMagnet?{magnetUri:'magnet:?xt=urn:btih:'+'b'.repeat(40)}:{})}]});listener({searchId:id,done:true});}
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{calls.push({kind:'copy',text});if(fixtureCopyFailure)throw Error('Clipboard denied');}}});
      window.api={getSettings:async()=>({defaultDownloadDir:'D:/Downloads',defaultSeedRatioLimit:0,defaultSeedTimeLimitMinutes:0}),getCategories:async()=>[],getDownloads:async()=>[],onCategoriesUpdated:()=>()=>{},
        addDownload:async value=>{calls.push({kind:'download',...value});return {id:'added',...value};},search:{
          getProviders:async()=>structuredClone(providers),getDownloadHistory:async()=>[],getNetworkSettings:async()=>structuredClone(network),
          addProvider:async value=>{calls.push({kind:'provider',...value});providers=[{...native,...value}];network.access.native={profileId:'system',origins:[],mirrors:[]};return providers[0];},
          login:async id=>{calls.push({kind:'login',id});return {success:true,message:'Вход выполнен'};},
          testProvider:async()=>({success:true,message:'Доступен'}),checkPython:async()=>{throw Error('Python must not be checked for native RuTracker');},
          onProgress:callback=>{listener=callback;return()=>{listener=null;};},cancel:async id=>calls.push({kind:'cancel',id}),
          start:async query=>{var id='run-'+(++serial);calls.push({kind:'search',query});if(fixtureError){listener({searchId:id,done:false,stat:{providerId:'native',name:'RuTracker',count:0,ms:1,state:'failed',errorCode:fixtureError==='captcha'?'captcha':'auth',error:fixtureError==='captcha'?'Сайт требует проверку Cloudflare':'Войди снова'}});listener({searchId:id,done:true});}else batch(id,1,'page-2');return {searchId:id,providers:['RuTracker'],cached:true};},
          more:async token=>{calls.push({kind:'more',token});var id='run-'+(++serial);batch(id,2);return {searchId:id,providers:['RuTracker']};},
          resolveSource:async refs=>{calls.push({kind:'resolve',refs});return {sourceType:'magnet',sourceUri:'magnet:?xt=urn:btih:'+ 'a'.repeat(40)};},
          releaseDetails:async refs=>{calls.push({kind:'preview',refs});var source={ref:refs[0],providerId:'native',name:'RuTracker',supported:true};return {source,sources:[source],title:'Описание Film 1',supported:true,blocks:[{kind:'paragraph',text:'Тестовое описание с сайта'}],screenshots:[],url:'https://rutracker.net/forum/viewtopic.php?t=1'};},cancelPreview:async()=>{}
        }};
      function load(file){if(cache[file])return cache[file].exports;var module={exports:{}};cache[file]=module;
        var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return {};
          if(name.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(name.endsWith('state/downloads'))return {useDownloads:fn=>fn({downloads:[],byId:new Map()}),downloadsModel:{retain:()=>()=>{},refresh:async()=>{},updateDownloads:()=>{}}};
          if(name.endsWith('useCategories'))return {useCategories:()=>[]};
          if(name.endsWith('/components')){var all={useConfirm:()=>({confirm:async()=>true,alert:async value=>calls.push({kind:'alert',...value})}),TorrentFileSelector:()=>null};for(var key of ['Button','Icon','EmptyState','CategorySelect','DropdownMenu'])Object.assign(all,load(path.join(root,'renderer/components/'+key+'.tsx')));return all;}
          if(name.startsWith('.')){var target=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(target+ext))return load(target+ext);throw Error(target);}
          return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));},module,module.exports);return module.exports;}
      var errorTranslations=load(path.join(root,'renderer/utils/error-messages.ts'));
      for(var errorLanguage of ['ru','en'])errorTranslations.registerErrorTranslations(errorLanguage,JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/'+errorLanguage+'.json'),'utf8')));
      var Search=load(path.join(root,'renderer/pages/SearchPage.tsx')).default,reactRoot=createRoot(document.getElementById('root'));
      dom.flushSync(()=>reactRoot.render(React.createElement(Search)));
      window.click=label=>{var button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);if(!button)throw Error('Missing button: '+label);dom.flushSync(()=>button.click());};
      window.input=value=>{var node=document.querySelector('.search-query-input input')||document.querySelector('.search-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));};
      void 0;
    `);
    await pause(150);
    await run('click(t("search.providers"))'); await pause(150);
    assert.equal(await run('!!document.querySelector(".rutracker-setup")'), true);
    assert.equal(await run('!!document.querySelector(".python-status")'), false);
    fs.writeFileSync(path.join(out, 'setup-wide.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(560, 920); await pause(100);
    fs.writeFileSync(path.join(out, 'setup-narrow.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
    await run('click(t("search.rutracker.connect"))'); await pause(150);
    assert.deepEqual(await run('calls.filter(call=>["provider","login"].includes(call.kind)).map(call=>call.kind)'), ['provider', 'login']);
    win.setContentSize(1120, 900);
    await run('click(t("search.providers"));input("Film");dom.flushSync(()=>document.querySelector(".search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})))');
    await pause(250);
    assert.equal(await run('document.body.textContent.includes("Film 1")'), true, 'cached progress arriving before start resolves must be retained');
    assert.equal(await run('calls.some(call=>call.kind==="resolve")'), false);
    assert.equal(await run('calls.some(call=>call.kind==="preview")'), false, 'descriptions must not load while the result list arrives');
    await run('click("Film 1")'); await pause(100);
    assert.equal(await run('document.body.textContent.includes("Тестовое описание с сайта")'), true);
    await run('dom.flushSync(()=>document.querySelector(".release-details-modal .um-x").click())');
    await run('click(t("search.more")+" · RuTracker")'); await pause(200);
    assert.equal(await run('document.body.textContent.includes("Film 1") && document.body.textContent.includes("Film 2")'), true);
    assert.equal(await run('calls.find(call=>call.kind==="more").token'), 'page-2');
    fs.writeFileSync(path.join(out, 'results-wide.png'), (await win.webContents.capturePage()).toPNG());
    await run('click(t("search.download"))'); await pause(150);
    assert.deepEqual(await run('calls.filter(call=>["resolve","download"].includes(call.kind)).map(call=>call.kind)'), ['resolve', 'download']);
    await run('fixtureError=true;dom.flushSync(()=>document.querySelector(".search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})))'); await pause(150);
    assert.equal(await run('[...document.querySelectorAll(".provider-strip button")].some(node=>node.textContent.trim()===t("search.connection.login"))'), true);
    await run('fixtureError=false;click(t("search.connection.login"))'); await pause(150);
    assert.equal(await run('document.body.textContent.includes("Film 1")'), true, 'sign-in retries only the failed source');
    await run('fixtureError="captcha";dom.flushSync(()=>document.querySelector(".search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})))'); await pause(150);
    assert.equal(await run('document.querySelector(".provider-stat.failed").title'), await run('load(path.join(root,"shared/user-errors.ts")).USER_ERRORS.captcha[0]'), 'source error tooltip explains the browser check and the next action');
    assert.equal(await run('[...document.querySelectorAll(".provider-strip button")].some(node=>node.textContent.trim()===t("search.connection.login"))'), true, 'challenge exposes the browser sign-in action');
    fs.writeFileSync(path.join(out, 'captcha-wide.png'), (await win.webContents.capturePage()).toPNG());
    await run('fixtureError=false;fixtureMagnet=true;fixtureCopyFailure=true;input("Clipboard fixture");dom.flushSync(()=>document.querySelector(".search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})))'); await pause(150);
    await run('dom.flushSync(()=>document.querySelector(".row-menu-btn").click());click(t("search.row.copyMagnet"))'); await pause(100);
    assert.equal(await run('calls.filter(call=>call.kind==="alert").at(-1)?.message'), await run('t("common.copyFailed")'), 'failed magnet copy must explain the failure');
    const alertsAfterCopyFailure = await run('calls.filter(call=>call.kind==="alert").length');
    await run('fixtureCopyFailure=false;dom.flushSync(()=>document.querySelector(".row-menu-btn").click());click(t("search.row.copyMagnet"))'); await pause(100);
    assert.equal(await run('calls.filter(call=>call.kind==="copy").at(-1)?.text'), 'magnet:?xt=urn:btih:' + 'b'.repeat(40));
    assert.equal(await run('calls.filter(call=>call.kind==="alert").length'), alertsAfterCopyFailure, 'successful retry must not show a stale failure');
    await run(`fixtureError=false;fixtureMagnet=false;dom.flushSync(()=>reactRoot.unmount());reactRoot=createRoot(document.getElementById('root'));var SearchModal=load(path.join(root,'renderer/components/TorrentSearchModal.tsx')).TorrentSearchModal;dom.flushSync(()=>reactRoot.render(React.createElement(SearchModal,{onClose:()=>{},onAdd:async value=>calls.push({kind:'modal-download',...value})})));`);
    await pause(100);
    await run(`var node=document.querySelector('.tsm-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'Film');dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));dom.flushSync(()=>document.querySelector('.tsm-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));`);
    await pause(150);
    assert.equal(await run('!!document.querySelector(".tsm-title")'), true, 'compact search must also retain early cached results');
    await run('click("Film 1")'); await pause(100);
    assert.equal(await run('!!document.querySelector(".release-details-modal")'), true, 'quick search opens the same release card');
    await run('dom.flushSync(()=>document.querySelector(".release-details-modal .um-x").click())');
    await run('click(t("downloads.addTorrent"))'); await pause(100);
    assert.deepEqual(await run('calls.find(call=>call.kind==="modal-download").searchSourceRefs'), ['source-1']);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'ui-report.json'), JSON.stringify({ passed: true, calls: await run('calls'), errors }, null, 2));
    console.log('RuTracker UI passed:', out); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
