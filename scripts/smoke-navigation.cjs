// Actual App/Sidebar/settings controls with isolated local data; no engine or network.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-navigation-'));
  const env = { ...process.env, HAVVN_NAVIGATION_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-navigation-')) throw Error('Unexpected navigation fixture');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = path.resolve(process.env.HAVVN_NAVIGATION_SCRATCH || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-navigation-')) throw Error('Missing isolated navigation profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 90000), output = path.join(root, 'dist/navigation-ui');
  fs.mkdirSync(output, { recursive: true });
  app.whenReady().then(async () => {
    const settings = require('../dist/electron/electron/db/store.js').readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/styles/appearance.css',
      'renderer/pages/DownloadsPage.css', 'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css',
      'renderer/components/CommandPalette.css', 'renderer/pages/DownloadViewsBar.css', 'renderer/layout/SidebarFavorites.css',
      'renderer/pages/settings/controls.css', 'renderer/pages/settings/sections/NavigationPanel.css', 'renderer/pages/RoomsPage.css',
      'renderer/pages/rooms/RoomServerPanel.css', 'renderer/components/DownloadDefaultsPreview.css', 'renderer/pages/settings/sections/NotificationPolicyPanel.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(scratch, 'ui.html');
    fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = [], checks = [];
    win.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error('Renderer:', message.message); } });
    const run = code => win.webContents.executeJavaScript(code), pause = () => new Promise(resolve => setTimeout(resolve, 85));
    const check = async (label, code) => {
      for (let i = 0; i < 45; i++) { if (await run(code)) { checks.push(label); console.log('PASS ' + label); return; } await pause(); }
      console.error(await run('({text:document.body.innerText,markers:[...document.querySelectorAll("#layout-checkboxes input")].map(node=>{var s=getComputedStyle(node),p=getComputedStyle(node,"::after");return {display:s.display,place:s.placeContent,transform:p.transform,border:p.borderTopWidth,width:p.width,height:p.height}})})')); throw Error(label);
    };
    const capture = async name => {
      const [width, height] = win.getSize(); win.setSize(width + 1, height);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); win.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 200));
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    const bootstrap = async seed => {
      await win.loadFile(html);
      await run('var fixtureRoot=' + JSON.stringify(root) + ',settingsFixture=' + JSON.stringify(settings) + ',testSavedViews=true;\n' +
        (seed ? `localStorage.setItem('havvn.navigation.v1',JSON.stringify({version:1,utilities:[{id:'rss',visible:true},{id:'search',visible:false}],showHistory:false,favorites:[{kind:'room',id:'r1'},{kind:'view',id:'v1'},{kind:'command',id:'pause-all'},{kind:'command',id:'future-command'}]}));
        localStorage.setItem('havvn.download-views.v1',JSON.stringify({version:1,views:[{id:'v1',name:'Фильмы',pinned:true,conditions:{status:'all',name:'',path:''},sort:{by:'added',direction:'desc'},mode:'compact'}],activeId:null}));` : '') +
        fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8') + `
        var navigation=load(path.join(fixtureRoot,'renderer/utils/navigation.ts')).navigation;
        var views=load(path.join(fixtureRoot,'renderer/utils/download-views.ts')).downloadViews;
        var model=load(path.join(fixtureRoot,'renderer/state/downloads.ts')).downloadsModel;
        var navCommands=load(path.join(fixtureRoot,'renderer/commands/navigationCommands.ts')).createNavigationCommands;
        var pauseCalls=0,finishPause;window.api.pauseAll=()=>{pauseCalls++;return new Promise(resolve=>finishPause=resolve)};
        fixtureRows[0]={...fixtureRows[0],status:'downloading'};model.updateDownloads(()=>fixtureRows);
        function button(key){return [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
        function favorite(key){return document.querySelector('[data-favorite-key="'+key+'"]')}
        function openSelect(key){document.querySelector('[aria-haspopup=listbox][aria-label="'+t(key)+'"]').click()}
        function option(text){var node=[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===text);if(!node)throw Error('Missing option '+text);node.click()}
        function utilityIds(){return [...document.querySelectorAll('.sidebar-footer button')].map(node=>node.title)}
        void 0;`);
      await check('App loads the persisted menu and keeps one engine subscription', '!!document.querySelector(".sidebar")&&statsSubscriptions===1');
    };
    await bootstrap(true);
    await check('Hidden utilities disappear, required entries remain, and favorites do not execute on load', `!document.querySelector('.sidebar-footer [title="'+t('nav.search')+'"]')&&!!document.querySelector('.sidebar-footer [title="'+t('nav.settings')+'"]')&&pauseCalls===0&&document.querySelectorAll('.pillar-btn').length===2`);
    await check('Missing command is disabled and globally favorited pinned view has one sidebar link', `favorite('command:future-command').disabled&&document.querySelectorAll('.sidebar .download-view-name').length===0&&favorite('view:v1').textContent.includes('Фильмы')`);
    await run(`favorite('room:r1').click();void 0`);
    await check('Room favorite opens an existing local room and remains in both pillars', `document.querySelector('#test-room')?.textContent==='r1'&&!!favorite('view:v1')`);
    await run(`document.querySelectorAll('.pillar-btn')[0].click();roomsLive=[];void 0`);
    await run(`favorite('room:r1').click();void 0`);
    await check('A stale room reference is rechecked against membership and fails without navigating', `!document.querySelector('#test-room')&&document.querySelector('.sidebar-favorite-error')?.textContent===t('commands.missing')`);
    await run(`favorite('view:v1').click();void 0`);
    await check('Saved view favorite selects the same persisted view', `views.getSnapshot().catalog.activeId==='v1'`);
    await run(`views.remove('v1');void 0`);
    await check('Deleting a favorited view disables only its link', `favorite('view:v1').disabled&&!favorite('command:pause-all').disabled`);
    await run(`favorite('command:pause-all').click();favorite('command:pause-all').click();void 0`);
    await check('Repeated action clicks dispatch once while pending', `pauseCalls===1&&document.querySelector('.sidebar-favorites').getAttribute('aria-busy')==='true'`);
    await run(`finishPause();void 0`);
    await check('An action becomes available again when its promise completes', `!favorite('command:pause-all').disabled`);
    await run(`document.querySelector('[aria-label="'+t('commands.title')+'"]').click();void 0`);
    await check('The command palette loads on demand', `!!document.querySelector('[role=combobox]')`);
    await run(`dom.flushSync(()=>setQuery(t('nav.search')));void 0`);
    await check('Hidden pages remain available in the command palette', `!!document.querySelector('[data-command-id="open-search"]')`);
    await run(`document.querySelector('[data-command-id="open-search"]').click();void 0`);
    await check('A hidden page can be opened without stopping downloads', `document.body.textContent.includes('./pages/SearchPage')&&pauseCalls===1&&model.store.getState().downloads[0].status==='downloading'`);
    await capture('sidebar.png');
    await run(`document.querySelector('.sidebar-footer [title="'+t('nav.settings')+'"]').click();void 0`);
    await check('Settings open in the actual app shell', `!!document.querySelector('.stg-nav')`);
    await run(`button('settings.connection').click();void 0`);
    await run(`var speed=[...document.querySelectorAll('.stg-row')].find(row=>row.dataset.settingLabel===t('settings.downSpeed')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(speed,'777');speed.dispatchEvent(new Event('input',{bubbles:true}));void 0`);
    await check('A page-level settings draft is present', `!!document.querySelector('.stg-save')`);
    await run(`document.querySelectorAll('.pillar-btn')[0].click();void 0`);
    await check('Leaving settings asks before discarding a draft', `!!document.querySelector('[role=dialog]')&&!!document.querySelector('.stg-nav')`);
    await run(`button('settings.stayEditing').click();void 0`);
    await check('Cancel navigation keeps the typed value and settings open', `!!document.querySelector('.stg-nav')&&[...document.querySelectorAll('.stg-row')].find(row=>row.dataset.settingLabel===t('settings.downSpeed')).querySelector('input').value==='777'&&!document.querySelector('[role=dialog]')`);
    await run(`document.querySelectorAll('.pillar-btn')[0].click();void 0`);
    await check('The leave decision can be repeated', `!!button('settings.discardAndLeave')`);
    await run(`button('settings.discardAndLeave').click();void 0`);
    await check('Explicit discard completes the requested navigation', `!document.querySelector('.stg-nav')&&!!document.querySelector('.download-item')`);
    // New renderer instance, same profile, without reseeding preferences.
    await bootstrap(false);
    await check('Reload preserves utility order, hidden history and all favorite references', `navigation.getSnapshot().preferences.utilities[0].id==='rss'&&!navigation.getSnapshot().preferences.showHistory&&navigation.getSnapshot().preferences.favorites.length===4`);
    await run(`
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/sections/NavigationPanel.tsx')).NavigationPanel;
      var Card=load(path.join(fixtureRoot,'renderer/pages/settings/controls.tsx')).SettingsCard;
      var getCommands=()=>navCommands({t,api:window.api,getDownloads:()=>fixtureRows,getRooms:()=>roomsLive,getViews:()=>views.getSnapshot().catalog.views,getVoice:()=>null,navigate:target=>calls.push(['navigate',target])});
      function Screen(){React.useContext(fixtureTranslationContext);return React.createElement(Card,{title:t('navigation.title'),icon:'sliders',description:t('navigation.description')},React.createElement(Panel,{getCommands}))}
      dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Screen))));
      document.querySelector('#root').style.cssText='height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;max-width:960px;margin:16px auto;padding:0 16px';
      void 0;`);
    await check('Actual navigation settings render themed reorder, visibility and favorite controls', `document.querySelectorAll('[data-navigation-item]').length===5&&document.querySelectorAll('[data-navigation-favorite]').length===4`);
    await run(`var row=document.querySelector('[data-navigation-item="rss"]');row.focus();row.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}));void 0`);
    await check('Alt+Down moves a utility and retains keyboard focus', `navigation.getSnapshot().preferences.utilities[1].id==='rss'&&document.activeElement.dataset.navigationItem==='rss'`);
    await run(`document.querySelector('[role=switch][aria-label="'+t('navigation.show')+': '+t('nav.search')+'"]').click();void 0`);
    await check('Visibility controls save immediately', `navigation.getSnapshot().preferences.utilities.find(item=>item.id==='search').visible`);
    await run(`openSelect('navigation.chooseFavorite')`); await run(`option(t('navigation.kind.command')+' · '+t('nav.search'))`);
    await run(`button('navigation.add').click();void 0`);
    await check('Adding a favorite stores a reference without invoking it', `navigation.getSnapshot().preferences.favorites.some(item=>item.id==='open-search')&&!calls.some(item=>item[0]==='navigate')&&pauseCalls===0`);
    await run(`var fav=document.querySelector('[data-navigation-favorite="command:open-search"]');fav.focus();fav.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}));void 0`);
    await check('Keyboard favorite reorder saves and retains focus', `navigation.getSnapshot().preferences.favorites[3].id==='open-search'&&document.activeElement.dataset.navigationFavorite==='command:open-search'`);
    await run(`document.querySelector('#root').scrollTop=0;void 0`);
    await capture('wide.png'); win.setSize(520, 1100);
    await check('Settings fit a narrow window without horizontal overflow', `document.documentElement.scrollWidth<=innerWidth+1&&document.getElementById('root').scrollWidth<=document.getElementById('root').clientWidth+1`);
    await capture('narrow.png'); await run(`var scrollRoot=document.querySelector('#root');scrollRoot.scrollTop=scrollRoot.scrollHeight;void 0`);
    await check('All favorites and removal buttons remain reachable on a narrow window', `document.querySelector('#root').scrollTop>0&&[...document.querySelectorAll('[data-navigation-favorite]')].at(-1).getBoundingClientRect().bottom<=innerHeight`);
    await capture('narrow-favorites.png');
    await run(`button('navigation.resetMenu').click();void 0`);
    await check('Reset restores the default menu and preserves favorites', `navigation.getSnapshot().preferences.utilities[0].id==='events'&&navigation.getSnapshot().preferences.showHistory&&navigation.getSnapshot().preferences.favorites.length===5`);
    await run(`document.querySelector('[data-navigation-favorite="command:future-command"] button[aria-label^="'+t('navigation.remove')+'"]').click();void 0`);
    await check('Unavailable favorites can be removed without affecting neighbors', `navigation.getSnapshot().preferences.favorites.length===4&&!navigation.getSnapshot().preferences.favorites.some(item=>item.id==='future-command')`);
    await run(`
      var portable=load(path.join(fixtureRoot,'shared/interface-preferences.ts'));
      var snapshot=portable.captureInterfacePreferences(localStorage);
      var incoming=structuredClone(snapshot);incoming.values['havvn.navigation.v1']=JSON.stringify({...navigation.getSnapshot().preferences,showHistory:false});
      portable.writeInterfacePreferences(localStorage,portable.selectInterfacePreferences(snapshot,incoming,['layout']));
      window.dispatchEvent(new Event('havvn:settings-transfer'));void 0;`);
    await check('Import invalidation updates the mounted navigation editor', `!navigation.getSnapshot().preferences.showHistory&&document.querySelector('[role=switch][aria-label="'+t('navigation.show')+': '+t('history.title')+'"]').getAttribute('aria-checked')==='false'`);
    await run(`var next={...navigation.getSnapshot().preferences,showHistory:true};localStorage.setItem('havvn.navigation.v1',JSON.stringify(next));window.dispatchEvent(new StorageEvent('storage',{key:'havvn.navigation.v1'}));void 0`);
    await check('Other-window storage invalidation updates the current editor', `navigation.getSnapshot().preferences.showHistory`);
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');void 0`);
    await check('English settings labels are translated', `document.body.textContent.includes('Navigation and favorites')&&!document.body.textContent.includes('navigation.error.')`);
    win.setSize(1060, 1100);
    await run(`
      dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/ru.json'),'utf8'));
      var htmlRoot=document.documentElement;htmlRoot.dataset.radiusOverrides='panels cards buttons inputs';
      for(var [key,value] of Object.entries({'--ap-radius-cards':'18px','--ap-radius-buttons':'24px','--ap-radius-inputs':'16px','--color-accent-primary':'#a4d8ff','--color-accent-primary-hover':'#bce3ff','--color-bg-primary':'#1a2d43','--color-bg-secondary':'#2b3f52','--color-bg-tertiary':'#20364d','--color-text-primary':'#eef7ff','--color-border-default':'#466780'}))htmlRoot.style.setProperty(key,value);
      var Chrome=load(path.join(fixtureRoot,'renderer/layout/TitleBar.tsx')).TitleBar;
      var chromeNode=document.createElement('div');document.body.prepend(chromeNode);var chromeTree=createRoot(chromeNode);
      dom.flushSync(()=>chromeTree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Chrome,{onOpenCommands:()=>calls.push(['chrome-command']),onOpenEvents:()=>calls.push(['chrome-events']),activeProblems:2}))));
      document.querySelector('#root').style.height='calc(100vh - 66px)';
      function LayoutScreen(){return React.createElement(React.Fragment,null,
        React.createElement(Card,{title:t('navigation.title')},React.createElement(Panel,{getCommands})),
        React.createElement(Card,{title:t('notifications.rulesTitle')},React.createElement('fieldset',{style:{border:0,padding:0,margin:0,minWidth:0}},React.createElement('div',{className:'stg-row'},t('notifications.rule.popups')),React.createElement('div',{className:'category-defaults-actions',id:'layout-actions'},React.createElement(components.Button,{variant:'primary'},t('common.save')),React.createElement(components.Button,{variant:'secondary'},t('category.defaults.reset'))))),
        React.createElement(Card,{title:t('nav.rooms')},React.createElement('div',{className:'room-server-empty'},React.createElement(components.Button,{size:'sm',className:'room-server-primary',id:'layout-server'},React.createElement(components.Icon,{name:'plus',size:14}),t('rooms.server.create'))),
          React.createElement('div',{className:'room-chat-section'},React.createElement('div',{className:'room-chat room-zone-history'},React.createElement('div',{className:'room-files-empty'},t('rooms.historyEmpty'))))),
        React.createElement(Card,{title:t('settings.transfer.sections')},React.createElement('div',{id:'layout-checkboxes',style:{display:'flex',gap:20}},...[14,16,20].map(size=>React.createElement('label',{key:size,style:{display:'inline-flex',gap:8,alignItems:'center'}},React.createElement('input',{type:'checkbox',defaultChecked:true,style:{width:size,height:size},'aria-label':'Selection '+size}),'Выбрано')))))}
      dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(LayoutScreen))));
      function labelsFit(){return [...document.querySelectorAll('.btn-label')].every(label=>{var a=label.getBoundingClientRect(),b=label.closest('button').getBoundingClientRect();return label.scrollWidth<=label.clientWidth+1&&a.left>=b.left+3&&a.right<=b.right-3&&a.top>=b.top&&a.bottom<=b.bottom})}
      document.querySelector('#root').scrollTop=0;void 0;`);
    await check('Rounded theme keeps long button labels inside their buttons', 'labelsFit()');
    await check('Title-bar actions use centered icons without text pills', `document.querySelector('.titlebar-actions').textContent.trim()===''&&document.querySelectorAll('.titlebar-actions button svg').length===2&&!!document.querySelector('.titlebar-event-dot')`);
    await check('Legacy inline-icon server button keeps its icon and label on one line', `(()=>{var b=document.querySelector('#layout-server'),icon=b.querySelector('svg').getBoundingClientRect(),label=b.querySelector('.btn-label').getBoundingClientRect();return Math.abs((icon.top+icon.bottom-label.top-label.bottom)/2)<1&&b.scrollHeight<=b.clientHeight+1})()`);
    await check('Actions clear the divider and bottom edge without changing button spacing or card padding', `(()=>{var row=document.querySelector('#layout-actions'),buttons=[...row.querySelectorAll('button')],a=buttons[0].getBoundingClientRect(),b=buttons[1].getBoundingClientRect(),line=row.previousElementSibling.getBoundingClientRect(),body=getComputedStyle(row.closest('.stg-card-b')),card=row.closest('.stg-card').getBoundingClientRect();return a.top-line.bottom>=16&&card.bottom-Math.max(a.bottom,b.bottom)>=16&&Math.abs(b.left-a.right-8)<1&&body.paddingTop==='2px'&&body.paddingBottom==='2px'})()`);
    await check('Checkbox markers stay centered at different control sizes without ticks', `(()=>{return [...document.querySelectorAll('#layout-checkboxes input')].every(node=>{var s=getComputedStyle(node),mark=getComputedStyle(node,'::after');return s.display.endsWith('grid')&&s.placeContent==='center'&&mark.transform==='none'&&mark.borderTopWidth==='0px'&&mark.width==='6px'&&mark.height==='6px'})})()`);
    await check('Empty activity has a padded, centered surface', `(()=>{var node=document.querySelector('.room-zone-history .room-files-empty'),s=getComputedStyle(node);return parseFloat(s.paddingTop)>=24&&parseFloat(s.paddingLeft)>=16&&node.getBoundingClientRect().height>=96&&s.display==='grid'})()`);
    await capture('rounded-theme.png');
    await run(`document.querySelector('#root').scrollTop=document.querySelector('#root').scrollHeight;void 0`); await capture('rounded-controls.png');
    win.setSize(520, 1100);
    await check('Rounded theme fits narrow controls without clipping button text', `labelsFit()&&document.querySelector('#root').scrollWidth<=document.querySelector('#root').clientWidth+1`);
    await capture('rounded-narrow.png'); await run('chromeTree.unmount();void 0');
    assert.deepEqual(errors, []); await run('tree.unmount();void 0'); win.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
