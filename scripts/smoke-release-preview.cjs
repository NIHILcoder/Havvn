// Local fixture HTML, actual React/DOM extraction and native bitmap decoding.
// No tracker, account, user clipboard, screen capture or user downloads.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'artifacts/release-preview-20261029');
  fs.mkdirSync(out, { recursive: true }); app.setPath('userData', fs.mkdtempSync(path.join(out, 'profile-'))); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {}); const deadline = setTimeout(() => { console.error('Preview deadline'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const binaries = new Map(), nativeSizes = [], networkReads = [];
    const network = require(path.join(root, 'dist/electron/electron/services/provider-network.js')).providerNetwork;
    require(path.join(root, 'dist/electron/electron/services/provider-network-store.js')).getProviderRoute = () => ({ connection: { mode: 'direct' } });
    network.request = async (_provider, _connection, url, options) => {
      networkReads.push({ url, omitCookies: options.omitCookies });
      const body = binaries.get(new URL(url).pathname.slice(1)); if (!body) throw Error('Fixture image unavailable'); return { body };
    };
    const service = new (require(path.join(root, 'dist/electron/electron/services/search-release-preview.js')).SearchReleasePreview)();
    ipcMain.handle('fixture:seed', (_event, id, data) => {
      binaries.set(id, Buffer.from(data.split(',')[1], 'base64'));
      service.assets.set(id, { url: 'https://images.example/' + id, providerId: 'fixture', sourceOrigin: 'https://tracker.example', expires: Date.now() + 900000 });
    });
    ipcMain.handle('fixture:image', async (event, id, request) => {
      const data = await service.image(id, event.sender.id + ':' + request);
      const bitmap = nativeImage.createFromDataURL(data); nativeSizes.push({ id, ...bitmap.getSize() }); return data;
    });
    ipcMain.handle('fixture:cancel', (event, request) => service.cancel(event.sender.id + ':' + request));
    const css = ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/styles/appearance.css',
      'renderer/components/Modal.css','renderer/components/Select.css','renderer/components/ReleaseDetailsModal.css'];
    const html = path.join(out, 'preview.html'); fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + require('./smoke-ui-fonts.cjs')(root)
      + css.map(file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n') + 'html,body,#root{height:100%;margin:0}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1220, height: 860, useContentSize: true, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = [], checks = []; win.webContents.on('console-message', d=>{if(d.level==='error'){errors.push(d.message);console.error(d.message);}});
    const run = code=>win.webContents.executeJavaScript(code), pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const wait = async (label, expression) => { for(let i=0;i<80;i++){if(await run(expression)){checks.push(label);return;}await pause(60);}throw Error(label+': '+await run('document.body.innerText')); };
    const capture = async name => { await pause(100);fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG()); };
    await win.loadFile(html);
    await run(`var root=${JSON.stringify(root)},fs=require('node:fs'),path=require('node:path'),ts=require(path.join(root,'node_modules/typescript')),ipc=require('electron').ipcRenderer;
      var React=require(path.join(root,'node_modules/react')),dom=require(path.join(root,'node_modules/react-dom')),createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')),t=k=>dict[k]||k,cache={},calls=[],jobs=[],rejections=[];
      addEventListener('unhandledrejection',event=>{rejections.push(String(event.reason));event.preventDefault();});
      function load(file){if(cache[file])return cache[file].exports;var m={exports:{}};cache[file]=m;var js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(name=>{if(name.endsWith('.css'))return {};if(name.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(name.startsWith('.')){var p=path.resolve(path.dirname(file),name);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(p+ext))return load(p+ext);throw Error(p);}return require(name.startsWith('node:')?name:path.join(root,'node_modules',name));},m,m.exports);return m.exports;}
      var extract=load(path.join(root,'shared/rutracker-details.ts')).extractRuTrackerDetails;
      var fixture='<h1 id="topic-title">Тестовая раздача: приключения и путешествия</h1><div class="post_body"><h2>О раздаче</h2><p>Описание фильма. <b>Режиссёр:</b> Тестовый автор.</p><ul><li>Видео: 3840 × 2160</li><li>Аудио: русский и английский</li></ul><pre>Видео: HEVC\\nЗвук: AAC</pre><var class="postImg postImgAligned img-right" title="https://images.example/cover"></var><a href="https://images.example/full.jpg"><img src="https://images.example/thumb.jpg" alt="Первый кадр"></a><img src="//images.example/second.png" alt="Второй кадр"><script>window.pageExecuted=true</script><form>private account text</form><iframe src="https://evil.example"></iframe></div><div class="post_body">Comment must not appear</div>';
      var parsed=extract(new DOMParser().parseFromString(fixture,'text/html'),'https://tracker.example/forum/viewtopic.php?t=7');
      window.raw=parsed;window.forged=extract(new DOMParser().parseFromString('<div class="post_body"><p>'+('Description '.repeat(12000))+'</p>'+('<p>text</p>'.repeat(300))+'</div>','text/html'),'https://tracker.example/forum/viewtopic.php?t=7');
      window.empty=extract(new DOMParser().parseFromString('<h1>Layout changed</h1>','text/html'),'https://tracker.example/forum/viewtopic.php?t=7');
      window.mode='success';window.added=false;window.closeCount=0;window.imageFailure=false;
      var sources=[{ref:'rt-ref',providerId:'rt',name:'RuTracker',supported:true},{ref:'other-ref',providerId:'other',name:'Другой источник',supported:false}];
      function detail(selected){var source=sources.find(s=>s.ref===selected)||sources[0];return {source,sources,title:parsed.title,url:'https://tracker.example/forum/viewtopic.php?t=7',supported:source.supported,
        blocks:source.supported?parsed.blocks:[],poster:source.supported?{id:'cover',label:'Тестовая обложка'}:undefined,screenshots:source.supported?[{id:'screen-one',label:'Первый кадр'},{id:'screen-two',label:'Второй кадр'}]:[],fetchedAt:Date.now(),truncated:false};}
      window.api={search:{releaseDetails:(refs,request,selected,refresh)=>{calls.push({kind:'details',refs,request,selected,refresh});if(mode==='hold')return new Promise((resolve,reject)=>jobs.push({resolve,reject}));var data=detail(selected);if(mode==='auth')data.failure='auth';if(mode==='empty'){data.blocks=[];delete data.poster;data.screenshots=[];}return Promise.resolve(data);},
        releaseImage:(id,request)=>{calls.push({kind:'image',id});return imageFailure?Promise.reject(Error('Image request failed')):ipc.invoke('fixture:image',id,request);},cancelPreview:request=>{calls.push({kind:'cancel',request});return ipc.invoke('fixture:cancel',request);}}};
      var Component=load(path.join(root,'renderer/components/ReleaseDetailsModal.tsx')).ReleaseDetailsModal,tree=createRoot(document.querySelector('#root'));
      var row={title:'Тестовая раздача',provider:'RuTracker',providers:['RuTracker'],indexers:[],sourceCount:1,sourceRefs:['rt-ref','other-ref'],size:12000000000,seeds:42,leechers:3};
      function mount(key){dom.flushSync(()=>tree.render(React.createElement('div',{style:{containerType:'inline-size',height:40,overflow:'hidden'}},React.createElement(Component,{key,result:row,onClose:()=>{closeCount++;},onDownload:async ref=>calls.push({kind:'download',ref}),onSelectFiles:ref=>calls.push({kind:'files',ref}),onSignIn:id=>calls.push({kind:'login',id}),busy:false,added}))));}
      function click(label,scope=document){var node=[...scope.querySelectorAll('button')].find(el=>el.textContent.trim()===label||el.title===label||el.getAttribute('aria-label')===label);if(!node)throw Error('Missing '+label);dom.flushSync(()=>node.click());}
      void 0;`);
    assert.equal(await run('raw.available&&raw.images.length===3&&raw.images[0].poster'),true);
    assert.equal(await run('raw.images[1].url'), 'https://images.example/full.jpg');
    assert.equal(await run('JSON.stringify(raw.blocks).includes("Comment must not appear")||JSON.stringify(raw.blocks).includes("private account text")||JSON.stringify(raw.blocks).includes("pageExecuted")||!!window.pageExecuted'),false);
    assert.equal(await run('forged.truncated&&forged.blocks.map(b=>b.text).join("").length<=60000&&!empty.available'),true);
    checks.push('First-post extraction preserves text, lists and lazy images, omits executable/account/reply content and bounds output');
    await run(`(async()=>{var c=document.createElement('canvas');c.width=3840;c.height=2160;var g=c.getContext('2d');g.fillStyle='#1b3047';g.fillRect(0,0,c.width,c.height);g.fillStyle='#a6d4ff';g.font='150px sans-serif';g.fillText('HAVVN',250,450);g.font='80px sans-serif';g.fillText('Тестовая обложка и кадры',250,650);await ipc.invoke('fixture:seed','cover',c.toDataURL('image/png'));await ipc.invoke('fixture:seed','screen-one',c.toDataURL('image/jpeg'));g.fillStyle='#ba4e21';g.fillRect(0,1000,3840,1000);await ipc.invoke('fixture:seed','screen-two',c.toDataURL('image/webp'));mount('initial');})()`);
    await wait('Description and a native-decoded cover load', '!!document.querySelector(".release-details-poster img")');
    assert.equal(await run('calls.filter(c=>c.kind==="image").length'),1,'gallery images are lazy');
    assert.equal(await run('document.querySelector(".release-details-modal").getBoundingClientRect().height>700'),true,'dialog escapes containing blocks');
    await capture('details-wide');win.setContentSize(440,820);await capture('details-narrow');
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll(".release-details-modal .um-foot .btn")].every(el=>{var r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})'),true);
    await run('click(t("search.preview.screenshots")+" (2)")');
    await wait('Screenshot tab loads its JPEG and WebP images', 'document.querySelectorAll(".release-details-gallery img").length===2');
    await capture('screenshots-narrow');
    await run('dom.flushSync(()=>document.querySelector(".release-details-gallery .release-image-open").click())');
    await wait('Gallery opens above the details card','!!document.querySelector(".release-image-viewer img")');
    await run('click(t("search.preview.next"))');await pause(100);
    await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await pause(80);
    assert.equal(await run('!document.querySelector(".release-image-viewer")&&!!document.querySelector(".release-details-modal")&&closeCount===0'),true);
    checks.push('Gallery navigation and Escape retain the parent card');
    await run(`click(t('search.download'));`);await pause(80);await run(`click(t('search.row.selectFiles'));`);await pause(80);
    assert.deepEqual(await run('calls.filter(c=>["download","files"].includes(c.kind)).map(c=>c.ref)'),['rt-ref','rt-ref']);
    await run(`click(t('search.preview.source'));dom.flushSync(()=>[...document.querySelectorAll('[role=option]')].find(el=>el.textContent.trim()==='Другой источник').click());`);
    await wait('A different source replaces the description and keeps basic actions','document.body.textContent.includes(t("search.preview.unsupported"))&&!document.querySelector(".release-details-poster")');
    await run(`mode='hold';mount('stale');`);await pause(80);await run(`var stale=jobs.at(-1);mode='empty';mount('new');stale.resolve({...detail(),title:'Old result'});`);await pause(100);
    assert.equal(await run('!document.body.textContent.includes("Old result")&&document.body.textContent.includes(t("search.preview.empty"))'),true);
    checks.push('Late replies are ignored and a valid empty description is distinguished');
    await run(`mode='auth';mount('auth');`);await wait('Authentication failures retain sign-in and retry','document.body.textContent.includes(t("search.preview.auth"))');
    await run(`click(t('search.connection.login'));mode='success';click(t('common.retry'));`);await wait('Retry restores the release','!!document.querySelector(".release-details-poster img")');
    assert.equal(await run('calls.some(c=>c.kind==="login"&&c.id==="rt")'),true);
    await run(`imageFailure=true;mount('image-failure');`);await wait('An image failure is visible without losing the description','document.body.textContent.includes(t("search.preview.imageFailed"))&&!!document.querySelector(".release-details-description")');
    await run(`imageFailure=false;click(t('common.retry'),document.querySelector('.release-details-poster'));`);await wait('An image retry recovers','!!document.querySelector(".release-details-poster img")');
    await run('document.documentElement.dataset.theme="light"');win.setContentSize(1000,820);await capture('details-light');
    await run('dom.flushSync(()=>tree.unmount())');await pause(80);assert.deepEqual(errors,[]);assert.deepEqual(await run('rejections'),[]);
    assert.ok(nativeSizes.length>=3&&nativeSizes.every(s=>s.width<=1600&&s.height<=1600));
    assert.ok(networkReads.every(r=>r.omitCookies===true));
    assert.equal(BrowserWindow.getAllWindows().length,1,'temporary image decoders must be destroyed');
    checks.push('Native PNG/JPEG/WebP normalization bounds decoded previews to 1600px and external requests omit cookies');
    fs.writeFileSync(path.join(out,'ui-report.json'),JSON.stringify({passed:true,checks,nativeSizes,networkReads,errors},null,2));
    console.log('Release preview UI passed:',out);service.clear();clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
