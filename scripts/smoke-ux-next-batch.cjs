// Real React surfaces and the production RSS forecast; isolated profile and synthetic sources.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-ux-next-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_NEXT_FIXTURE: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Invalid fixture path'); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron'), root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_NEXT_FIXTURE || '');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing isolated profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const output = path.join(root, 'artifacts/ux-next-20261108'); fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => { console.error('Next batch UI deadline'); app.exit(1); }, 120000);
  app.whenReady().then(async () => {
    const db = require(path.join(root, 'dist/electron/electron/db/store.js')), settings = db.readSettingsImportState();
    const feed = await db.addRSSFeed({ name: 'Синтетическая лента', url: 'https://fixture.invalid/rss', enabled: false, autoDownload: false, intervalMinutes: 30 });
    const rule = await db.addRSSRule({ name: 'Show', enabled: false, feedIds: [feed.id], mode: 'wildcard', include: 'Show', exclude: 'sample', smartEpisode: true });
    const items = [
      { guid: 'done', title: 'Show S01E01', downloaded: true }, { guid: 'ignored', title: 'Show S01E02', ignored: true },
      { guid: 'weak', title: 'Show S01E03', seeds: 1 }, { guid: 'strong', title: 'Show S01E03', seeds: 100 }, { guid: 'sample', title: 'Show sample S01E04' },
    ].map(row => ({ downloaded: false, ...row, link: 'magnet:?xt=urn:btih:' + '1'.repeat(40), feedId: feed.id }));
    await db.saveRSSItems(items);
    const rss = new (require(path.join(root, 'dist/electron/electron/services/rss-service.js')).RSSService)();
    const beforeRss = JSON.stringify([await db.getRSSItems(), await db.getRSSRules()]);
    ipcMain.handle('fixture:rssForecast', (_event, value) => rss.forecastRule(value));
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css', 'renderer/styles/layout.css', 'renderer/pages/RSSPage.css', 'renderer/pages/SearchPage.css', 'renderer/pages/SettingsPage.css', 'renderer/pages/settings/controls.css', 'renderer/pages/settings/SettingsTasks.css', 'renderer/pages/settings/sections/AutomationSection.css', 'renderer/pages/settings/sections/WorkingProfilesPanel.css', 'renderer/pages/settings/SettingsNav.css', 'renderer/components/Modal.css', 'renderer/components/RecoveryError.css', 'renderer/components/ErrorMessage.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css', 'renderer/components/NumberInput.css', 'renderer/components/SearchQueryInput.css', 'renderer/components/DownloadDefaultsPreview.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(scratch, 'ui.html'); fs.writeFileSync(html, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '#root{height:100vh}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1250, height: 950, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = [], checks = []; win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Renderer:', event.message); } });
    await win.loadFile(html); const run = code => win.webContents.executeJavaScript(code), pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (name, expression) => { for (let i = 0; i < 120; i++) { if (await run(expression)) { checks.push(name); return; } await pause(35); } assert.fail(name + ': ' + await run('document.body.innerText.slice(-2500)')); };
    const check = async (name, expression) => { assert.equal(await run(expression), true, name); checks.push(name); };
    const click = async key => { await until('Button is available: ' + key, `!!btn(${JSON.stringify(key)})`); await run(`btn(${JSON.stringify(key)}).click();true;`); await pause(); };
    const capture = async name => { win.showInactive(); await pause(100); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide(); };
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},testSavedViews=true,testDownloadUndo=true,fixtureCategories=[{id:'series',name:'Сериалы'}];
      var rssFeeds=${JSON.stringify([feed])},rssItems=${JSON.stringify(items)},rssRules=${JSON.stringify([rule])},rssRunCount=0,rssSaveCount=0,automationSaves=[],automationPreviews=[],searchStarts=[],searchReceiver,searchNumber=0,settingsRoutes=[];
      var automationConfig={schema:1,revision:0,rules:[]};
      var fixtureApiOverrides={
        getCategories:async()=>[{id:'series',name:'Сериалы',downloadDefaults:{paused:true}}],
        rss:{getFeeds:async()=>rssFeeds,getItems:async()=>rssItems,getRules:async()=>rssRules,forecastRule:value=>require('electron').ipcRenderer.invoke('fixture:rssForecast',value),runRuleNow:async()=>{rssRunCount++;return{grabbed:0,skipped:0}},updateRule:async()=>{rssSaveCount++;return rssRules[0]}},
        automation:{get:async()=>({config:structuredClone(automationConfig),storage:'ready',history:[]}),preview:async(sample,rules)=>{automationPreviews.push(structuredClone(rules));return load(path.join(fixtureRoot,'shared/automation-rules.ts')).planAutomation(rules,sample,[{id:'series'}]);},save:async config=>{automationSaves.push(structuredClone(config));automationConfig={...config,revision:config.revision+1};return{config:automationConfig,storage:'ready',history:[]}}},
        search:{getProviders:async()=>[{id:'good',name:'Рабочий источник',enabled:true,type:'custom',url:'https://fixture.invalid'},{id:'broken',name:'Источник с ошибкой',enabled:true,type:'custom',url:'https://fixture.invalid'}],getDownloadHistory:async()=>[],onProgress:fn=>{searchReceiver=fn;return()=>{searchReceiver=null}},start:async(...args)=>{searchStarts.push(args);return{searchId:'search-'+(++searchNumber),providers:args[3]?['Источник с ошибкой']:['Рабочий источник','Источник с ошибкой'],providerIds:args[3]?['broken']:['good','broken']}},cancel:async()=>{},getNetworkSettings:async()=>({profiles:[],access:{}}),testProvider:async()=>({success:true,message:'Соединение проверено'}),login:async()=>({success:true,message:'Вход выполнен'})}
      };
      ${fs.readFileSync(path.join(root, 'scripts/fixtures/command-palette-ui.cjs'), 'utf8')}
      dom.flushSync(()=>tree.render(null));
      Object.assign(components,...['CategorySelect','QRCode','ThemeSelector','HotkeySettings','Identicon','Avatar','Modal','Tabs','AppStatistics','TorrentFileSelector','Select'].map(name=>load(path.join(fixtureRoot,'renderer/components/'+name+'.tsx'))));
      var ConfirmProvider=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      function mount(Component,props={}){dom.flushSync(()=>tree.render(null));dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(ConfirmProvider,null,React.createElement(Component,props)))));}
      function btn(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key)||node.textContent.trim().startsWith(t(key)+' (')||node.title===t(key)||node.getAttribute('aria-label')===t(key));}
      function value(node,text){Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(node,text);dom.flushSync(()=>node.dispatchEvent(new Event('input',{bubbles:true})));}
      var RSS=load(path.join(fixtureRoot,'renderer/pages/RSSPage.tsx')).default,Search=load(path.join(fixtureRoot,'renderer/pages/SearchPage.tsx')).default;
      var Automation=load(path.join(fixtureRoot,'renderer/pages/settings/sections/AutomationSection.tsx')).AutomationSection,Tasks=load(path.join(fixtureRoot,'renderer/pages/settings/SettingsTasks.tsx')).SettingsTasks;
      mount(RSS);true;`);
    await until('RSS page loads its stored rules', `!!btn('rss.tab.rules')`); await click('rss.tab.rules');
    await until('Stored rule is shown', `!!document.querySelector('.rule-card')`);
    await run(`document.querySelector('.rule-card .feed-edit-btn').click();true;`);
    await until('Forecast separates candidates and processed items', `document.querySelectorAll('[data-rss-forecast=ready]').length===1&&document.querySelectorAll('[data-rss-forecast=processed]').length===2&&document.querySelectorAll('[data-rss-forecast=excluded]').length===2`);
    await check('Forecast is read-only in the UI', `rssRunCount===0&&rssSaveCount===0&&document.querySelector('.rss-forecast-counts').textContent.includes('К добавлению: 1')`);
    assert.equal(JSON.stringify([await db.getRSSItems(), await db.getRSSRules()]), beforeRss); checks.push('Production forecast preserves inventory and rule history');
    await run(`document.querySelector('.rule-preview').scrollIntoView({block:'center'});true;`); await capture('rss-forecast');
    await click('rss.forecast.template.quality'); await until('Template changes conditions without enabling or running the rule', `document.querySelector('.rule-editor input[placeholder="show name 1080p"]').value==='1080p'&&rssRunCount===0&&rssSaveCount===0`);
    for (const width of [700, 400]) { win.setContentSize(width, 820); await pause(); await check('RSS forecast fits at ' + width, `(()=>{const el=document.querySelector('.rule-preview');return el.scrollWidth<=el.clientWidth+1&&document.querySelector('.um-card').getBoundingClientRect().right<=innerWidth})()`); }
    win.setContentSize(1150, 950);
    await run(`var draft=load(path.join(fixtureRoot,'shared/automation-draft.ts')).automationDraft({download:{name:'Show S01E03',sourceType:'magnet',category:'series',savePath:'D:/series'}},'draft-example');mount(Automation,{initialDraft:draft});true;`);
    await until('Rule from a download appears disabled with its scope', `!!document.querySelector('[data-automation-draft]')&&document.querySelectorAll('.automation-rule').length===1`);
    await check('Creating a draft does not save or activate it', `automationSaves.length===0&&document.querySelector('.automation-rule summary').textContent.includes(t('automation.disabled'))`);
    await click('automation.preview'); await until('Preview evaluates the temporary enabled draft only', `!!document.querySelector('[data-automation-preview]')&&automationPreviews.at(-1)[0].enabled===true&&automationSaves.length===0`);
    await capture('automation-from-download'); await run(`document.querySelector('[data-automation-preview]').scrollIntoView({block:'center'});true;`); await capture('automation-preview'); await click('automation.save');
    await until('Explicit save keeps the new rule disabled', `automationSaves.length===1&&automationSaves[0].rules[0].enabled===false`);
    await run(`mount(Tasks,{settings:settingsFixture.settings,locked:false,onNavigate:id=>settingsRoutes.push(id)});true;`);
    await click('settings.tasks.room'); await check('Task guide applies no settings implicitly', `settingsRoutes.length===0&&document.body.textContent.includes(t('settings.tasks.noImplicit'))`);
    await capture('task-settings'); await click('settings.sharing'); await check('Task route reaches the existing section', `settingsRoutes[0]==='sharing'`);
    await run(`mount(Search);true;`); await until('Search form is ready', `!!document.querySelector('.search-form input')`);
    await run(`value(document.querySelector('.search-form input'),'Example query');btn('search.btn').click();true;`); await until('Search starts once', `searchStarts.length===1`);
    await run(`searchReceiver({searchId:'search-1',results:[{title:'Successful release',size:100,seeds:10,provider:'Рабочий источник',magnetUri:'magnet:?xt=urn:btih:'+'a'.repeat(40)}],stat:{providerId:'good',name:'Рабочий источник',state:'ok',count:1,ms:5}});searchReceiver({searchId:'search-1',stat:{providerId:'broken',name:'Источник с ошибкой',state:'failed',count:0,ms:5,error:'Authentication required',errorCode:'auth'},done:true});true;`);
    await until('Successful results coexist with a failed source', `!!btn('search.recovery.open')&&document.querySelectorAll('.results-row').length>=1`);
    await capture('search-partial-results'); await click('search.recovery.open');
    await check('Known authentication code explains sign-in and retains technical details', `document.body.textContent.includes(t('search.recovery.authCause'))&&document.querySelector('.user-error-details')?.textContent.includes('Authentication required')`);
    await capture('source-recovery'); await click('search.recovery.test');
    await until('Source helper reports an actual connection test', `document.body.innerText.includes('Соединение проверено')`);
    await click('search.recovery.settings'); await until('Source settings keep an explicit return route', `!!document.querySelector('.search-source-return')&&document.activeElement.dataset.providerCard==='broken'`);
    await click('search.recovery.return'); await check('Returning keeps results and does not restart the search', `searchStarts.length===1&&document.querySelector('.search-form input').value==='Example query'&&document.body.innerText.includes('Successful release')`);
    await click('search.recovery.open'); await click('search.recovery.retryOnly');
    await until('Retry targets one source', `searchStarts.length===2&&searchStarts[1][3]==='broken'`);
    await run(`searchReceiver({searchId:'search-2',results:[{title:'Recovered release',size:100,seeds:10,provider:'Источник с ошибкой',magnetUri:'magnet:?xt=urn:btih:'+'b'.repeat(40)}],stat:{providerId:'broken',name:'Источник с ошибкой',state:'ok',count:1,ms:5},done:true});true;`);
    await until('Recovered source preserves successful earlier results', `document.body.innerText.includes('Successful release')&&document.body.innerText.includes('Recovered release')`);
    win.setContentSize(400, 900); await pause(); await check('Grouped source controls fit the narrow viewport', `[...document.querySelectorAll('.provider-status-group button')].every(el=>el.getBoundingClientRect().right<=innerWidth+1)`);
    assert.deepEqual(errors, []); checks.push('No renderer errors');
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log('PASS next UX batch:', checks.length, 'checks'); rss.destroy(); clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
