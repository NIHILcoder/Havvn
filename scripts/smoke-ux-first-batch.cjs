// Actual React pages and handlers, isolated profile; only OS/engine/provider boundaries are fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-ux-first-batch-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_UX_FIRST_BATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Unexpected fixture path');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_UX_FIRST_BATCH || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('UX UI deadline'); app.exit(1); }, 150000);
  app.whenReady().then(async () => {
    const output = path.resolve(root, process.env.HAVVN_UX_FIRST_BATCH_ARTIFACTS || 'artifacts/ux-first-batch-20261107'); fs.mkdirSync(output, { recursive: true });
    const settings = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/styles/appearance.css',
      'renderer/pages/DownloadsPage.css','renderer/pages/DownloadViewsBar.css','renderer/pages/SearchPage.css','renderer/pages/SettingsPage.css','renderer/pages/settings/shell.css','renderer/pages/settings/controls.css','renderer/pages/settings/SettingsNav.css','renderer/pages/settings/SpeedLimitField.css','renderer/pages/settings/EffectiveLimits.css',
      'renderer/components/Modal.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css','renderer/components/SearchQueryInput.css','renderer/components/DownloadDefaultsPreview.css','renderer/components/VirtualFileList.css','renderer/components/AddDownloadsModal.css','renderer/components/DownloadDeletionModal.css','renderer/components/TorrentFileSelector.css','renderer/components/TorrentFolderPicker.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'ui.html'); fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'#root{height:100vh}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show:false,width:1250,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false} });
    const errors=[]; win.webContents.on('console-message', event => { if(event.level==='error'){errors.push(event.message);console.error('Renderer: '+event.message);} });
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code), pause = (ms=70) => new Promise(resolve=>setTimeout(resolve,ms));
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},testSavedViews=true,testDownloadUndo=true;
      var searchCount=0,searchCancels=[],searchReceiver,addCalls=[],removalCalls=[],previewCount=0,failDeletion=false,failResume=true,resumeCalls=[],settingsJobs=[],holdSettings=false,effectiveOverride=null,effectivePulls=0,failEffective=false;
      var fixtureApiOverrides={
        search:{getProviders:async()=>[{id:'fixture',name:'Local fixture',enabled:true}],getDownloadHistory:async()=>[],onProgress:fn=>{searchReceiver=fn;return()=>{searchReceiver=null;}},
          start:async()=>({searchId:'search-'+(++searchCount),providers:['Local fixture'],providerIds:['fixture']}),cancel:async id=>{searchCancels.push(id);}},
        getCategories:async()=>[],selectTorrentFiles:async()=>['D:/fixture/one.torrent','D:/fixture/two.torrent'],
        getTorrentInfo:async request=>({name:request.magnetUri?'Magnet preview':request.torrentPath.split('/').at(-1),totalSize:1024,files:[{index:0,path:'payload.bin',size:1024}]}),
        addDownload:async request=>{addCalls.push(request);return {...fixtureRows[0],id:'new-'+addCalls.length,name:request.name,sourceUri:request.sourceUri};},
        resumeDownload:async id=>{resumeCalls.push(id);if(id==='fixture-1'&&failResume)throw Error('Synthetic permission denied');fixtureRows.find(row=>row.id===id).status='downloading';},
        previewDownloadDeletion:async id=>({token:'preview-'+(++previewCount),downloadId:id,name:'Fixture payload',metadataReady:true,expiresAt:Date.now()+120000,locations:['D:/fixture'],missing:1,bytes:1024,files:[{path:'D:/fixture/payload.bin',size:1024}]}),
        removeDownload:async(id,files,token)=>{removalCalls.push({id,files,token});if(failDeletion&&files)throw Error(load(path.join(fixtureRoot,'shared/user-errors.ts')).USER_ERRORS.deletionExpired[1]);return {undo:null};},
        updateSettings:async patch=>{if(holdSettings)await new Promise(resolve=>settingsJobs.push(resolve));Object.assign(settingsFixture.settings,patch);return {...settingsFixture.settings};},
        getIpInfo:async()=>({ip:'',vpnDetected:false}),getVpnBindStatus:async()=>null,isEncryptionAvailable:async()=>true,
        getEffectiveSettings:async()=>{effectivePulls++;if(failEffective)throw Error('Synthetic effective limits failure');return effectiveOverride??({...load(path.join(fixtureRoot,'shared/effective-settings.ts')).resolveEffectiveSettings(settingsFixture.settings,{scheduler:settingsFixture.scheduler}),applied:true});}
      };
      ${fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')}
      dom.flushSync(()=>tree.render(null));
      Object.assign(components,...['CategorySelect','QRCode','ThemeSelector','HotkeySettings','Identicon','Avatar','Modal','Tabs','AppStatistics','TorrentFileSelector'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var ConfirmProvider=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      function render(Component,props={}){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(ConfirmProvider,null,React.createElement(Component,props)))));}
      function mount(Component,props={}){dom.flushSync(()=>tree.render(null));render(Component,props);}
      function btn(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
      function value(node,text){Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,text);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));}
      var Downloads=load(path.join(fixtureRoot,'renderer/pages/DownloadsPage.tsx')).default,Search=load(path.join(fixtureRoot,'renderer/pages/SearchPage.tsx')).default;
      var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel;
      true;`);
    const checks=[], wait=async(expression)=>{for(let i=0;i<55;i++){if(await run(expression))return;await pause();}throw Error(expression);};
    const check=async(name,expression)=>{await wait(expression);checks.push(name);console.log('PASS '+name);};
    const capture=async name=>{await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await pause(200);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
    await run(`mount(Search);value(document.querySelector('.search-form input'),'Fixture query');document.querySelector('.search-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));true;`);
    await wait('searchCount===1'); await pause();
    await run(`searchReceiver({searchId:'search-1',results:Array.from({length:150},(_,i)=>({title:'Fixture film '+i,size:1024+i,seeds:150-i,peers:1,provider:'Local fixture',magnetUri:'magnet:?xt=urn:btih:'+i.toString(16).padStart(40,'0')})),stat:{name:'Local fixture',providerId:'fixture',count:150,ms:2,state:'ok'},done:true});true;`);
    await wait(`!!document.querySelector('.refine-input')`);
    await run(`value(document.querySelector('.refine-input'),'Fixture');document.querySelector('.results-scroll').scrollTop=500;document.querySelector('.results-scroll').dispatchEvent(new Event('scroll'));true;`);await pause();
    await run('mount(Downloads);true;');await pause();await run('mount(Search);true;');
    await check('Search restores query, filter, results and scroll without restarting providers',`document.querySelector('.search-form input').value==='Fixture query'&&document.querySelector('.refine-input').value==='Fixture'&&document.querySelector('.results-scroll').scrollTop>100&&!!document.querySelector('.search-session-notice')&&searchCount===1`);
    await capture('search-restored.png');
    await check('Search toolbar aligns its heading and keeps extra download fields collapsed',`(()=>{const heading=document.querySelector('.search-results-heading'),count=heading.querySelector('.search-result-count').getBoundingClientRect(),button=heading.querySelector('button[aria-expanded]').getBoundingClientRect();return Math.abs((count.top+count.bottom)/2-(button.top+button.bottom)/2)<3&&!document.querySelector('.results-add-options')&&document.querySelector('.results-scroll').getBoundingClientRect().height>150;})()`);
    await run(`var lateDownloadStyle=document.createElement('style');lateDownloadStyle.textContent=fs.readFileSync(path.join(fixtureRoot,'renderer/pages/DownloadsPage.css'),'utf8');document.head.append(lateDownloadStyle);true;`);
    await check('Loading download styles after search does not restyle its result count',`(()=>{const count=document.querySelector('.search-result-count'),style=getComputedStyle(count);return style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.borderTopWidth==='0px'&&style.paddingLeft==='0px';})()`);
    await run(`btn('search.downloadOptions').click();true;`);
    await check('Download options expand as two aligned fields',`(()=>{const fields=[...document.querySelectorAll('.search-add-field')].map(node=>node.getBoundingClientRect());return fields.length===2&&Math.abs(fields[0].top-fields[1].top)<2&&Math.abs(fields[0].width-fields[1].width)<2;})()`);
    await capture('search-options.png');
    await run(`document.querySelector('.search-add-field [role=combobox][aria-label="'+t('search.addPaused')+'"]').click();true;`);
    await wait(`!!document.querySelector('[role=listbox]')`);
    await run(`[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===t('category.defaults.paused')).click();true;`);
    await run(`btn('search.downloadOptions').click();true;`);await pause();await run(`btn('search.downloadOptions').click();true;`);
    await check('Collapsing download options preserves the selected start mode',`document.querySelector('.search-add-field [role=combobox][aria-label="'+t('search.addPaused')+'"]').textContent.includes(t('category.defaults.paused'))`);
    await run(`btn('search.downloadOptions').click();true;`);
    for (const width of [760,620,400]) {
      win.setSize(width,900);await pause(100);
      await check('Search controls stay inside the page at '+width+'px',`(()=>{const page=document.querySelector('.search-page').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.search-results-tools button,.search-results-tools input,.search-results-tools summary,.search-query-input')].every(node=>{const box=node.getBoundingClientRect();return !box.width||box.left>=page.left&&box.right<=page.right+1;});})()`);
      await capture('search-'+width+'.png');
    }
    win.setSize(1250,900);await pause(100);
    await run(`btn('search.session.refresh').click();true;`);await wait('searchCount===2');await pause();
    await run(`searchReceiver({searchId:'search-2',results:[{title:'Partial fixture',size:2,seeds:1,provider:'Local fixture',magnetUri:'magnet:?xt=urn:btih:'+'f'.repeat(40)}]});true;`);await pause();await run('mount(Downloads);true;');await pause();await run('mount(Search);true;');
    await check('Leaving a running search cancels it and marks the restored partial results',`searchCancels.includes('search-2')&&searchCount===2&&document.querySelector('.search-session-notice').textContent.includes(t('search.session.interrupted'))`);
    await run(`mount(Downloads);true;`);await wait(`!!document.querySelector('[data-download-id="fixture-1"]')`);
    await run(`dom.flushSync(()=>{for(const id of ['fixture-0','fixture-1'])document.querySelector('[data-download-id="'+id+'"] .download-checkbox').click();});btn('downloads.resume',document.querySelector('.bulk-actions-bar')).click();true;`);
    await check('Bulk action keeps failed rows selected and reports actual outcomes',`!!document.querySelector('.download-batch-result')&&document.querySelector('[data-download-id="fixture-1"] .download-checkbox').checked&&resumeCalls.length===2`);
    await run(`mount(Search);true;`);await pause();await run(`mount(Downloads);true;`);
    await check('Bulk failure remains reviewable after navigating away',`!!btn('downloads.batch.retry')`);
    await run(`failResume=false;btn('downloads.batch.retry').click();true;`);
    await check('Retry repeats only the failed download',`resumeCalls.length===3&&resumeCalls[2]==='fixture-1'&&!btn('downloads.batch.retry')`);
    await run(`fixtureRows[0].totalSize=16*1024**2;model.updateDownloads(rows=>rows.map(row=>row.id===fixtureRows[0].id?{...row,totalSize:fixtureRows[0].totalSize}:row));statsReceiver([{...fixtureRows[0],status:'downloading',progress:1/16,downloadedBytes:1024**2,uploadedBytes:8*1024**2,downSpeedBps:256*1024,upSpeedBps:32*1024}]);document.querySelector('[data-download-id="fixture-0"] .trow-main').click();true;`);
    await check('Downloading card displays both totals and both speeds',`(()=>{const card=document.querySelector('[data-download-id="fixture-0"]');return !!card&&card.textContent.includes(t('downloads.statDownSpeed'))&&card.textContent.includes(t('downloads.statUpSpeed'))&&card.textContent.includes('32 KB/s')&&card.textContent.includes('8 MB');})()`);
    await capture('transfer-card.png');
    for(const width of [620,400]) {
      win.setSize(width,900);await pause(100);
      await check('Transfer totals and rate labels fit at '+width+'px',`[...document.querySelectorAll('[data-download-id="fixture-0"] .stat-label')].every(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+1;})`);
      await capture('transfer-card-'+width+'.png');
    }
    win.setSize(1250,900);await pause(100);
    await run(`effectiveOverride={...load(path.join(fixtureRoot,'shared/effective-settings.ts')).resolveEffectiveSettings({...settingsFixture.settings,maxDownKbps:0,maxUpKbps:0,altSpeedEnabled:false},{economy:{maxUpKbps:128}}),applied:true};dom.flushSync(()=>btn('downloads.tools').click());btn('downloads.speedLimits').click();true;`);
    await check('Downloads exposes effective limits and the constraining policy',`(()=>{const modal=document.querySelector('.um-card');return !!modal&&modal.textContent.includes(t('effective.economy'))&&modal.textContent.includes('128')&&modal.textContent.includes(t('effective.unlimited'));})()`);
    await capture('effective-limits.png');
    await run(`document.querySelector('.um-x').click();var closedEffectivePulls=effectivePulls;true;`);await pause(5200);
    await check('Closing the limit viewer stops its background polling',`effectivePulls===closedEffectivePulls`);
    await run(`effectiveOverride={...effectiveOverride,applied:false};dom.flushSync(()=>btn('downloads.tools').click());btn('downloads.speedLimits').click();true;`);
    await check('Pending engine limits are identified as not yet applied',`document.querySelector('.um-card')?.textContent.includes(t('effective.pending'))`);
    await run(`document.querySelector('.um-x').click();true;`);await pause();await run(`failEffective=true;dom.flushSync(()=>btn('downloads.tools').click());btn('downloads.speedLimits').click();true;`);
    await check('Failed limit reads show unavailable without inventing a limit',`document.querySelector('.um-card')?.textContent.includes(t('effective.unavailable'))&&!document.querySelector('.um-card .effective-limits-item')`);
    await run(`document.querySelector('.um-x').click();failEffective=false;effectiveOverride=null;true;`);
    await run(`var filterViews=load(path.join(fixtureRoot,'renderer/utils/download-views.ts')).downloadViews;var filterViewId=filterViews.save('Проверка фильтров',{conditions:{status:'paused',category:null,name:'Archive',path:'D:/Downloads',minBytes:0,maxBytes:512},sort:{by:'name',direction:'asc'},mode:'compact'},true);var originalFilterViews=JSON.stringify(filterViews.getSnapshot().catalog.views);true;`);
    await check('All active conditions, including zero and uncategorized, are visible as chips',`document.querySelectorAll('.download-filter-chip').length===6&&document.querySelector('[data-filter-key=minBytes]').textContent.includes('0 B')&&document.querySelector('.empty-state-description')?.textContent===t('downloads.noMatchDesc')`);
    await capture('active-download-filters.png');
    await run(`document.querySelector('[data-filter-key=category]').click();true;`);
    await check('Removing one chip preserves the other five conditions and the saved view',`document.querySelectorAll('.download-filter-chip').length===5&&!document.querySelector('[data-filter-key=category]')&&JSON.stringify(filterViews.getSnapshot().catalog.views)===originalFilterViews&&filterViews.getSnapshot().catalog.activeId===filterViewId`);
    await run(`btn('views.clearFilters').click();true;`);
    await check('Clear filters restores rows without deleting the saved view or changing sort',`!document.querySelector('.download-filter-chip')&&!!document.querySelector('.downloads-vrow')&&JSON.stringify(filterViews.getSnapshot().catalog.views)===originalFilterViews&&document.querySelector('.sort-chip.active')?.textContent.includes(t('downloads.sortName'))`);
    await run(`document.querySelector('.download-views-select [role=combobox]').click();true;`);await wait(`!!document.querySelector('[role=option]')`);
    await run(`[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()==='Проверка фильтров').click();true;`);
    await check('Choosing the saved view restores its original conditions',`document.querySelectorAll('.download-filter-chip').length===6&&!!document.querySelector('.empty-state')`);
    for(const width of [620,400]){win.setSize(width,900);await pause(100);await check('Active filter chips are bounded and accessible at '+width+'px',`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.download-filter-chips').getBoundingClientRect().height<=109&&[...document.querySelectorAll('.download-filter-chip')].every(node=>node.getBoundingClientRect().right<=innerWidth+1)`);await capture('active-download-filters-'+width+'.png');}
    win.setSize(1250,900);await run(`btn('downloads.resetSort').click();true;`);
    await check('Reset sorting preserves every filter and the stored view',`document.querySelectorAll('.download-filter-chip').length===6&&document.querySelector('.sort-chip.active')?.textContent.includes(t('downloads.sortAdded'))&&JSON.stringify(filterViews.getSnapshot().catalog.views)===originalFilterViews`);
    await run(`btn('views.clearFilters').click();true;`);await pause();await run(`filterViews.select(null);true;`);await pause();
    await run(`document.querySelector('.add-download-link-btn').click();true;`);await wait(`!!document.querySelector('#add-downloads-links')`);
    await run(`value(document.querySelector('#add-downloads-links'),'magnet:?xt=urn:btih:'+'a'.repeat(40)+'\\nmagnet:?xt=urn:btih:'+'a'.repeat(40)+'\\nnot a link');btn('downloads.queue.files').click();true;`);
    await check('Unified add previews multiple files and visibly marks invalid/duplicate links',`document.querySelectorAll('.add-downloads-row').length===5&&document.querySelectorAll('.add-downloads-row input:disabled').length===2&&addCalls.length===0`);
    await capture('add-queue.png');
    await run(`[...document.querySelectorAll('.um-foot button')].find(node=>node.textContent.includes('3')).click();true;`);
    await wait(`!!document.querySelector('.tfs-queue-note')`);
    await check('Queue opens the first file for review before any add',`document.body.textContent.includes('one.torrent')&&addCalls.length===0`);
    await run(`btn('downloads.queue.skip').click();true;`);await wait(`document.body.textContent.includes('two.torrent')`);
    await run(`[...document.querySelectorAll('.um-foot button')].find(node=>node.textContent.includes(t('filePicker.downloadSelected'))).click();true;`);
    await check('Skip advances and Add processes just the reviewed source',`addCalls.length===1&&addCalls[0].sourceUri==='D:/fixture/two.torrent'`);
    await wait(`document.querySelector('.torrent-name')?.textContent.includes('Magnet preview')&&btn('common.cancel',document.querySelector('.um-card'))?.disabled===false`);await run(`btn('common.cancel',document.querySelector('.um-card')).click();true;`);
    await check('Cancel stops the remaining queue without adding the next item',`!document.querySelector('.um-card')&&addCalls.length===1`);
    await run(`mount(Downloads,{openTorrentUri:'D:/fixture/external-one.torrent'});true;`);await wait(`document.body.textContent.includes('external-one.torrent')`);
    await run(`render(Downloads,{openTorrentUri:'D:/fixture/external-two.torrent'});true;`);
    await check('A second external source joins the queue without replacing the current review',`document.body.textContent.includes('external-one.torrent')&&document.querySelector('.tfs-queue-note')?.textContent.includes('2')&&addCalls.length===1`);
    await run(`btn('downloads.queue.skip').click();true;`);await wait(`document.body.textContent.includes('external-two.torrent')`);
    await run(`var leaveCommitted=false;void load(path.join(fixtureRoot,'renderer/state/page-leave.ts')).pageLeave.run(()=>{leaveCommitted=true;mount(Search);});true;`);
    await check('Leaving an unfinished queue asks for confirmation',`document.body.textContent.includes(t('downloads.queue.leaveTitle'))&&!leaveCommitted`);
    await run(`btn('downloads.queue.leave').click();true;`);
    await check('Confirmed navigation cancels only unadded items',`leaveCommitted&&!document.querySelector('.um-card')&&addCalls.length===1`);
    await run(`var Deletion=load(path.join(fixtureRoot,'renderer/components/DownloadDeletionModal.tsx')).DownloadDeletionModal;var removedUi=[];mount(Deletion,{id:'fixture-0',onClose:()=>mount(Downloads),onRemoved:(result,files)=>removedUi.push(files)});true;`);
    await check('Deletion preview is explicit and confirmation starts disabled',`!!document.querySelector('.download-deletion-ack')&&btn('downloads.deletion.confirm').disabled&&removalCalls.length===0`);
    await capture('deletion-preview.png');
    await run(`document.querySelector('.download-deletion-ack input').click();failDeletion=true;btn('downloads.deletion.confirm').click();true;`);
    await check('A rejected preview cannot be blindly retried',`removalCalls.length===1&&btn('downloads.deletion.confirm').disabled&&document.querySelector('.download-deletion [role=alert]')!==null`);
    await check('Deletion expiry explains the available next step in Russian',`document.querySelector('.download-deletion [role=alert]').textContent.includes('Обновить список файлов')`);
    await run(`failDeletion=false;btn('downloads.deletion.refresh').click();true;`);await wait(`previewCount===2&&!document.querySelector('.download-deletion-ack input').disabled`);
    await run(`document.querySelector('.download-deletion-ack input').click();btn('downloads.deletion.confirm').click();true;`);
    await check('Confirmation passes the refreshed token and succeeds once',`removalCalls.length===2&&removalCalls[1].token==='preview-2'&&removedUi.length===1&&removedUi[0]===true`);
    await run(`mount(Deletion,{id:'fixture-0',onClose:()=>mount(Downloads),onRemoved:(result,files)=>removedUi.push(files)});true;`);await wait(`previewCount===3`);
    await run(`btn('downloads.deletion.keep').click();true;`);
    await check('Keep files uses the reversible entry-removal path',`removalCalls.length===3&&removalCalls[2].files===false&&removalCalls[2].token===undefined`);
    await run(`var settingsModule=load(path.join(fixtureRoot,'renderer/pages/settings/SettingsContext.tsx')),originalHook=settingsModule.useSettings;settingsModule.useSettings=()=>{var v=originalHook();window.ctx=v;return v;};var Settings=load(path.join(fixtureRoot,'renderer/pages/SettingsPage.tsx')).default,ThemeProvider=load(path.join(fixtureRoot,'renderer/components/ThemeEditorContext.tsx')).ThemeEditorProvider;function SettingsFixture(){return React.createElement(ThemeProvider,null,React.createElement(Settings));}mount(SettingsFixture);true;`);
    await wait('!!window.ctx?.settings&&!ctx.loading');
    await run(`dom.flushSync(()=>{ctx.setMaxDownKbps(777);ctx.setMaxUpKbps(888);ctx.setProxyPassword('PRIVATE-PASSWORD');});true;`);
    await check('Settings review lists independent changes and hides secrets',`document.querySelectorAll('.stg-change-review li').length===3&&!document.querySelector('.stg-change-review').textContent.includes('PRIVATE-PASSWORD')`);
    await run(`document.querySelector('.stg-change-review').open=true;btn('settings.review.reset',document.querySelector('.stg-change-review li')).click();true;`);
    await check('Reset restores only the selected setting',`ctx.maxDownKbps===settingsFixture.settings.maxDownKbps&&ctx.maxUpKbps===888&&ctx.proxyPassword==='PRIVATE-PASSWORD'&&document.querySelectorAll('.stg-change-review li').length===2`);
    await capture('settings-review.png');
    await run(`dom.flushSync(()=>ctx.handleReset());holdSettings=true;void ctx.selectEncryption('required');true;`);
    await check('Immediate saving has a visible pending state',`ctx.instantSaving>0&&document.querySelector('.stg-save-state').textContent.includes(t('settings.review.saving'))`);
    await run(`holdSettings=false;settingsJobs.shift()();true;`);await wait('ctx.instantSaving===0');
    await run(`var StatusBar=load(path.join(fixtureRoot,'renderer/layout/StatusBar.tsx')).StatusBar;mount(StatusBar,{availability:'unavailable',roomCount:1});true;`);
    await check('Footer distinguishes an unavailable download service from waiting for room peers',`document.body.textContent.includes(t('statusbar.service.unavailable'))&&document.body.textContent.includes(t('statusbar.roomPeersWaiting'))&&!document.querySelector('.status-service-ready')`);
    await run(`mount(StatusBar,{availability:'ready',roomCount:1,roomPresence:{roomId:'r',name:'Room',othersOnline:1,watching:false}});true;`);
    await check('Footer shows peers only when reported by the room',`document.body.textContent.includes(t('statusbar.roomPeersFound'))&&!!document.querySelector('.status-service-ready')`);
    win.setSize(640,800);await run(`mount(Deletion,{id:'fixture-0',onClose:()=>{},onRemoved:()=>{}});true;`);await wait(`!!document.querySelector('.download-deletion-ack')`);await capture('deletion-narrow.png');
    await check('Deletion controls fit a narrow window',`(()=>{var box=document.querySelector('.um-card').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1&&[...document.querySelectorAll('.um-foot button')].every(node=>node.getBoundingClientRect().right<=innerWidth+1);})()`);
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');document.documentElement.dataset.theme='light';true;`);
    await check('New controls use English labels in the light theme',`document.querySelector('.um-title').textContent.includes('Review file deletion')&&!document.querySelector('.download-deletion').textContent.includes('downloads.deletion.')`);
    await capture('deletion-en-light.png');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'ui-results.json'),JSON.stringify({checks,errors},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));clearTimeout(deadline);win.destroy();app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
