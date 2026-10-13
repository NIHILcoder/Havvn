// Actual renderer components, isolated profile and fixture IPC; no user data.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-ui-polish-'));
  app.setPath('userData', path.join(out, 'profile')); app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Themed controls deadline:', out); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 660, height: 760, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', d => { if (d.level === 'error') { errors.push(d.message); console.error('Renderer:', d.message); } });
    const sheets = ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/components/Select.css', 'renderer/components/NumberInput.css', 'renderer/components/Modal.css', 'renderer/components/Toggle.css',
      'renderer/components/PlayerPreferencesPanel.css', 'renderer/components/EpisodePrefetchControl.css',
      'renderer/components/ProviderConnectionSettings.css', 'renderer/components/SearchQueryInput.css',
      'renderer/components/CreateTorrentModal.css','renderer/components/ExternalPlayer.css','renderer/components/TorrentSearchModal.css','renderer/components/TorrentFileSelector.css','renderer/components/FileTreeSelector.css','renderer/components/SelectionCheckbox.css','renderer/pages/settings/shell.css','renderer/pages/settings/controls.css','renderer/pages/settings/SettingsNav.css','renderer/styles/layout.css','renderer/styles/appearance.css'];
    const css = require('./smoke-ui-fonts.cjs')(root) + sheets.map(p => fs.readFileSync(path.join(root, p), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(out, 'controls.html');
    fs.writeFileSync(html, `<html class="dark" data-theme="dark" lang="ru"><style>${css}
      #root{height:100%;overflow:auto}#root.panels{padding:16px}*{animation:none!important;transition:none!important}
      </style><style id="page-style"></style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (e) { console.error('UI step:', code.slice(0, 280)); throw e; } }, pause = ms => new Promise(r => setTimeout(r, ms));
    await run(`
      var root=${JSON.stringify(root)}, fs=require('node:fs'), path=require('node:path'), ts=require(path.join(root,'node_modules/typescript'));
      var React=require(path.join(root,'node_modules/react')), dom=require(path.join(root,'node_modules/react-dom')), createRoot=require(path.join(root,'node_modules/react-dom/client')).createRoot;
      var dict=JSON.parse(fs.readFileSync(path.join(root,'renderer/i18n/ru.json'),'utf8')), t=k=>dict[k]||k, cache={}, calls=[];
      var network={profiles:[{id:'office',name:'Основной прокси для поиска и подключения к провайдерам'}],access:{}}, busySave=false, finishSave;
      window.api={search:{getNetworkSettings:async()=>structuredClone(network),setNetworkAccess:async(id,access)=>{calls.push({kind:'access',id,access});if(busySave)await new Promise(r=>finishSave=r);network.access[id]=access;},saveNetworkProfile:async input=>{calls.push({kind:'proxy',...input});if(busySave)await new Promise(r=>finishSave=r);var p={id:'saved',...input};network.profiles.push(p);return p;},testProvider:async()=>({success:true}),getProviders:async()=>[],getDownloadHistory:async()=>[],start:async()=>({searchId:'fixture-search',providers:['Демо']}),onProgress:handler=>{window.searchProgress=handler;return()=>{};},checkPython:async()=>({found:false}),addProvider:async data=>calls.push({kind:'provider',...data})},
        getEpisodePrefetchSupport:async()=>({supported:true}),stopEpisodePrefetch:async()=>{},getDefaultTrackers:async()=>[],onCreateTorrentProgress:()=>()=>{},getCategories:async()=>[],rss:{getFeeds:async()=>[],getItems:async()=>[],getRules:async()=>[],previewRule:async()=>[],addRule:async data=>calls.push({kind:'rule',...data}),addFeed:async data=>calls.push({kind:'feed',...data})}};
      var downloads={downloads:[],byId:{}};
      function load(p){if(cache[p])return cache[p].exports;var m={exports:{}};cache[p]=m;
        var source=fs.readFileSync(p,'utf8');if(p===path.join(root,'renderer/pages/SettingsPage.tsx')){var ast=ts.createSourceFile(p,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);source=ast.statements.filter(n=>ts.isImportDeclaration(n)||ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['SECTIONS','SettingsShell'].includes(d.name.getText(ast)))).map(n=>n.getText(ast)).join(String.fromCharCode(10));source+=';module.exports.__Shell=SettingsShell;';}var js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.endsWith('/SettingsContext'))return {useSettings:()=>settingsCtx};if(s.endsWith('state/downloads'))return {useDownloads:fn=>fn(downloads),downloadsModel:{retain:()=>()=>{},refresh:async()=>{},updateDownloads:()=>{}}};
          if(s.endsWith('/components')||s==='./index'){var all={useConfirm:()=>({confirm:async()=>true,alert:async()=>{}})};for(var n of ['Button','Icon','Avatar','Select','Toggle','Alert','Logo','Input','ProgressBar','EmptyState','CategorySelect','DropdownMenu','TorrentFileSelector','FileTreeSelector','QRCode','TrackerTemplates','MetadataPreview','BatchCreate'])Object.assign(all,load(path.join(root,'renderer/components/'+n+'.tsx')));Object.assign(all,load(path.join(root,'renderer/components/Toast.tsx')));return all;}
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
      window.api.externalPlayer={getConfig:async()=>({kind:'default',available:true}),sessions:async()=>[],choose:async()=>({ok:true,config:{kind:'vlc',available:true}}),useDefault:async()=>({kind:'default',available:true})};window.api.getTorrentInfo=async()=>({name:'Сборка',totalSize:300000000,files:[{index:0,path:'Сборка/Карта.zip',size:100000000},{index:1,path:'Сборка/Моды.zip',size:100000000},{index:2,path:'Сборка/Инструкция.txt',size:100000000}]});
      var settingsCtx,settingsMessage=null;var baseSettings={engine:'native',runningEngine:'native',engineRestartPending:false,maxDownKbps:2048,maxUpKbps:1024,adaptiveUpload:false,altSpeedEnabled:false,altDownKbps:512,altUpKbps:256,enableDHT:true,enableUtp:true,encryption:'preferred',maxConnections:100,maxConnectionsGlobal:500,portMin:6881,portForwarding:true,pfStatus:{state:'mapped'},proxyEnabled:false,proxyType:'socks5',proxyHost:'127.0.0.1',proxyPort:1080,proxyUsername:'',proxyPassword:'',transportRestartPending:false,autoLaunch:false,autoUpdate:true,minimizeToTray:true,closeToTray:true};
      var Shell=load(path.join(root,'renderer/pages/SettingsPage.tsx')).__Shell;
      function SettingsFixture(){var [category,setCategory]=React.useState('general');settingsCtx=new Proxy({...baseSettings,loading:false,activeCategory:category,setActiveCategory:setCategory,message:settingsMessage,hasChanges:false,saving:false},{get:(object,key)=>key in object?object[key]:typeof key==='string'&&(key.startsWith('set')||key.startsWith('handle')||key.startsWith('apply')||key==='selectEngine')?()=>{}:undefined});return React.createElement(Shell);}
      var TorrentSearch=load(path.join(root,'renderer/components/TorrentSearchModal.tsx')).TorrentSearchModal,Files=load(path.join(root,'renderer/components/TorrentFileSelector.tsx')).TorrentFileSelector,Tree=load(path.join(root,'renderer/components/FileTreeSelector.tsx')).FileTreeSelector;
      function TreeFixture(){var [excluded,setExcluded]=React.useState(new Set());var children=['Карта.zip','Моды.zip','Инструкция.txt'].map(name=>({name,path:'Сборка/'+name,isDirectory:false,size:100000000}));return React.createElement(Tree,{files:[{name:'Сборка',path:'Сборка',isDirectory:true,size:300000000,children}],excludedPaths:excluded,onToggle:(target,dir)=>setExcluded(prev=>{var next=new Set(prev),paths=dir?['Сборка',...children.map(f=>f.path)]:[target],remove=next.has(target);for(var p of paths)remove?next.delete(p):next.add(p);return next;}),onToggleAll:included=>setExcluded(new Set(included?[]:['Сборка',...children.map(f=>f.path)]))});}
      var Button=load(path.join(root,'renderer/components/Button.tsx')).Button,Icon=load(path.join(root,'renderer/components/Icon.tsx')).Icon,Avatar=load(path.join(root,'renderer/components/Avatar.tsx')).Avatar;
      var roomsSource=fs.readFileSync(path.join(root,'renderer/pages/RoomsPage.tsx'),'utf8'),roomsAst=ts.createSourceFile('RoomsPage.tsx',roomsSource,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX),headerNode;function headerVisit(n){if(ts.isJsxElement(n)&&n.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.getText(roomsAst)==='className'&&a.initializer?.text==='rooms-header'))headerNode=n;ts.forEachChild(n,headerVisit);}headerVisit(roomsAst);var hm={exports:{}};new Function('module','exports',ts.transpileModule('const RoomHeader=()=>('+headerNode.getText(roomsAst)+');module.exports.RoomHeader=RoomHeader;',{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText)(hm,hm.exports);var RoomHeader=hm.exports.RoomHeader;
      var profile={name:'papoooooo',avatarSeed:'rings:peer'},localServers=[],openProfile=()=>{},setLocalServersOpen=()=>{},setDialog=()=>{},setCreateName=()=>{};
      var SearchPrefs=load(path.join(root,'renderer/components/SearchPreferencesPanel.tsx')).SearchPreferencesPanel;
      var PlayerPrefs=load(path.join(root,'renderer/components/PlayerPreferencesPanel.tsx')).PlayerPreferencesPanel;
      var Provider=load(path.join(root,'renderer/components/ProviderConnectionSettings.tsx')).ProviderConnectionSettings;
      var Prefetch=load(path.join(root,'renderer/components/EpisodePrefetchControl.tsx')).EpisodePrefetchControl;
      var Search=load(path.join(root,'renderer/pages/SearchPage.tsx')).default, Rss=load(path.join(root,'renderer/pages/RSSPage.tsx')).default;
      var Create=load(path.join(root,'renderer/pages/CreateTorrentPage.tsx')).CreateTorrentPage, CreateModal=load(path.join(root,'renderer/components/CreateTorrentModal.tsx')).CreateTorrentModal;
      var playerDefaults=load(path.join(root,'shared/player-preferences.ts')).normalizePlayerPreferences(null), searchDefaults=load(path.join(root,'shared/search-preferences.ts')).DEFAULT_SEARCH_PREFERENCES;
      window.prefValue=null;var mounted=null;
      function Panel({kind}){var [value,setValue]=React.useState(kind==='player'?playerDefaults:searchDefaults),[ranked,setRanked]=React.useState(false);prefValue=value;
        return kind==='player'?React.createElement(PlayerPrefs,{prefs:value,onChange:setValue,onResetFile:()=>calls.push({kind:'resetFile'})}):React.createElement(SearchPrefs,{value,ranked,onChange:setValue,onRankedChange:setRanked});}
      window.mount=kind=>{if(mounted)dom.flushSync(()=>mounted.unmount());var el=document.querySelector('#root');el.replaceChildren();el.className=['player','preferences','provider','prefetch'].includes(kind)?'panels':'';
        var page=kind==='rss'?'RSSPage':kind==='settings'?'SettingsPage':kind==='roomhead'?'RoomsPage':kind==='create'?'CreateTorrentPage':['search','preferences','provider'].includes(kind)?'SearchPage':null;
        document.querySelector('#page-style').textContent=page?fs.readFileSync(path.join(root,'renderer/pages/'+page+'.css'),'utf8'):'';
        mounted=createRoot(el);var props={};var component={player:Panel,preferences:Panel,provider:Provider,prefetch:Prefetch,search:Search,rss:Rss,create:Create,modal:CreateModal,settings:SettingsFixture,roomhead:RoomHeader,torrentSearch:TorrentSearch,files:Files,tree:TreeFixture}[kind];
        if(kind==='player'||kind==='preferences')props={kind:kind==='player'?'player':'search'};
        if(kind==='provider')props={provider:{id:'fixture',name:'Провайдер',type:'custom',url:'https://example.test'}};
        if(kind==='prefetch')props={media:null,downloadId:'fixture',currentFile:0,nextFile:1,nextName:'Следующая серия'};
        if(kind==='torrentSearch')props={onClose:()=>{},onAdd:async()=>{}};if(kind==='files')props={torrentPath:'fixture.torrent',onConfirm:ids=>calls.push({kind:'confirmFiles',ids}),onCancel:()=>{}};
        if(kind==='modal')props={isOpen:true,onClose:()=>{}};
        dom.flushSync(()=>mounted.render(React.createElement(component,props)));};
      window.clickText=key=>{var label=t(key),b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!b)throw Error('Missing button '+key);dom.flushSync(()=>b.click());};
      window.inputValue=(node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));};
      window.trigger=key=>document.querySelector('button[aria-label="'+t(key)+'"]');
      window.openSelect=key=>dom.flushSync(()=>trigger(key).click());
      window.choose=(key,label)=>{openSelect(key);var option=[...trigger(key).parentElement.querySelectorAll('[role=option]')].find(b=>b.textContent.trim()===t(label));if(!option)throw Error('Missing option '+label);dom.flushSync(()=>option.click());};
      void 0;
    `);
    const mount = async kind => { await run(`mount(${JSON.stringify(kind)})`); await pause(220); };
    const capture = async name => { win.webContents.invalidate(); await pause(200); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const fits = async name => assert.equal(await run('document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll(".custom-select-trigger,.number-input")].every(e=>e.getBoundingClientRect().right<=innerWidth+1)'), true, name + ' horizontal fit');
    await mount('preferences'); await run('document.querySelector("details").open=true');
    await run(`choose('search.preferences.profile','1080p · ≤ 15 GiB')`);
    assert.equal(await run('prefValue.resolution'), '1080p'); assert.equal(await run('prefValue.maxGiB'), '15');
    await run(`choose('search.preferences.language','search.preferences.ru')`); assert.equal(await run('prefValue.language'), 'ru');
    await run(`clickText('search.preferences.reset')`); assert.deepEqual(await run('prefValue'), await run('searchDefaults'));
    await run(`choose('search.preferences.profile','2160p · ≤ 40 GiB');openSelect('search.media.voice')`);
    await capture('search-preferences-menu'); await run(`trigger('search.media.voice').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await run('document.querySelectorAll("[role=listbox]").length'), 0);
    win.setSize(320,760); await pause(120); await fits('search preferences'); await capture('search-preferences-320'); win.setSize(660,760);
    await mount('player'); await run('document.querySelector("details").open=true');
    await run(`for(var key of ['ArrowDown','ArrowDown','Enter'])dom.flushSync(()=>trigger('player.preferences.audio').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})))`);
    assert.equal(await run('prefValue.audioLanguage'), 'ru');
    await run(`choose('player.preferences.audio','player.language.ja');choose('player.preferences.size','150%')`);
    assert.equal(await run('prefValue.audioLanguage'), 'ja'); assert.equal(await run('prefValue.subtitleSize'), 150);
    await run(`inputValue(document.querySelector('input[type=number]'),'-0.5');document.querySelector('.number-input-controls button').click()`); await pause(100);
    assert.equal(await run('prefValue.subtitleDelay'), -0.4); await run(`clickText('player.preferences.resetFile')`);
    assert.equal(await run('calls.at(-1).kind'), 'resetFile'); await run(`openSelect('player.preferences.audio')`); await capture('player-preferences-menu');
    await run(`trigger('player.preferences.audio').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    win.setSize(320,760); await pause(120); await fits('player preferences'); await capture('player-preferences-320'); win.setSize(660,760);
    await mount('prefetch'); await run('document.querySelector("details").open=true'); await run(`choose('player.prefetch.budget','32 MiB')`);
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.player.episodePrefetch.v1')).budgetMiB`), 32); await capture('episode-prefetch');
    await mount('provider'); await run('document.querySelector("details").open=true'); await pause(100);
    await run(`choose('search.connection.route','search.connection.new');choose('search.connection.protocol','SOCKS5');inputValue(document.querySelector('input[placeholder="'+t('search.connection.name')+'"]'),'Домашний прокси');inputValue(document.querySelector('input[placeholder="127.0.0.1"]'),'127.0.0.1');busySave=true;clickText('search.connection.save')`); await pause(100);
    assert.equal(await run(`calls.find(c=>c.kind==='proxy').connection.protocol`), 'socks5');
    assert.equal(await run(`trigger('search.connection.protocol').disabled`), true); assert.equal(await run(`trigger('search.connection.route').disabled`), true);
    await run('busySave=false;finishSave()'); await pause(150); await run(`openSelect('search.connection.route')`); await capture('provider-route-menu');
    await run(`dom.flushSync(()=>trigger('search.connection.route').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));choose('search.connection.route','Основной прокси для поиска и подключения к провайдерам')`);
    win.setSize(320,760); await pause(120); await fits('provider connection'); await capture('provider-route-320'); win.setSize(960,820);
    await mount('search'); await run(`inputValue(document.querySelector('.search-input'),'Movie');document.querySelector('.search-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await pause(120);await run(`searchProgress({searchId:'fixture-search',results:[{title:'Movie.2160p.HEVC',size:20000000000,seeds:100,leechers:10,provider:'Демо',magnetUri:'magnet:?xt=urn:btih:0123456789012345678901234567890123456789'}],done:true})`);await pause(120);await run(`document.querySelector('.release-filters').open=true;choose('search.media.codec','HEVC')`);
    assert.equal(await run(`JSON.parse(localStorage.getItem('havvn.search.releaseFilters.v1')||'null')?.codec`), 'HEVC');
    await pause(200); await run(`openSelect('search.media.resolution')`); await capture('search-filter-menu');
    assert.equal(await run(`trigger('search.media.resolution').getAttribute('aria-expanded')`), 'true');
    await run(`trigger('search.media.resolution').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));clickText('search.providers')`); await pause(120);
    await run(`choose('search.provider.type','search.type.script')`); await pause(120);
    assert.equal(await run('!!document.querySelector(".python-status")'), true); await run(`openSelect('search.provider.type')`); await capture('provider-type-menu');
    await mount('create'); await run(`clickText('create.tabAdvanced');choose('create.pieceSize','1 MB')`); assert.equal(await run(`trigger('create.pieceSize').textContent.includes('1 MB')`), true);
    await run(`openSelect('create.pieceSize')`); await capture('create-piece-menu');
    await mount('modal'); await run(`clickText('create.advancedOptions');choose('create.pieceSize','2 MB')`); assert.equal(await run(`trigger('create.pieceSize').textContent.includes('2 MB')`), true);
    await run(`openSelect('create.pieceSize')`); await capture('create-modal-piece-menu');
    await mount('rss'); await run(`clickText('rss.addFeed')`); await pause(150);
    await run(`inputValue(document.querySelector('.rss-feed-modal input[type=number]'),'10');document.querySelector('.rss-feed-modal .number-input-controls button').click()`); await pause(80);
    assert.equal(await run('document.querySelector(".rss-feed-modal input[type=number]").value'), '11'); await capture('rss-feed-number');
    await run(`document.querySelector('.um-x').click();document.querySelectorAll('.rss-tab')[2].click()`); await pause(120); await run(`clickText('rss.rule.add')`); await pause(150);
    await run(`inputValue(document.querySelector('.rule-editor input[type=number]'),'4');document.querySelector('.rule-editor .number-input-controls button').click()`); await pause(100);
    assert.equal(await run('document.querySelector(".rule-editor input[type=number]").value'), '5'); await capture('rss-rule-numbers');
    await mount('provider'); await run(`document.querySelector('details').open=true;choose('search.connection.route','search.connection.new')`);await pause(100);
    for (const theme of ['light', 'aero']) {
      await run(theme === 'light' ? `document.documentElement.className='light';document.documentElement.dataset.theme='light'` : `document.documentElement.className='dark';document.documentElement.dataset.theme='dark';var themeTokens=JSON.parse(fs.readFileSync(path.join(root,'themes/nihil-aero-midnight.havvn-theme.json'),'utf8')).dark;for(var [k,v] of Object.entries(themeTokens))document.documentElement.style.setProperty(k,v)`);
      await run(`openSelect('search.connection.protocol')`); await capture('provider-protocol-' + theme);
      assert.equal(await run('document.querySelector(".custom-select-dropdown").matches(":popover-open")'), true);
      await run(`dom.flushSync(()=>trigger('search.connection.protocol').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))`);
    }

    // Verify all requested UI changes with real components and inert fixture IPC.
    win.setSize(960,820);await mount('settings');await run('inputValue(document.querySelector(".stg-nav-search input"),t("settings.upSpeed"))');await pause(80);assert.equal(await run('[...document.querySelectorAll(".stg-nav-result")].some(node=>node.firstElementChild.textContent===t("settings.upSpeed"))'),true);await capture('settings-search-results');
    await run('dom.flushSync(()=>[...document.querySelectorAll(".stg-nav-result")].find(node=>node.firstElementChild.textContent===t("settings.upSpeed")).click())');await pause(350);assert.equal(await run('document.querySelector("[data-settings-search-target]").dataset.settingLabel===t("settings.upSpeed")&&document.activeElement===document.querySelector("[data-settings-search-target]")'),true);await capture('settings-search-target');
    await run('inputValue(document.querySelector(".stg-nav-search input"),t("settings.autoLaunch"));dom.flushSync(()=>document.querySelector(".stg-nav-search input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})))');await pause(250);assert.equal(await run('document.querySelector("[data-settings-search-target]").dataset.settingLabel===t("settings.autoLaunch")'),true);
    await run('inputValue(document.querySelector(".stg-nav-search input"),"VLC");dom.flushSync(()=>[...document.querySelectorAll(".stg-nav-result")].find(node=>node.firstElementChild.textContent===t("external.choose")).click())');await pause(100);assert.equal(await run('document.querySelector("[data-settings-search-target]").dataset.settingLabel===t("external.choose")&&document.querySelector("[data-settings-search-target]").tagName==="BUTTON"'),true);await capture('settings-search-player-control');
    await run('settingsMessage={type:"error",text:t("settings.msg.devOnly2")};dom.flushSync(()=>mounted.render(React.createElement(SettingsFixture)))');await pause(100);assert.equal(await run('document.querySelector(".settings-alert").getBoundingClientRect().top===40'),true);await capture('settings-alert-lower');
    assert.equal(await run('parseFloat(getComputedStyle(document.querySelector(".external-player-preferences")).borderRadius)>0'),true);await capture('external-player-rounded');
    await mount('roomhead');await run('document.documentElement.dataset.radiusOverrides="buttons inputs";document.documentElement.style.setProperty("--ap-radius-buttons","18px");document.documentElement.style.setProperty("--ap-radius-inputs","10px")');await pause(80);assert.equal(await run('getComputedStyle(document.querySelector(".rooms-profile-chip")).borderRadius===getComputedStyle(document.querySelector(".rooms-header-actions > .btn")).borderRadius'),true);assert.equal(await run('[...document.querySelectorAll(".rooms-header-actions button")].find(node=>node.textContent.trim()===t("rooms.join")).classList.contains("btn-secondary")'),true);await capture('rooms-header-unified');
    await mount('search');await run('inputValue(document.querySelector(".search-input"),"Movie");document.querySelector(".search-form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await pause(80);await run('searchProgress({searchId:"fixture-search",results:[{title:"Movie.2160p.HEVC",size:20000000000,seeds:100,leechers:10,provider:"Демо",magnetUri:"magnet:?xt=urn:btih:0123456789012345678901234567890123456789"}],done:true})');await pause(80);await run('document.querySelector(".refine-input").focus()');assert.equal(await run('getComputedStyle(document.querySelector(".refine-input")).boxShadow==="none"'),true);assert.equal(await run('[...document.querySelectorAll(".results-filters > .filter-toggle,.refine-wrap,.min-seeds")].every(node=>getComputedStyle(node).borderRadius==="18px")'),true);await capture('search-controls-unified');
    win.setSize(320,760);await mount('rss');await run('document.querySelectorAll(".rss-tab")[2].click()');await pause(80);assert.equal(await run('(()=>{var button=document.querySelector(".rules-toolbar .btn"),rect=button.getBoundingClientRect(),icon=button.querySelector("svg").getBoundingClientRect();return rect.right<=innerWidth&&icon.width===14&&icon.left>=rect.left+6&&button.scrollWidth<=button.clientWidth+1;})()'),true);await capture('rss-rule-button-320');
    win.setSize(680,760);await mount('torrentSearch');await run('document.querySelector(".tsm-input").focus()');assert.equal(await run('getComputedStyle(document.querySelector(".tsm-input")).boxShadow==="none"'),true);await capture('torrent-search-single-frame');
    await mount('files');await run('dom.flushSync(()=>document.querySelector(".file-item input").click())');assert.equal(await run('document.querySelectorAll(".file-item input:checked").length'),2);await run('document.querySelector(".file-item input").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});await pause(100);assert.equal(await run('document.querySelectorAll(".file-item input:checked").length'),3);await capture('torrent-file-round-markers');
    await run('dom.flushSync(()=>document.querySelector(".file-item").click())');assert.equal(await run('document.querySelectorAll(".file-item input:checked").length'),2);await run('dom.flushSync(()=>[...document.querySelectorAll("button")].find(node=>node.textContent.trim().startsWith(t("filePicker.downloadSelected"))).click())');assert.deepEqual(await run('calls.find(call=>call.kind==="confirmFiles").ids'),[1,2]);
    await mount('tree');await run('dom.flushSync(()=>document.querySelectorAll(".tree-content input")[1].click())');assert.equal(await run('document.querySelector(".tree-header input").indeterminate'),true);await capture('torrent-tree-round-markers');await run('dom.flushSync(()=>document.querySelector(".tree-header input").click())');assert.equal(await run('[...document.querySelectorAll(".tree-node input")].every(node=>node.checked)'),true);

    assert.equal(await run('document.querySelectorAll("select").length'), 0); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ calls: await run('calls'), errors, passed: true }, null, 2));
    console.log('UI polish passed:', out); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); console.error('Fixture output:', out); clearTimeout(deadline); app.exit(1); });
}
