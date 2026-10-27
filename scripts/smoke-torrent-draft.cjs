// Real page/store and dialog components with a fixture API; no user files/network.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts/torrent-draft-20261028');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-')));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1120, height: 940, useContentSize: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', detail => { if (detail.level === 'error' && !detail.message.includes('fixture source missing')) errors.push(detail.message); });
    const css = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css',
      'renderer/components/Select.css', 'renderer/components/Toggle.css', 'renderer/components/Modal.css', 'renderer/components/FileTreeSelector.css',
      'renderer/components/Toast.css', 'renderer/components/BatchCreate.css', 'renderer/components/MetadataPreview.css', 'renderer/components/CreateTorrentModal.css', 'renderer/components/CreatedTorrentSeed.css', 'renderer/pages/CreateTorrentPage.css'];
    const html = path.join(out, 'ui.html');
    fs.writeFileSync(html, `<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>${require('./smoke-ui-fonts.cjs')(root)}${css.map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n')}html,body,#root{height:100%;margin:0}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = code => win.webContents.executeJavaScript(code), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    await run(`
      var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=key=>dict[key]||key,cache={},calls=[],listeners=new Set(),job,seedJob,clipboardJob,missing=false,reads=0,lateCancel=false,folder='D:/source';
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{calls.push({kind:'clipboard',text});return new Promise((resolve,reject)=>clipboardJob={resolve,reject});}}});
      var sample={torrentFilePath:'D:/out.torrent',infoHash:'a'.repeat(40),magnetUri:'magnet:test',totalSize:5,pieceCount:1,pieceLength:16384,seedingStatus:'not-requested'};
      var tree=[{path:'D:/source',name:'source',size:8,isDirectory:true,children:[{path:'D:/source/keep',name:'keep',size:5,isDirectory:false},{path:'D:/source/skip',name:'skip',size:3,isDirectory:false}]}];
      var emit=(id,stage,progress)=>listeners.forEach(fn=>fn({requestId:id,stage,progress,message:'fixture'}));
      window.api={getDefaultTrackers:async()=>[['https://tracker.example.org/announce']],selectFolderForTorrent:async()=>folder,selectFilesForTorrent:async()=>['D:/source/keep'],
        getPathInfo:async()=>{reads++;if(missing)throw Error('fixture source missing');return {name:'source',size:8,fileCount:2,isDirectory:true};},getFileTree:async()=>tree,
        selectSaveTorrentPath:async()=> 'D:/out.torrent',onCreateTorrentProgress:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
        createTorrent:params=>{calls.push({kind:'create',...params});return new Promise((resolve,reject)=>{job={id:params.requestId,resolve,reject};emit(job.id,'hashing',.2);});},
        cancelCreateTorrent:async id=>{calls.push({kind:'cancel',id});if(lateCancel){job.resolve(sample);return false;}setTimeout(()=>job.reject(Error('TORRENT_CREATION_CANCELLED')),120);return true;},
        retryCreatedTorrentSeed:id=>{if(typeof id!=='string')throw Error('Only a receipt may cross retry IPC');calls.push({kind:'retry-seed',id});return new Promise((resolve,reject)=>seedJob={resolve,reject});},
        showItemInFolder:()=>{}};
      function load(file){if(cache[file])return cache[file].exports;var module={exports:{}};cache[file]=module;
        if(file.endsWith('components/index.ts')){for(var key of ['Button','Icon','Input','ProgressBar','FileTreeSelector','TrackerTemplates','MetadataPreview','BatchCreate'])Object.defineProperty(module.exports,key,{get:((name)=>()=>load(path.join(root,'renderer/components/'+name+'.tsx'))[name])(key)});Object.defineProperty(module.exports,'ToastContainer',{get:()=>load(path.join(root,'renderer/components/Toast.tsx')).ToastContainer});module.exports.QRCode=()=>null;return module.exports;}
        var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return {};
          if(name.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(name.startsWith('.')){var target=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(target+ext))return load(target+ext);throw Error(target);}
          return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));},module,module.exports);return module.exports;}
      var Page=load(path.join(root,'renderer/pages/CreateTorrentPage.tsx')).CreateTorrentPage,store=load(path.join(root,'renderer/stores/createTorrentStore.ts')).useCreateTorrentStore,reactRoot=createRoot(document.getElementById('root'));
      var mount=()=>dom.flushSync(()=>reactRoot.render(React.createElement(Page))),leave=()=>dom.flushSync(()=>reactRoot.render(React.createElement('p',null,'Другой раздел')));
      var click=label=>{var button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===label);if(!button)throw Error('Missing button '+label);dom.flushSync(()=>button.click());};
      var input=(selector,value)=>{var node=document.querySelector(selector);if(!node)throw Error('Missing input '+selector);Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));};
      mount();void 0;
    `);
    await pause(120);
    await run('click(t("create.addFolder"))'); await pause(150);
    await run('input("#create-name","Мой черновик");input("#create-comment","Описание");document.querySelectorAll("button[role=switch]").forEach(node=>dom.flushSync(()=>node.click()));click(t("create.show"));'); await pause(80);
    await run('dom.flushSync(()=>document.querySelector("input[aria-label=skip]").click());click(t("create.trackers"));'); await pause(80);
    await run('input("#create-trackers", "");click(t("create.tabAdvanced"));'); await pause(80);
    await run('input("#create-author","Автор");input("#create-web-seeds","https://example.org/files/");leave();mount();'); await pause(180);
    assert.equal(await run('document.querySelector("#create-author").value'), 'Автор');
    assert.equal(await run('document.querySelector("#create-web-seeds").value'), 'https://example.org/files/');
    assert.equal(await run('store.getState().draft.trackers'), '');
    assert.equal(await run('store.getState().draft.excludedPaths.has("D:/source/skip")'), true);
    assert.equal(await run('store.getState().draft.isPrivate && !store.getState().draft.startSeeding'), true);
    assert.equal(await run('reads >= 2'), true, 'returning to the page rescans the source');
    await run('click(t("create.tabBasic"))'); await pause(60);
    assert.equal(await run('document.querySelector("#create-name").value'), 'Мой черновик');
    assert.equal(await run('document.querySelector("#create-comment").value'), 'Описание');
    fs.writeFileSync(path.join(out, 'draft-restored.png'), (await win.webContents.capturePage()).toPNG());
    await run('click(t("create.createTorrent"))'); await pause(120);
    assert.equal(await run('!![...document.querySelectorAll("button")].find(node=>node.textContent.trim()===t("create.cancelCreation"))'), true);
    assert.deepEqual(await run('calls.find(call=>call.kind==="create").excludePaths'), ['D:/source/skip']);
    await run('leave();emit(job.id,"hashing",.6);mount();'); await pause(120);
    assert.equal(await run('document.querySelector(".progress-percent").textContent'), '60%');
    await run('click(t("create.cancelCreation"))'); await pause(30);
    assert.equal(await run('store.getState().cancelling'), true);
    assert.equal(await run('[...document.querySelectorAll("button")].find(node=>node.textContent.trim()===t("create.cancelling")).disabled'), true);
    fs.writeFileSync(path.join(out, 'cancelling.png'), (await win.webContents.capturePage()).toPNG());
    await pause(180);
    assert.equal(await run('document.querySelector("#create-name").value'), 'Мой черновик');
    assert.equal(await run('!!document.querySelector(".error-banner")'), false);
    assert.equal(await run('document.body.textContent.includes(t("create.cancelled"))'), true);
    win.setContentSize(560, 940); await pause(80);
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
    fs.writeFileSync(path.join(out, 'draft-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await run('lateCancel=true;sample={...sample,seedingStatus:"failed",seedingError:"fixture seed failed",seedRetryId:"saved-receipt"};click(t("create.createTorrent"))'); await pause(100);
    await run('click(t("create.cancelCreation"))'); await pause(100);
    assert.equal(await run('store.getState().stage'), 'success', 'late cancel cannot erase a saved result');
    await run('leave();mount();'); await pause(100);
    assert.equal(await run('!!document.querySelector(".success-card")'), true);
    // Delayed clipboard writes must not acknowledge success; failures are handled.
    await run('click(t("create.copyLink"))'); await pause(50);
    assert.equal(await run('document.querySelector(".magnet-box button").disabled'), true);
    assert.equal(await run('document.body.textContent.includes(t("create.magnetCopied"))'), false);
    await run('clipboardJob.reject(Error("clipboard denied"))'); await pause(80);
    assert.equal(await run('document.body.textContent.includes(t("create.copyFailed"))'), true);
    assert.equal(await run('document.body.textContent.includes(t("create.magnetCopied"))'), false);
    await run('click(t("create.copyLink"));clipboardJob.resolve()'); await pause(80);
    assert.equal(await run('document.querySelector(".magnet-box button").textContent.trim()'), await run('t("create.copied")'));
    await run('dom.flushSync(()=>document.querySelector(".hash-box button").click())'); await pause(40);
    assert.equal(await run('document.body.textContent.includes(t("create.hashCopied"))'), false);
    await run('clipboardJob.resolve()'); await pause(60);
    assert.equal(await run('document.querySelector(".hash-box button").title'), await run('t("create.copied")'));
    // Retry survives a page change, preserves the saved file, and never hashes again.
    await run('var beforeRetry=calls.filter(call=>call.kind==="create").length;click(t("create.retrySeed"));leave();mount();'); await pause(100);
    assert.equal(await run('document.querySelector(".created-torrent-seed button").disabled'), true);
    assert.equal(await run('[...document.querySelectorAll("button")].find(node=>node.textContent.trim()===t("create.createAnother")).disabled'), true);
    assert.equal(await run('[...document.querySelectorAll("button")].find(node=>node.textContent.trim()===t("create.createNew")).disabled'), true);
    fs.writeFileSync(path.join(out, 'seed-retry-narrow.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
    await run('seedJob.resolve({...sample,seedingError:"fixture still unavailable"})'); await pause(80);
    assert.equal(await run('document.querySelector(".created-torrent-seed-warning").textContent.includes("fixture still unavailable")'), true);
    await run('click(t("create.retrySeed"));seedJob.resolve({...sample,seedingStatus:"queued",seedingError:undefined,seedRetryId:undefined})'); await pause(80);
    assert.equal(await run('!!document.querySelector(".created-torrent-seed-warning")'), false);
    assert.equal(await run('calls.filter(call=>call.kind==="create").length'), await run('beforeRetry'));
    // A clipboard promise finishing after unmount cannot mark the new page copied.
    await run('click(t("create.copyLink"));leave();mount();clipboardJob.resolve()'); await pause(80);
    assert.equal(await run('document.body.textContent.includes(t("create.magnetCopied"))'), false);
    await run('click(t("create.createAnother"))'); await pause(100);
    assert.deepEqual(await run('store.getState().draft.sourcePaths'), []);
    await run('click(t("create.addFolder"))'); await pause(100);
    await run('leave();missing=true;mount();'); await pause(100);
    assert.equal(await run('[...document.querySelectorAll("button")].find(node=>node.textContent.trim()===t("create.createTorrent")).disabled'), true, 'missing source is revalidated after navigation');
    // The old dialog uses the same cancellation boundary, without losing its inputs.
    await run(`missing=false;lateCancel=false;var Dialog=load(path.join(root,'renderer/components/CreateTorrentModal.tsx')).CreateTorrentModal;dom.flushSync(()=>reactRoot.render(React.createElement(Dialog,{isOpen:true,onClose:()=>{}})));`); await pause(100);
    await run('click(t("create.selectFolder"))'); await pause(80);
    await run('click(t("nav.create"))'); await pause(100);
    await run('click(t("create.cancelCreation"))'); await pause(180);
    assert.equal(await run('!!document.querySelector(".torrent-create-dialog .selected-sources")'), true, 'dialog cancellation keeps selected inputs');
    assert.equal(await run('!!document.querySelector(".torrent-create-dialog .creating-state")'), false);
    await run('click(t("nav.create"))'); await pause(80);
    await run('job.resolve(sample)'); await pause(80);
    assert.equal(await run('!!document.querySelector(".seeding-status")'), false, 'a failed seed must not be reported as started');
    await run('click(t("share.copy"));clipboardJob.reject(Error("clipboard denied"))'); await pause(80);
    assert.equal(await run('document.querySelector(".torrent-create-dialog [role=alert]").textContent'), await run('t("create.copyFailed")'));
    await run('click(t("share.copy"));clipboardJob.resolve()'); await pause(80);
    assert.equal(await run('document.querySelector(".torrent-create-dialog .magnet-box button").textContent.trim()'), await run('t("create.copied")'));
    await run('click(t("create.retrySeed"));seedJob.resolve({...sample,seedingStatus:"queued",seedingError:undefined,seedRetryId:undefined})'); await pause(80);
    assert.equal(await run('document.querySelector(".seeding-status").textContent.trim()'), await run('t("create.seedQueued")'));
    // Cancelling a batch returns the active item to pending and never starts the next.
    await run(`var Batch=load(path.join(root,'renderer/components/BatchCreate.tsx')).BatchCreate;dom.flushSync(()=>reactRoot.render(React.createElement(Batch,{isOpen:true,onClose:()=>{},trackers:'',isPrivate:false,pieceLength:0,startSeeding:false,createdBy:'Havvn'})));`); await pause(100);
    await run('click(t("batchCreate.addFolders"))'); await pause(80);
    await run('folder="D:/source2";click(t("batchCreate.addFolders"))'); await pause(80);
    await run('var beforeBatch=calls.filter(call=>call.kind==="create").length;click(t("batchCreate.create")+" 2 "+t("batchCreate.torrents"))'); await pause(100);
    await run('click(t("batchCreate.stop"))'); await pause(180);
    assert.equal(await run('calls.filter(call=>call.kind==="create").length-beforeBatch'), 1, 'batch stop must not start the next item');
    assert.equal(await run('document.querySelectorAll(".item-error").length'), 0, 'user cancellation is not a failed item');
    // A saved item finishes normally when stop arrives during verification.
    await run('click(t("batchCreate.create")+" 2 "+t("batchCreate.torrents"))'); await pause(100);
    await run('emit(job.id,"verifying",0);window.api.cancelCreateTorrent=async()=>false;click(t("batchCreate.stop"));job.resolve(sample);'); await pause(120);
    assert.equal(await run('calls.filter(call=>call.kind==="create").length-beforeBatch'), 2);
    await run('click(t("batchCreate.create")+" 2 "+t("batchCreate.torrents"))'); await pause(100);
    assert.equal(await run('calls.filter(call=>call.kind==="create").length-beforeBatch'), 3, 'restart skips the completed first item');
    await run('job.resolve(sample)'); await pause(100);
    await run('var beforeBatchRetry=calls.filter(call=>call.kind==="create").length;click(t("create.retrySeed"))'); await pause(60);
    assert.equal(await run('[...document.querySelectorAll(".created-torrent-seed button")].every(node=>node.disabled)'), true);
    await run('seedJob.resolve({...sample,seedingStatus:"queued",seedingError:undefined,seedRetryId:undefined})'); await pause(80);
    assert.equal(await run('document.querySelectorAll(".created-torrent-seed button").length'), 1, 'only the selected batch result is updated');
    assert.equal(await run('calls.filter(call=>call.kind==="create").length'), await run('beforeBatchRetry'));
    fs.writeFileSync(path.join(out, 'batch-stopped-resumed.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'ui-report.json'), JSON.stringify({ passed: true, checks: ['form navigation', 'empty trackers preserved', 'exclusions/options preserved', 'source revalidation', 'background progress', 'actual cancellation acknowledgement', 'late cancellation', 'success navigation', 'new draft', 'narrow layout', 'legacy dialog cancellation', 'batch cancellation', 'batch stop during verification', 'batch resume skips completed items', 'clipboard waits for write', 'clipboard failure and retry', 'hash acknowledgement', 'clipboard stale result ignored', 'seed retry across navigation', 'seed retry failure and success', 'legacy dialog retry and accurate status', 'batch result retry without recreation'], errors }, null, 2));
    console.log('Torrent draft UI passed:', out); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(e => { console.error(e); clearTimeout(deadline); app.exit(1); });
}
