/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron acceptance. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'havvn-automation-'));
  const launch=stage=>new Promise((resolve,reject)=>{const env={...process.env,HAVVN_AUTOMATION_TEST:scratch,HAVVN_AUTOMATION_STAGE:stage};delete env.ELECTRON_RUN_AS_NODE;
    const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Automation stage failed: '+stage)));});
  (async()=>{try{await launch('main');await launch('restart');}finally{const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('havvn-automation-')){console.error('Unexpected profile; cleanup skipped');process.exitCode=1;}else fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}})().catch(error=>{console.error(error);process.exitCode=1;});
}else{
  const {app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_AUTOMATION_TEST||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith('havvn-automation-'))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
  const deadline=setTimeout(()=>{console.error('Automation deadline');app.exit(1);},100000);
  app.whenReady().then(async()=>{
    const output=path.resolve(root,process.env.HAVVN_AUTOMATION_ARTIFACTS||'artifacts/fun04/ui');fs.mkdirSync(output,{recursive:true});
    const db=require(path.join(root,'dist/electron/electron/db/store.js'));
    const service=require(path.join(root,'dist/electron/electron/services/automation-runtime.js')).getAutomationRules();
    const checks=[],check=(value,name)=>{assert(value,name);checks.push(name);console.log('PASS '+name);};
    if(process.env.HAVVN_AUTOMATION_STAGE==='restart'){
      const before=await service.snapshot();await service.recover();const after=await service.snapshot();
      check(after.config.rules.length===before.config.rules.length&&after.history.length===2,'encrypted rules and both durable receipts survive a fresh Electron process');
      check(JSON.stringify(before.history)===JSON.stringify(after.history),'restart recovery leaves completed effects unchanged');
      const report=JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8'));report.restart={passed:true,checks};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
      clearTimeout(deadline);app.exit(0);return;
    }
    await db.updateSettings({defaultDownloadDir:path.join(scratch,'downloads'),enableNotifications:false,enableSounds:false});
    const categories=await db.getCategories(),first=categories[0],second=categories[1];assert(first&&second);
    const css=require('./smoke-ui-fonts.cjs')(root)+['renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/pages/settings/controls.css','renderer/pages/settings/sections/AutomationSection.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css'].map(file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html=path.join(scratch,'ui.html');fs.writeFileSync(html,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'#root{box-sizing:border-box;max-width:1000px;padding:24px;margin:auto}</style><div id="root"></div></html>');
    let trustedWindow=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,preload:path.join(root,'dist/electron/electron/preload.js')}});
    require(path.join(root,'dist/electron/electron/ipc/automation-rules.js')).registerAutomationIpc(()=>trustedWindow);
    await trustedWindow.loadFile(html);const bridge=code=>trustedWindow.webContents.executeJavaScript(code);
    const initial=await bridge('window.api.automation.get()');check(initial.storage==='ready'&&initial.config.rules.length===0,'production preload reads empty rule storage');
    const rule=(id,event,actions)=>({id,version:1,name:id==='add'?'Сериалы в выбранную категорию':'После завершения',enabled:true,event,conditions:{nameContains:'Series'},actions,overrideExplicit:false});
    const rules=[rule('add','added',{categoryId:first.id,defaults:{paused:true,seedRatioLimit:2,sequentialDownload:true},notify:true}),rule('finish','completed',{categoryId:second.id,notify:true}),rule('conflict','added',{categoryId:second.id,defaults:{paused:false}})];
    const saved=await bridge(`window.api.automation.save(${JSON.stringify({...initial.config,rules})})`);check(saved.config.revision===1,'production IPC saves validated rules');
    const configFile=path.join(app.getPath('userData'),'automation.json'),hash=()=>crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex'),before=hash();
    const preview=await bridge(`window.api.automation.preview({event:'added',name:'Series S01',sourceType:'magnet',explicitCategory:false,explicitDefaults:{}},${JSON.stringify(rules)})`);
    check(preview.categoryId===first.id&&preview.trace[2].reasons.includes('earlier-rule')&&hash()===before&&(await db.getAllDownloads()).length===0,'dry run explains conflicts without writing config or creating a download');
    const prepared=await service.prepare({sourceType:'magnet',sourceUri:'magnet:?xt=urn:btih:'+'1'.repeat(40),name:'Series S01'});
    const request=await require(path.join(root,'dist/electron/electron/services/download-defaults.js')).prepareDownloadDefaults(prepared.request,categories,await db.getSettings());
    const download=await db.createDownload({name:request.name,sourceType:request.sourceType,sourceUri:request.sourceUri,savePath:request.savePath,status:request.paused?'paused':'queued',category:request.categoryId,seedRatioLimit:request.seedRatioLimit,sequentialDownload:request.sequentialDownload,automation:{added:prepared.receipt}});
    await service.process(download.id);let live=await db.getDownloadById(download.id);
    check(live.status==='paused'&&live.category===first.id&&live.categoryOrigin==='automation'&&live.seedRatioLimit===2&&live.sequentialDownload===true,'new defaults and receipt are committed with the download before engine startup');
    check(live.automation.added.runs.every(run=>run.status==='completed'),'atomic add receipt is drained with notifications suppressed by real app policy');
    await db.updateDownloadFields(download.id,{status:'seeding',automationCompletedAt:Date.now()});await service.process(download.id);live=await db.getDownloadById(download.id);
    const completionId=live.automation.completed.id;
    check(live.category===second.id&&live.automation.completed.runs.every(run=>run.status==='completed'),'true completion captures its receipt and can replace an automated category');
    await db.updateDownloadFields(download.id,{automationCompletedAt:Date.now()});await service.process(download.id);await service.recover();live=await db.getDownloadById(download.id);
    const events=require(path.join(root,'dist/electron/electron/services/app-events.js')).getAppEvents().list().items;
    check(live.automation.completed.id===completionId&&(await db.getAllDownloads()).length===1&&events.some(event=>event.code==='automation-applied'&&event.object.id===download.id),'duplicate completion and recovery reuse one event and one download; results reach event history');
    const win=new BrowserWindow({show:false,width:1000,height:950,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});await win.loadFile(html);
    const run=code=>win.webContents.executeJavaScript(code),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms??100));
    const errors=[];win.webContents.on('console-message',message=>{if(message.level==='error')errors.push(message.message);});
    check(await run(`require('electron').ipcRenderer.invoke('automation:get').then(()=>false,()=>true)`),'untrusted renderer cannot access automation IPC');
    trustedWindow.destroy();trustedWindow=win;
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(db.readSettingsImportState())},fixtureCategories=${JSON.stringify(categories)};var fixtureApiOverrides={automation:{get:()=>require('electron').ipcRenderer.invoke('automation:get'),save:config=>require('electron').ipcRenderer.invoke('automation:save',config),preview:(input,rules)=>require('electron').ipcRenderer.invoke('automation:preview',input,rules),retry:(id,event)=>require('electron').ipcRenderer.invoke('automation:retry',id,event)}};`+fs.readFileSync(path.join(root,'scripts/fixtures/command-palette-ui.cjs'),'utf8'));
    await run(`dom.flushSync(()=>tree.unmount());var Automation=load(path.join(fixtureRoot,'renderer/pages/settings/sections/AutomationSection.tsx')).AutomationSection;tree=createRoot(document.getElementById('root'));dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Automation))));void 0;`);await wait(250);
    const button=key=>`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===t('${key}'))`;
    const setText=async(label,value)=>{await run(`var field=[...document.querySelectorAll('label')].find(e=>e.textContent.startsWith(t('${label}'))).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));void 0;`);await wait();};
    check(await run(`document.querySelectorAll('.automation-rule').length===3&&document.querySelector('.automation-history')!==null`),'actual settings editor loads rules and durable execution history');
    check(await run(`document.querySelectorAll('.automation-rule input.stg-text').length>0&&[...document.querySelectorAll('.automation-rule [role=combobox]')].some(e=>e.textContent.includes(${JSON.stringify(first.name)}))`),'text fields use themed controls and categories resolve to their labels');
    await setText('automation.sampleName','Series S02');await run(`${button('automation.preview')}.click()`);await wait(250);
    check(await run(`document.querySelector('[data-automation-preview]').textContent.includes(t('automation.reason.earlier-rule'))`),'actual dry-run form explains the conflicting rule');
    await run(`${button('automation.add')}.click()`);await wait();
    check(await run(`document.querySelectorAll('.automation-rule').length===4&&document.querySelectorAll('.automation-rule')[3].textContent.includes(t('automation.disabled'))`),'new rules start disabled');
    await run(`${button('automation.save')}.click()`);await wait(250);
    check((await service.snapshot()).config.rules.length===4,'editor saves through the production main service');
    await run(`${button('automation.add')}.click()`);await wait();
    const external=await service.snapshot();await service.save({...external.config,rules:external.config.rules.map((rule,index)=>index===0?{...rule,name:'Изменено в другом окне'}:rule)});
    await run(`${button('automation.save')}.click()`);await wait(250);
    check(await run(`!!document.querySelector('[role=alert]')&&document.querySelectorAll('.automation-rule').length===5`),'stale save shows an error and retains the draft');
    await run(`${button('automation.reload')}.click()`);await wait(250);
    check(await run(`document.querySelectorAll('.automation-rule').length===4&&!document.querySelector('[role=alert]')`),'reload resolves a save conflict without losing stored rules');
    const screenshots=[];
    for(const language of ['ru','en'])for(const width of [1000,440]){
      await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/${language}.json'),'utf8'));document.documentElement.lang='${language}';dom.flushSync(()=>fixtureSetLanguage('${language}'));document.querySelector('.automation-rule').open=true;void 0;`);win.setContentSize(width,950);await wait(150);
      check(await run(`document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.automation-section .btn')].every(e=>e.scrollWidth<=e.clientWidth+1)`),language+' '+width+' labels and buttons fit');
      await run(`scrollTo(0,0);void 0;`);await wait();
      const name='editor-'+language+'-'+width+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());screenshots.push(name);
    }
    check(!errors.length,'editor has no React or runtime console errors');
    await run(`dom.flushSync(()=>tree.unmount());void 0;`);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({schema:1,passed:true,at:new Date().toISOString(),checks,screenshots,isolatedProfile:true,physicalMachines:1,electron:process.versions.electron,notificationsDisabled:true,realTorrentTransfer:false},null,2)+'\n');
    console.log('PASS automation complete');clearTimeout(deadline);app.exit(0);
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
