// Real React surfaces and the read-only production inspector, in a private profile.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-ux-actions-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_ACTIONS_FIXTURE: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Invalid fixture directory'); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron'), root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_ACTIONS_FIXTURE || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const output = path.join(root, 'artifacts/ux-actions-20261108'); fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => { console.error('Actions UI deadline'); app.exit(1); }, 120000);
  app.whenReady().then(async () => {
    const inspect = require(path.join(root, 'dist/electron/electron/services/download-help.js')).inspectDownloadHelp;
    const base = { id: 'fixture-0', name: 'Очень длинное название фильма и дополнительных материалов.mp4', status: 'downloading', totalSize: 100, progress: .4, updatedAt: new Date(1) };
    let helpCase = 'no-files', inspections = 0;
    const effective = { blocks: [], applied: true, engine: { altSpeedEnabled: false }, ...Object.fromEntries(['download', 'upload', 'connections'].map(k => [k, { base: 0, value: 0, sources: [{ kind: 'manual' }], constraints: [] }])) };
    ipcMain.handle('fixture:helpCase', (_event, value) => { helpCase = value; });
    ipcMain.handle('fixture:inspect', (_event, id) => { inspections++; return inspect(id, {
      download: async () => ({ ...base, status: helpCase === 'paused' ? 'paused' : 'downloading' }),
      stats: () => [{ id: base.id, status: helpCase === 'paused' ? 'paused' : 'downloading', progress: .4, peers: helpCase === 'unknown' ? 2 : 0, downSpeedBps: 0 }],
      settings: async () => ({ ...effective, blocks: helpCase === 'disk' ? ['disk'] : [] }),
      files: async () => [{ name: 'film.mp4', path: 'film.mp4', length: 100, downloaded: 40, progress: .4, priority: helpCase === 'no-files' ? 'skip' : 'normal' }],
    }); });
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/pages/DownloadsPage.css','renderer/pages/SearchPage.css','renderer/pages/SettingsPage.css','renderer/pages/settings/controls.css',
      'renderer/components/Modal.css','renderer/components/ContextMenu.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css','renderer/components/SearchQueryInput.css','renderer/components/Toast.css','renderer/components/ErrorMessage.css','renderer/components/RecoveryError.css','renderer/components/DownloadHelpModal.css','renderer/styles/focus.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(scratch, 'ui.html'); fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '#root{height:100vh}*{animation:none!important;transition:none!important}.fixture-controls{padding:24px;max-width:700px;margin:auto;overflow:auto;max-height:100vh}.fixture-controls>label{display:block;margin:12px 0}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1250, height: 950, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = [], checks = []; win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Renderer:', event.message); } });
    await win.loadFile(html); const run = code => win.webContents.executeJavaScript(code), pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (name, expression) => { for (let i = 0; i < 100; i++) { if (await run(expression)) { checks.push(name); return; } await pause(40); } assert.fail(name + ': ' + await run('document.body.innerText.slice(-2200)')); };
    const check = async (name, expression) => { assert.equal(await run(expression), true, name); checks.push(name); };
    const click = async (key, scope = 'document') => { await until('Available: ' + key, `!!btn(${JSON.stringify(key)},${scope})`); await run(`btn(${JSON.stringify(key)},${scope}).focus();btn(${JSON.stringify(key)},${scope}).click();true;`); await pause(); };
    const key = async keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(); };
    const capture = async name => { const visible = win.isVisible(); win.showInactive(); await pause(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); if (!visible) win.hide(); };
    await run(`var fixtureRoot=${JSON.stringify(root)},testSavedViews=true,testDownloadUndo=true,mutations=[],routes=[],resumeFails=true,helpActions=[],inspector=()=>require('electron').ipcRenderer.invoke('fixture:inspect','fixture-0');
      var fixtureApiOverrides={getDownloads:async()=>fixtureRows.map(row=>({...row})),inspectDownloadHelp:()=>inspector(),getEffectiveSettings:async()=>(${JSON.stringify(effective)}),resumeDownload:async id=>{mutations.push(['resume',id]);if(resumeFails){resumeFails=false;throw Error('EACCES: permission denied')}fixtureRows.find(row=>row.id===id).status='downloading';},pauseDownload:async id=>{mutations.push(['pause',id]);fixtureRows.find(row=>row.id===id).status='paused';}};
      ${fs.readFileSync(path.join(root, 'scripts/fixtures/command-palette-ui.cjs'), 'utf8')}
      dom.flushSync(()=>tree.render(null));fixtureRows=fixtureRows.slice(0,1);fixtureRows[0].name=${JSON.stringify(base.name)};
      Object.assign(components,...['ContextMenu','Modal','CategorySelect','QRCode','ThemeSelector','HotkeySettings','Avatar','Identicon','Tabs','AppStatistics','TorrentFileSelector'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var ConfirmProvider=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      function mount(Component,props={}){dom.flushSync(()=>tree.render(null));dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(ConfirmProvider,null,React.createElement(Component,props)))));}
      function btn(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key)||node.title===t(key)||node.getAttribute('aria-label')===t(key));}
      var Downloads=load(path.join(fixtureRoot,'renderer/pages/DownloadsPage.tsx')).default,Help=load(path.join(fixtureRoot,'renderer/components/DownloadHelpModal.tsx')).DownloadHelpModal,Recovery=load(path.join(fixtureRoot,'renderer/components/RecoveryError.tsx')).RecoveryError;
      mount(Downloads,{onOpenEvents:()=>routes.push('events'),onOpenSetting:entry=>routes.push(entry.section)});true;`);
    await until('Downloads load', `!!document.querySelector('.download-item')`);
    await run(`load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel.refresh().then(()=>true)`);
    await until('Long source name is loaded', `document.body.innerText.includes('Очень длинное название')`);
    await check('Header keeps three labelled actions', `document.querySelectorAll('.page-actions button').length===3`);
    await click('downloads.tools', `document.querySelector('.page-header')`);
    await check('More focuses its first supported command', `document.activeElement.getAttribute('role')==='menuitem'`);
    await key('End'); await check('Menu End reaches final command', `document.activeElement.textContent.includes(t('downloads.exportCsv'))`);
    await key('Escape'); await check('Escape restores header trigger', `!document.querySelector('[role=menu]')&&document.activeElement.textContent.includes(t('downloads.tools'))`);
    await click('downloads.tools', `document.querySelector('.page-header')`); await click('downloads.detailedView');
    await until('Detailed view opens', `!!document.querySelector('.download-item-detailed')`);
    for (const width of [1250, 760, 460, 360]) {
      win.setContentSize(width, 900); await pause(120);
      await check('Commands fit width ' + width, `[...document.querySelectorAll('.page-actions button,.download-item-actions button')].filter(el=>getComputedStyle(el).display!=='none').every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})`);
    }
    await check('Narrow header stays compact', `document.querySelector('.download-detailed-header').getBoundingClientRect().height<180`);
    await capture('downloads-narrow');
    await click('downloads.more', `document.querySelector('.download-item-actions')`); await until('Row More opens the complete menu', `!!btn('downloads.deleteWithFiles')&&!!btn('downloads.advancedControls')&&!!btn('downloads.help')`);
    await key('Escape'); await check('Row More returns focus to its trigger', `document.activeElement.textContent.includes(t('downloads.more'))`);
    await click('downloads.resume', `document.querySelector('.download-item-actions')`); await until('Failed command keeps object and recovery actions', `!!document.querySelector('[data-recovery-error]')&&!!btn('downloads.resume',document.querySelector('.toast'))`);
    await capture('error-actions'); await click('downloads.resume', `document.querySelector('.toast')`);
    await until('Retry succeeds once', `mutations.length===2&&fixtureRows[0].status==='downloading'&&btn('downloads.resume',document.querySelector('.toast')).disabled`);
    await run(`btn('downloads.resume',document.querySelector('.toast')).click();true;`); await check('Completed retry cannot repeat successful operation', `mutations.length===2`);
    await click('recovery.events', `document.querySelector('.toast')`); await check('Recovery reaches the existing event center', `routes.at(-1)==='events'`);
    await run(`var originalRows=fixtureRows;fixtureRows=[];true;`); await click('downloads.recovery.folder', `document.querySelector('.toast')`);
    await until('Removed recovery target keeps the original failure and explains the missing object', `document.querySelectorAll('.toast [role=alert]').length===2&&!document.querySelector('[role=dialog]')`);
    await run(`fixtureRows=originalRows;true;`);
    win.setContentSize(1100, 900);
    await run(`mount(Help,{id:'fixture-0',onClose:()=>dom.flushSync(()=>tree.render(null)),onAction:action=>helpActions.push(action),canOpenSettings:true});true;`);
    await until('Inspector confirms all files excluded', `document.querySelector('[data-download-help-reason]')?.dataset.downloadHelpReason==='no-files'`);
    await check('Inspection is read-only and offers file selection', `mutations.length===2&&!!btn('downloadHelp.action.files')&&!btn('downloadHelp.action.resume')`);
    await capture('download-help'); await click('downloadHelp.action.files'); await check('File remedy preserves its source context', `helpActions.at(-1)==='files'`);
    await run(`require('electron').ipcRenderer.invoke('fixture:helpCase','disk')`); await click('downloadHelp.refresh');
    await until('Current disk guard is explicit', `document.querySelector('[data-download-help-reason]')?.dataset.downloadHelpReason==='disk'&&!!btn('downloadHelp.action.storage')&&!btn('downloadHelp.action.resume')`);
    await click('downloadHelp.action.storage'); await check('Storage remedy is explicit', `helpActions.at(-1)==='storage'&&mutations.length===2`);
    await run(`require('electron').ipcRenderer.invoke('fixture:helpCase','unknown')`); await click('downloadHelp.refresh');
    await until('Zero speed with peers remains unknown', `document.querySelector('[data-download-help-reason]')?.dataset.downloadHelpReason==='unknown'`);
    await run(`var pendingInspect;inspector=()=>new Promise(resolve=>pendingInspect=resolve);true;`); await click('downloadHelp.refresh'); await click('common.close');
    await check('Read-only inspection can be dismissed while pending', `!document.querySelector('[role=dialog]')`);
    await run(`pendingInspect({});inspector=()=>require('electron').ipcRenderer.invoke('fixture:inspect','fixture-0');true;`);
    await run(`var pendingRecovery,recoveryCalls=0;mount(Recovery,{error:Error('EACCES: fixture'),context:{object:'original object',actions:[{id:'retry',label:'Recover',kind:'retry',run:()=>{recoveryCalls++;return new Promise(resolve=>pendingRecovery=resolve)}}]}});true;`);
    await run(`var recoveryButton=document.querySelector('[data-recovery-error] button');recoveryButton.click();recoveryButton.click();true;`);
    await check('Pending recovery is protected from duplicate clicks', `recoveryCalls===1`); await run(`pendingRecovery();true;`); await pause();
    await check('Successful recovery stays disabled for the same error', `document.querySelector('[data-recovery-error] button').disabled`);
    await run(`var Input=load(path.join(fixtureRoot,'renderer/components/Input.tsx')).Input,Query=load(path.join(fixtureRoot,'renderer/components/SearchQueryInput.tsx')).SearchQueryInput,Controls=load(path.join(fixtureRoot,'renderer/pages/settings/controls.tsx')),Select=load(path.join(fixtureRoot,'renderer/components/Select.tsx')).Select,Modal=load(path.join(fixtureRoot,'renderer/components/Modal.tsx')).Modal,Menu=load(path.join(fixtureRoot,'renderer/components/DropdownMenu.tsx')).DropdownMenu;
      function Fields(){const[value,setValue]=React.useState(''),[count,setCount]=React.useState(1),[dialog,setDialog]=React.useState(false);return React.createElement('div',{className:'fixture-controls'},React.createElement(Query,{value,onChange:setValue,history:[]}),React.createElement(Input,{label:'Название',value,onChange:e=>setValue(e.target.value),helpText:'Описание поля'}),React.createElement(Controls.SettingRow,{label:'Очень длинное название настройки с подробным описанием',description:'Эта подпись должна переноситься и оставаться доступной при крупном масштабе.',control:React.createElement(Controls.NumberField,{value:count,onChange:setCount,min:0,max:100,ariaLabel:'Количество'})}),React.createElement(Select,{value:'ru',options:[{value:'ru',label:'Русский язык с длинной подписью'},{value:'en',label:'English'}],onChange:()=>{}}),React.createElement('button',{onClick:()=>setDialog(true)},'Open dialog'),dialog&&React.createElement(Modal,{title:'Проверка возврата фокуса',onClose:()=>setDialog(false)},React.createElement(Input,{label:'Вложенное поле'}),React.createElement(Menu,{portal:true,renderTrigger:({toggle,open})=>React.createElement('button',{onClick:toggle,'aria-expanded':open},'Nested menu'),items:[{key:'x',label:'Операция',onSelect:()=>{}}]})));}
      mount(Fields);true;`);
    win.setContentSize(900, 900); win.webContents.setZoomFactor(2); win.show(); win.focus(); await pause(150);
    await run(`document.querySelector('.search-input').focus();true;`); await key('ArrowRight');
    await check('Search has one outer keyboard indicator', `(()=>{const input=document.querySelector('.search-input'),outer=input.closest('.search-query-input');return getComputedStyle(input).outlineStyle==='none'&&getComputedStyle(input).boxShadow==='none'&&getComputedStyle(outer).outlineWidth==='2px'})()`);
    await run(`var stable=document.querySelector('.input-field input');var stableId=stable.id;stable.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(stable,'Текст');dom.flushSync(()=>stable.dispatchEvent(new Event('input',{bubbles:true})));true;`);
    await check('Input identity and label survive edits', `document.querySelector('.input-field input').id===stableId&&document.querySelector('.input-field label').htmlFor===stableId&&document.getElementById(stableId).getAttribute('aria-describedby')===stableId+'-hint'`);
    await run(`document.querySelector('.stg-num input').focus();true;`); await key('ArrowRight');
    await check('Composite numeric field has one focus indicator', `getComputedStyle(document.querySelector('.stg-num')).outlineWidth==='2px'&&getComputedStyle(document.querySelector('.stg-num input')).outlineStyle==='none'`);
    await check('Controls fit at 200 percent zoom', `[...document.querySelectorAll('.fixture-controls input,.custom-select-trigger')].every(el=>el.getBoundingClientRect().right<=innerWidth+1)&&document.documentElement.scrollWidth<=innerWidth`);
    await capture('focus-200-percent');
    await run(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Open dialog').focus();document.activeElement.click();true;`); await until('Nested dialog opens', `!!document.querySelector('[role=dialog]')`);
    await run(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Nested menu').focus();document.activeElement.click();true;`); await until('Nested menu focuses item', `document.activeElement.getAttribute('role')==='menuitem'`);
    await key('Tab'); await check('Tab leaves the owned menu inside the dialog', `!!document.querySelector('[role=dialog]')&&!document.querySelector('[role=menu]')&&document.activeElement.textContent==='Nested menu'`);
    await run(`document.activeElement.click();true;`); await until('Nested menu opens again', `document.activeElement.getAttribute('role')==='menuitem'`);
    await key('Escape'); await check('Escape closes menu and retains the dialog', `!!document.querySelector('[role=dialog]')&&!document.querySelector('[role=menu]')&&document.activeElement.textContent==='Nested menu'`);
    await key('Escape'); await check('Dialog close returns focus to its opener', `!document.querySelector('[role=dialog]')&&document.activeElement.textContent==='Open dialog'`);
    win.webContents.setZoomFactor(1);
    await run(`var Toasts=load(path.join(fixtureRoot,'renderer/components/Toast.tsx')).ToastContainer;mount(Toasts,{onClose:()=>{},toasts:Array.from({length:6},(_,index)=>({id:'error-'+index,message:'EACCES: fixture',variant:'error',duration:0,recovery:{object:'Объект '+index,actions:[{id:'retry',label:t('downloads.retry'),kind:'retry',run:()=>{}}]}}))});true;`);
    await check('Many recoverable errors keep most of the screen available', `(()=>{const el=document.querySelector('.toast-container');return el.getBoundingClientRect().height<=innerHeight*.55+1&&el.scrollHeight>el.clientHeight&&getComputedStyle(el).overflowY==='auto'})()`);
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));document.documentElement.dataset.theme='light';fixtureSetLanguage('en');mount(Recovery,{error:Error('EACCES: fixture'),context:{object:'Example download',actions:[{id:'refresh',label:t('downloadHelp.refresh'),run:()=>{}}],onOpenEvents:()=>{}}});true;`);
    await check('Recovery uses English labels and a readable English cause', `!!btn('recovery.events')&&!!btn('downloadHelp.refresh')&&document.querySelector('.user-error-message')?.lang==='en'&&document.body.textContent.includes('Permission')`);
    assert.deepEqual(errors, []); checks.push('No renderer errors');
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ checks, errors, inspections }, null, 2));
    console.log('PASS UX actions:', checks.length, 'checks'); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
