// Actual renderer components, isolated profile and fixture IPC; no user data.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-themed-controls-'));
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
      'renderer/components/CreateTorrentModal.css'];
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
        var js=ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
        new Function('require','module','exports',js)(s=>{if(s.endsWith('.css'))return {};if(s.includes('i18nContext'))return {useTranslation:()=>({t,language:'ru'})};
          if(s.endsWith('state/downloads'))return {useDownloads:fn=>fn(downloads),downloadsModel:{retain:()=>()=>{},refresh:async()=>{},updateDownloads:()=>{}}};
          if(s==='../components'){var all={useConfirm:()=>({confirm:async()=>true,alert:async()=>{}})};for(var n of ['Button','Icon','Input','ProgressBar','EmptyState','CategorySelect','DropdownMenu','TorrentFileSelector','FileTreeSelector','QRCode','TrackerTemplates','MetadataPreview','BatchCreate'])Object.assign(all,load(path.join(root,'renderer/components/'+n+'.tsx')));Object.assign(all,load(path.join(root,'renderer/components/Toast.tsx')));return all;}
          if(s.startsWith('.')){var q=path.resolve(path.dirname(p),s);for(var ext of ['.tsx','.ts','/index.ts'])if(fs.existsSync(q+ext))return load(q+ext);throw Error(q);}
          return require(s.startsWith('node:')?s:path.join(root,'node_modules',s));},m,m.exports);return m.exports;}
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
        var page=kind==='rss'?'RSSPage':kind==='create'?'CreateTorrentPage':['search','preferences','provider'].includes(kind)?'SearchPage':null;
        document.querySelector('#page-style').textContent=page?fs.readFileSync(path.join(root,'renderer/pages/'+page+'.css'),'utf8'):'';
        mounted=createRoot(el);var props={};var component={player:Panel,preferences:Panel,provider:Provider,prefetch:Prefetch,search:Search,rss:Rss,create:Create,modal:CreateModal}[kind];
        if(kind==='player'||kind==='preferences')props={kind:kind==='player'?'player':'search'};
        if(kind==='provider')props={provider:{id:'fixture',name:'Провайдер',type:'custom',url:'https://example.test'}};
        if(kind==='prefetch')props={media:null,downloadId:'fixture',currentFile:0,nextFile:1,nextName:'Следующая серия'};
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
    assert.equal(await run('document.querySelectorAll("select").length'), 0); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ calls: await run('calls'), errors, passed: true }, null, 2));
    console.log('Themed controls passed:', out); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); console.error('Fixture output:', out); clearTimeout(deadline); app.exit(1); });
}
