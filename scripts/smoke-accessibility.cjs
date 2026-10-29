// Actual React controls and handlers; keyboard events and accessibility tree
// come from Chromium. Services/native dialogs use a disposable local fixture.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const prefix='havvn-accessibility-';
if(!process.versions.electron){
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),env={...process.env,HAVVN_A11Y_SCRATCH:scratch};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1});child.on('exit',code=>{
    process.exitCode=code??1;const target=path.resolve(scratch);
    if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith(prefix))throw Error('Unexpected fixture path');
    fs.rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
}else{
  const {app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'..'),scratch=path.resolve(process.env.HAVVN_A11Y_SCRATCH||'');
  if(path.dirname(scratch)!==path.resolve(os.tmpdir())||!path.basename(scratch).startsWith(prefix))throw Error('Missing isolated profile');
  app.setPath('userData',path.join(scratch,'profile'));app.disableHardwareAcceleration();
  const deadline=setTimeout(()=>{console.error('Accessibility deadline');app.exit(1)},120000);
  app.whenReady().then(async()=>{
    const output=process.env.HAVVN_A11Y_OUTPUT || path.join(root,'dist/accessibility-ui');fs.mkdirSync(output,{recursive:true});
    const settings=require(path.join(root,'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css=require('./smoke-ui-fonts.cjs')(root)+[
      'renderer/styles/variables.css','renderer/styles/base.css','renderer/styles/components.css','renderer/styles/layout.css','renderer/styles/appearance.css',
      'renderer/components/Modal.css','renderer/components/Select.css','renderer/components/Toggle.css','renderer/components/NumberInput.css',
      'renderer/components/CommandPalette.css','renderer/components/TorrentFileSelector.css','renderer/components/ThemeEditor.css',
      'renderer/components/EventCenter.css','renderer/pages/DownloadsPage.css','renderer/pages/DownloadViewsBar.css','renderer/pages/RoomsPage.css',
      'renderer/pages/rooms/RoomSyncModal.css','renderer/pages/settings/controls.css',
    ].map(file=>fs.readFileSync(path.join(root,file),'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
    const html=path.join(scratch,'ui.html');fs.writeFileSync(html,'<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>'+css+'#root{height:100vh}#audit{position:fixed;inset:40px 0 0;z-index:200;overflow:auto;pointer-events:none}#audit>*{pointer-events:auto}#audit-launcher{position:fixed;left:8px;bottom:8px;z-index:201}</style><div id="root"></div><button id="audit-launcher">Audit</button><div id="audit"></div></html>');
    const win=new BrowserWindow({show:false,width:1120,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
    const errors=[],checks=[],axeAudits=[];win.webContents.on('console-message',event=>{if(event.level==='error'){errors.push(event.message);console.error('Renderer:',event.message)}});
    const run=code=>win.webContents.executeJavaScript(code),pause=()=>new Promise(resolve=>setTimeout(resolve,60));
    const check=async(label,code)=>{for(let i=0;i<60;i++){if(await run(code)){checks.push(label);console.log('PASS '+label);return}await pause()}
      console.error(await run('({text:document.querySelector("#audit").innerText.slice(-850),focus:document.activeElement?.outerHTML.slice(0,250),forced:matchMedia("(forced-colors:active)").matches,outline:getComputedStyle(document.activeElement).outline,transition:getComputedStyle(document.activeElement).transitionDuration,border:getComputedStyle(document.activeElement).borderStyle})'));throw Error(label)};
    const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await pause()};
    const capture = async name => {
      const cssKey = await win.webContents.insertCSS(`
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
          caret-color: transparent !important;
        }
      `);
      try {
        await run('document.fonts.ready.then(() => true)');
        const [width, height] = win.getSize();
        const options = { stayHidden: true, stayAwake: true };
        win.setSize(width + 1, height);
        await win.webContents.capturePage(undefined, options);
        win.setSize(width, height);
        await pause();
        const screenshot = await win.webContents.capturePage(undefined, options);
        fs.writeFileSync(path.join(output, name), screenshot.toPNG());
      } finally {
        await win.webContents.removeInsertedCSS(cssKey);
      }
    };
    await win.loadFile(html);win.webContents.debugger.attach('1.3');
    await run(fs.readFileSync(require.resolve('axe-core/axe.min.js'),'utf8')+'\nvoid 0;');
    const auditAccessibility = async (label, selector) => {
      const audit = await run(`(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing axe-core audit target');
        const { passes, incomplete, violations } = await axe.run(element, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        });
        return {
          passes: passes.length,
          incomplete: incomplete.map(rule => rule.id),
          violations: violations.map(rule => ({ id: rule.id, nodes: rule.nodes.map(node => node.target) })),
        };
      })()`);
      axeAudits.push({ label, ...audit });
      assert(audit.passes > 0, `axe-core did not exercise any rules for ${label}`);
      if (audit.violations.length === 0) {
        checks.push(`axe-core: ${label}`);
        console.log(`PASS axe-core: ${label}`);
      }
    };
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await run('var fixtureRoot='+JSON.stringify(root)+',settingsFixture='+JSON.stringify(settings)+`,testFirstSteps=true,testSavedViews=true,testEventCenter=true,testAccessibility=true;
      localStorage.setItem('onboarded','1');var joinCalls=0;
      var fixtureApiOverrides={rooms:{list:async()=>[],getProfile:async()=>({name:'Me',memberId:'me',avatarSeed:'me'}),get:async()=>null,engineStatus:async()=>({state:'ready'}),setActiveRoom:async()=>{},
        join:async()=>{joinCalls++;throw Error('engine unavailable')},servers:{state:async()=>({available:false,modules:[],instances:[]}),onUpdate:()=>()=>{}},voice:{mute:async()=>{},deafen:async()=>{}}}};
      `+fs.readFileSync(path.join(__dirname,'fixtures/command-palette-ui.cjs'),'utf8')+`
      Object.assign(components,...['Modal','Identicon','Avatar','Tabs','CategorySelect'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      components.useConfirm=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).useConfirm;
      var Modal=components.Modal,Select=components.Select,Button=components.Button,Toggle=components.Toggle;
      var controls=load(path.join(fixtureRoot,'renderer/pages/settings/controls.tsx'));
      var auditTree=createRoot(document.querySelector('#audit')),auditCloseCount=0,submitted=null,conflictChoice=null;
      function closeAudit(){auditCloseCount++;auditTree.render(null)}
      function showAudit(Component,props={}){document.querySelector('#audit-launcher').focus();dom.flushSync(()=>auditTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Component,{...props,onClose:closeAudit}))));}
      function auditButton(key,scope=document.querySelector('.room-sync-modal')??document.querySelector('#audit')){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key))}
      function auditFocus(key){auditButton(key).focus()}
      function auditInput(selector,value){var node=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})))}
      function ControlsDialog({onClose}){var [value,setValue]=React.useState('a'),[toggle,setToggle]=React.useState(false),[n,setN]=React.useState(1),[inner,setInner]=React.useState(false);window.auditValue=value;
        return React.createElement(Modal,{title:React.createElement('span',null,'Keyboard dialog'),onClose,footer:React.createElement(Button,{id:'audit-last',onClick:onClose},'Close')},
          React.createElement('input',{hidden:true,'data-autofocus':true}),
          React.createElement(controls.SettingRow,{label:'Number label',description:'Number description',control:React.createElement(controls.NumberField,{value:n,onChange:setN})}),
          React.createElement(controls.SettingRow,{label:'Choice label',description:'Choice description',control:React.createElement(Select,{value,onChange:setValue,options:[{value:'a',label:'Alpha'},{value:'b',label:'Beta'},{value:'c',label:'Gamma'}]})}),
          React.createElement(controls.SettingRow,{label:'Switch label',control:React.createElement(Toggle,{checked:toggle,onChange:setToggle})}),
          React.createElement(Button,{id:'audit-nested',onClick:()=>setInner(true)},'Nested'),
          inner&&React.createElement(Modal,{title:'Nested',onClose:()=>setInner(false)},React.createElement(Button,null,'Inner action')))}
      void 0;`);
    await run(`commandsButton().focus();void 0`);await key('K',['control']);
    await check('Palette keyboard shortcut focuses the actual search input',`document.activeElement?.classList.contains('command-palette-input')`);
    await key('Down');await check('Palette exposes a valid active option',`!!document.getElementById(document.activeElement.getAttribute('aria-activedescendant'))`);
    await key('Escape');await check('Palette Escape restores the invoking button',`!document.querySelector('.command-palette')&&document.activeElement===commandsButton()`);
    await run(`showAudit(ControlsDialog);void 0`);
    await check('Modal skips hidden autofocus and names a rich heading',`document.activeElement?.type==='number'&&!!document.querySelector('[role=dialog][aria-labelledby]')`);
    const ax=await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    for(const [role,name] of [['spinbutton','Number label'],['combobox','Choice label'],['switch','Switch label']])assert(ax.nodes.some(node=>node.role?.value===role&&node.name?.value===name),role+' label in Chromium accessibility tree');checks.push('Actual accessibility tree names settings inputs, combobox and switch');
    await auditAccessibility('Dark settings controls', '#audit [role="dialog"]');
    if (process.env.HAVVN_A11Y_OUTPUT) await capture('controls-dark.png');
    await run(`document.querySelector('#audit [role=combobox]').focus();void 0`);await key('Down');await key('Down');
    await check('Select arrows expose a linked active option without committing',`auditValue==='a'&&document.getElementById(document.activeElement.getAttribute('aria-activedescendant'))?.textContent.includes('Beta')`);
    await key('Escape');await check('First Escape closes only the list and discards pending selection',`document.querySelectorAll('#audit [role=dialog]').length===1&&document.activeElement.getAttribute('aria-expanded')==='false'&&auditValue==='a'`);
    await key('Down');await key('End');await key('Enter');await check('End and Enter commit the last option and retain focus',`auditValue==='c'&&document.activeElement.getAttribute('role')==='combobox'&&document.activeElement.getAttribute('aria-expanded')==='false'`);
    await key('B');await key('Space');await check('Typeahead selects by text',`auditValue==='b'`);
    await key('Tab');await check('Tab advances from the combobox to the switch',`document.activeElement?.getAttribute('role')==='switch'`);
    await key('Space');await check('Space operates the named switch',`document.activeElement?.getAttribute('aria-checked')==='true'`);
    await run(`document.querySelector('#audit-nested').focus();void 0`);await key('Space');
    await check('Nested confirmation is open above its parent',`document.querySelectorAll('#audit [role=dialog]').length===2`);await key('Escape');
    await check('Nested Escape closes one dialog and restores the inner opener',`document.querySelectorAll('#audit [role=dialog]').length===1&&document.activeElement?.id==='audit-nested'`);
    await run(`document.querySelector('#audit-last').focus();void 0`);await key('Tab');
    await check('Tab wraps inside the modal',`document.activeElement?.classList.contains('um-x')`);await key('Tab',['shift']);
    await check('Shift Tab wraps back to the last control',`document.activeElement?.id==='audit-last'`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'},{name:'prefers-reduced-motion',value:'reduce'}]});
    await check('Forced colors keep a visible outline and borders; reduced motion is effective',`matchMedia('(forced-colors:active)').matches&&getComputedStyle(document.activeElement).outlineStyle==='solid'&&parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=2&&getComputedStyle(document.activeElement).borderStyle==='solid'&&parseFloat(getComputedStyle(document.activeElement).transitionDuration)<0.01`);
    await check('Forced colors preserve a visible switch thumb',`getComputedStyle(document.querySelector('#audit .toggle-slider')).backgroundColor!==getComputedStyle(document.querySelector('#audit .toggle-switch')).backgroundColor`);
    await capture('forced-colors.png');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});await key('Escape');
    await check('Closing the modal restores its opener',`!document.querySelector('#audit [role=dialog]')&&document.activeElement?.id==='audit-launcher'`);
    await run(`window.api.getTorrentInfo=async()=>({name:'Fixture',totalSize:20,files:[{index:0,path:'one.txt',size:10},{index:1,path:'two.txt',size:10}]});var Files=load(path.join(fixtureRoot,'renderer/components/TorrentFileSelector.tsx')).TorrentFileSelector;showAudit(Files,{torrentPath:'fixture.torrent',onCancel:closeAudit,onConfirm:async ids=>{submitted=ids;closeAudit()}});void 0`);
    await check('Actual download confirmation exposes named file checkboxes',`document.querySelectorAll('#audit .file-item input[type=checkbox]').length===2`);
    await run(`document.querySelector('#audit .file-item input').focus();void 0`);await key('Space');
    await run(`document.querySelector('#audit .um-foot .btn-primary').focus();void 0`);await key('Space');
    await check('Keyboard file selection reaches the real download confirmation handler',`Array.isArray(submitted)&&submitted.length===1&&submitted[0]===1`);
    await run(`var Rooms=load(path.join(fixtureRoot,'renderer/pages/RoomsPage.tsx')).default;showAudit(Rooms,{taskRequest:{kind:'room-task',requestId:1,action:'join'}});void 0`);
    await check('Room join opens with focus on the labelled invite field',`document.activeElement?.classList.contains('rooms-input-code')&&!!document.activeElement.getAttribute('aria-label')`);
    await run(`auditInput('.rooms-input-code','invalid');void 0`);await key('Enter');
    await check('Invalid invite is reported inline without joining',`joinCalls===0&&document.querySelector('.rooms-input-code').getAttribute('aria-invalid')==='true'&&!!document.querySelector('#audit [role=alert]')`);
    await key('Escape');await check('Join Escape closes only the confirmation',`!document.querySelector('#audit [role=dialog]')`);
    await run(`closeAudit();var Sync=load(path.join(fixtureRoot,'renderer/pages/rooms/RoomSyncModal.tsx')).RoomSyncModal;
      window.api.rooms.fileSync={state:async()=>({enabled:true,canCreate:false,roots:[{rootId:'root',name:'Fixture',paused:false,publisher:false,path:'fixture',autoApply:false,autoPublish:false,files:1,pending:1,conflicts:1}]}),files:async()=>({items:[{entryId:'entry',path:'sample.txt',size:10,status:'conflict',revisionId:'rev',resolvable:true}],next:null}),
        conflict:async()=>({previewId:'preview',rootId:'root',entryId:'entry',path:'sample.txt',revisionId:'rev',createdAt:1,local:{exists:true,size:10,modifiedAt:1},incomingSize:10,copyPath:'copy.txt',diff:{kind:'text',lines:[{kind:'removed',local:1,text:'old'},{kind:'added',incoming:1,text:'new'}]}}),resolveConflict:async(_room,_preview,choice)=>{conflictChoice=choice;return{copyPath:'copy.txt'}}};
      showAudit(Sync,{roomId:'r1',initialRootId:'root'});void 0`);
    await check('Actual sync conflict review is available',`!!auditButton('rooms.sync.conflictReview')`);await run(`auditFocus('rooms.sync.conflictReview');void 0`);await key('Space');
    await check('Conflict diff has text labels and is not a continuously live file list',`!!document.querySelector('.room-sync-diff')&&document.querySelector('.room-sync-diff').textContent.includes(t('a11y.diff.added'))&&!document.querySelector('.room-sync-files[aria-live]')`);
    await auditAccessibility('Room file conflict', '.room-sync-modal');
    if (process.env.HAVVN_A11Y_OUTPUT) await capture('room-file-conflict.png');
    await run(`auditFocus('rooms.sync.conflictKeep');void 0`);await key('Space');await check('Keyboard keep-both uses the existing conflict resolver',`conflictChoice==='keep-both'`);await key('Escape');
    await run(`var Events=load(path.join(fixtureRoot,'renderer/components/EventCenter.tsx')).default;showAudit(Events,{onNavigate:()=>{}});void 0`);
    await check('Actual event center is loaded',`!!auditButton('events.readAll')&&!auditButton('events.readAll').disabled`);await run(`auditFocus('events.readAll');void 0`);await key('Space');
    await check('Keyboard can mark events read through the existing API',`auditButton('events.readAll').disabled`);
    await run(`closeAudit();var library=load(path.join(fixtureRoot,'renderer/utils/theme-library.ts'));var theme={id:'audit-theme',name:'Audit theme',dark:{'--color-text-primary':'#111111','--color-bg-primary':'#111111','--color-bg-secondary':'#111111','--color-bg-tertiary':'#111111','--color-bg-elevated':'#111111'},light:{}};library.saveLibrary([theme]);library.activateTheme(theme);var originalLibrary=JSON.stringify(library.loadLibrary());var Editor=load(path.join(fixtureRoot,'renderer/components/ThemeEditor.tsx')).ThemeEditor;showAudit(Editor,{initialTab:'edit'});void 0`);
    await check('Actual theme editor warns about unreadable colors and focuses its active tab',`!!auditButton('a11y.contrast.preview')&&document.activeElement?.getAttribute('role')==='tab'`);
    await key('Right');await check('Theme tabs support arrow navigation and panel association',`document.activeElement?.textContent.trim()===t('settings.theme.tab.preview')&&!!document.getElementById(document.activeElement.getAttribute('aria-controls'))`);await key('Home');
    await run(`auditFocus('a11y.contrast.preview');void 0`);await key('Space');await check('Readable-color preview retains focus and leaves the live draft and saved library unchanged',`!!document.querySelector('.te-readability-comparison')&&document.activeElement.textContent===t('a11y.contrast.preview')&&getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim()==='#111111'&&JSON.stringify(library.loadLibrary())===originalLibrary`);
    await capture('contrast-before.png');
    await run(`auditButton('common.cancel',document.querySelector('.te-readability')).focus();void 0`);await key('Space');
    await check('Cancelling the repair preview restores its trigger without changing colors',`!document.querySelector('.te-readability-comparison')&&document.activeElement.textContent===t('a11y.contrast.preview')&&getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim()==='#111111'`);
    await key('Space');await run(`auditFocus('a11y.contrast.apply');void 0`);await key('Space');
    await check('Applying suggested colors changes only the draft and focuses Undo',`getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim()!=='#111111'&&JSON.stringify(library.loadLibrary())===originalLibrary&&document.activeElement.getAttribute('aria-label')===t('settings.theme.undo')`);
    await run(`document.querySelector('#audit [aria-label="'+t('settings.theme.undo')+'"]').focus();void 0`);await key('Space');await check('Undo restores the original draft color',`getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim()==='#111111'`);
    await run(`auditFocus('a11y.contrast.preview');void 0`);await key('Space');win.setSize(560,760);win.webContents.setZoomFactor(1.25);await pause();await run(`auditFocus('a11y.contrast.apply');void 0`);
    await check('Narrow enlarged theme recovery controls fit and remain readable',`document.querySelector('.ted').scrollWidth<=document.querySelector('.ted').clientWidth+1&&[...document.querySelectorAll('.te-readability button')].every(node=>node.scrollWidth<=node.clientWidth+1)`);
    await capture('contrast-narrow.png');await run(`document.querySelector('#audit .ted [aria-label="'+t('common.close')+'"]').focus();void 0`);await key('Escape');
    await check('Theme Escape restores saved colors and the opener',`!document.querySelector('.ted')&&JSON.stringify(library.loadLibrary())===originalLibrary&&document.activeElement?.id==='audit-launcher'`);
    win.webContents.setZoomFactor(1);await run(`library.deactivateTheme();document.documentElement.dataset.theme='light';showAudit(ControlsDialog);void 0`);await key('Tab');await capture('controls-light-narrow.png');
    await auditAccessibility('Narrow light settings controls', '#audit [role="dialog"]');
    await key('Escape');
    assert.deepEqual(errors,[]);await run('auditTree.unmount();tree.unmount();void 0');win.webContents.debugger.detach();win.destroy();
    const axeViolations = axeAudits.filter(audit => audit.violations.length > 0);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:axeViolations.length===0,checks,axeAudits,manualScreenReaderRun:false},null,2));
    assert.deepEqual(axeViolations, [], JSON.stringify(axeViolations));
    console.log(JSON.stringify({passed:true,checks:checks.length,output}));clearTimeout(deadline);app.quit();
  }).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
}
