// Functional regressions through actual React pages, with delayed/failing API replies.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-functional-audit-'));
  const output = path.resolve(root, process.env.HAVVN_FUNCTIONAL_ARTIFACTS || 'artifacts/functional-audit-20261030'); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Functional UI deadline'); app.exit(1); }, 90_000);
  app.whenReady().then(async () => {
    const state = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    state.scheduler = { enabled: true, schedules: [{ id: 'night', days: [1], startTime: '22:00', endTime: '06:00', speedLimit: 100 }] };
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/SettingsPage.css', 'renderer/pages/settings/shell.css',
      'renderer/pages/settings/controls.css', 'renderer/pages/settings/SettingsNav.css', 'renderer/pages/RSSPage.css',
      'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/Toggle.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'index.html');
    fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    win.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer: ' + details.message); });
    await win.loadFile(page);
    const run = code => win.webContents.executeJavaScript(code), pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(state)};
      var savedInitial=structuredClone(settingsFixture),failToggle=false,settingsCalls=[],rssJobs=[],previewJobs=[];
      var feedA={id:'a',name:'Feed A',url:'https://a.invalid',enabled:true},feedB={id:'b',name:'Feed B',url:'https://b.invalid',enabled:true};
      var itemA={guid:'a',feedId:'a',title:'Alpha release',link:'magnet:?xt=urn:btih:'+ 'a'.repeat(40)},itemB={guid:'b',feedId:'b',title:'Beta release',link:'magnet:?xt=urn:btih:'+'b'.repeat(40)};
      var holdItems=false,holdPreview=false;
      var fixtureApiOverrides={
        getScheduler:async()=>structuredClone(settingsFixture.scheduler),
        updateSettings:async patch=>{settingsCalls.push(patch);if(failToggle){failToggle=false;throw Error('Fixture settings failure');}Object.assign(settingsFixture.settings,patch);return structuredClone(settingsFixture.settings);},
        updateScheduler:async patch=>{Object.assign(settingsFixture.scheduler,patch);return structuredClone(settingsFixture.scheduler);},
        getEffectiveSettings:async()=>({...load(path.join(fixtureRoot,'shared/effective-settings.ts')).resolveEffectiveSettings(settingsFixture.settings,{scheduler:settingsFixture.scheduler}),applied:true}),
        rss:{getFeeds:async()=>[feedA,feedB],getRules:async()=>[],getItems:async feedId=>holdItems?new Promise(resolve=>rssJobs.push({feedId,resolve})):feedId==='a'?[itemA]:feedId==='b'?[itemB]:[itemA,itemB],
          forecastRule:async rule=>{const items=holdPreview?await new Promise(resolve=>previewJobs.push({rule,resolve})):[];return load(path.join(fixtureRoot,'shared/rss-forecast.ts')).forecastRssRule(rule,items,[feedA,feedB]);},markDownloaded:async()=>{}},
      };
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      var Settings=load(path.join(fixtureRoot,'renderer/pages/SettingsPage.tsx')).default;
      components.CategorySelect=load(path.join(fixtureRoot,'renderer/components/CategorySelect.tsx')).CategorySelect;
      var ThemeProvider=load(path.join(fixtureRoot,'renderer/components/ThemeEditorContext.tsx')).ThemeEditorProvider;
      var RSS=load(path.join(fixtureRoot,'renderer/pages/RSSPage.tsx')).default;
      function mountSettings(reset=true){if(reset)settingsFixture=structuredClone(savedInitial);dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(ThemeProvider,null,React.createElement(Settings,{key:Math.random()})))));}
      function mountRSS(){holdItems=false;rssJobs=[];previewJobs=[];dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(RSS,{key:Math.random()}))));}
      function btn(key,scope=document){return [...scope.querySelectorAll('button')].find(n=>n.textContent.trim()===t(key));}
      function nav(id){btn('settings.'+id,document.querySelector('.stg-nav')).click();}
      function field(key){return [...document.querySelectorAll('.stg-row')].find(n=>n.dataset.settingLabel===t(key));}
      function input(node,value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));}
      true;`);
    const checks = [], failures = [];
    const wait = async expression => { for (let i = 0; i < 55; i++) { if (await run(expression)) return; await pause(); } throw Error(expression); };
    const scenario = async (name, test) => { try { await test(); checks.push(name); console.log('PASS ' + name); } catch (error) { failures.push({ name, error: String(error) }); console.error('FAIL ' + name + ': ' + error); } };
    const settings = async id => { await run('mountSettings();true;'); await wait('!!document.querySelector(".stg-nav")'); await run(`nav(${JSON.stringify(id)});true;`); await pause(); };
    await scenario('Schedule edits can be saved and survive remount', async () => {
      await settings('scheduler'); await run(`document.querySelector('.sched-add button').click();true;`); await pause();
      assert.equal(await run(`!!document.querySelector('.stg-save')`), true, 'missing save bar');
      await run(`btn('settings.saveChanges').click();true;`); await wait('!document.querySelector(".stg-save")');
      assert.equal(await run('settingsFixture.scheduler.schedules.length'), 2);
      await run(`dom.flushSync(()=>tree.render(null));mountSettings(false);true;`);
      await wait('!!document.querySelector(".stg-nav")'); await run(`nav('scheduler');true;`); await pause();
      assert.equal(await run('document.querySelectorAll(".sched-entry").length'), 2);
    });
    await scenario('Cancel discards schedule drafts', async () => {
      await settings('scheduler'); const count = await run('document.querySelectorAll(".sched-entry").length');
      await run(`document.querySelector('.sched-add button').click();true;`); await pause();
      await run(`btn('settings.cancel',document.querySelector('.stg-save')).click();true;`); await pause();
      assert.equal(await run('document.querySelectorAll(".sched-entry").length'), count);
    });
    await scenario('Cancel does not undo an already saved scheduler toggle', async () => {
      await settings('scheduler'); await run(`document.querySelector('[role=switch]').click();true;`); await pause();
      await run(`nav('connection');true;`); await pause(); await run(`input(field('settings.downSpeed').querySelector('input'),'777');true;`); await pause();
      await run(`btn('settings.cancel',document.querySelector('.stg-save')).click();nav('scheduler');true;`); await pause();
      assert.equal(await run(`document.querySelector('[role=switch]').getAttribute('aria-checked')`), 'false');
      assert.equal(await run('settingsFixture.scheduler.enabled'), false);
    });
    await scenario('Failed toggle preserves unrelated unsaved settings', async () => {
      await settings('connection'); await run(`input(field('settings.downSpeed').querySelector('input'),'777');true;`); await pause();
      await run(`failToggle=true;field('settings.dht').querySelector('[role=switch]').click();true;`); await pause(180);
      assert.equal(await run(`field('settings.downSpeed').querySelector('input').value`), '777');
      assert.equal(await run(`!!document.querySelector('.stg-save')`), true);
      assert.equal(await run(`field('settings.dht').querySelector('[role=switch]').getAttribute('aria-checked')`), String(state.settings.enableDHT));
    });
    await scenario('Night schedule paints Monday evening and Tuesday morning', async () => {
      await run('savedInitial.scheduler=structuredClone('+JSON.stringify(state.scheduler)+');true;');
      await settings('scheduler');
      const painted = await run(`[...document.querySelectorAll('.sched-week-row')].map(n=>[...n.querySelectorAll('.sched-week-seg')].map(s=>parseFloat(s.style.width)))`);
      assert.equal(painted[0].length,1); assert.ok(Math.abs(painted[0][0]-100*120/1440)<0.001); assert.deepEqual(painted[1], [25]); assert.deepEqual(painted[2], []);
    });
    await scenario('Late RSS reply cannot replace the selected feed', async () => {
      await run('mountRSS();true;'); await wait('!!document.querySelector(".rss-tabs")');
      await run(`document.querySelectorAll('.rss-tab')[1].click();true;`);
      await pause();
      await run(`holdItems=true;[...document.querySelectorAll('.filter-chip')].find(n=>n.textContent==='Feed A').click();true;`); await pause();
      await run(`[...document.querySelectorAll('.filter-chip')].find(n=>n.textContent==='Feed B').click();true;`); await pause();
      await run(`rssJobs.filter(j=>j.feedId==='b').forEach(j=>j.resolve([itemB]));true;`); await pause();
      await run(`rssJobs.filter(j=>j.feedId==='a').forEach(j=>j.resolve([itemA]));true;`); await pause();
      assert.equal(await run(`document.body.textContent.includes('Beta release')`), true);
    });
    await scenario('RSS rule preview follows the latest edit', async () => {
      await run('mountRSS();true;'); await wait('!!document.querySelector(".rss-tabs")');
      await run(`document.querySelectorAll('.rss-tab')[2].click();true;`); await pause();
      await run(`holdPreview=true;btn('rss.rule.add').click();true;`); await wait('previewJobs.length===1');
      await run(`input(document.querySelector('.rule-editor input'),'New rule');true;`); await wait('previewJobs.length>=2');
      await run(`previewJobs.at(-1).resolve([itemB]);true;`); await wait(`document.querySelector('.rule-preview').textContent.includes('Beta release')`);
      await run(`previewJobs[0].resolve([itemA]);true;`); await pause();
      assert.equal(await run(`document.querySelector('.rule-preview').textContent.includes('Beta release')&&!document.querySelector('.rule-preview').textContent.includes('Alpha release')`), true);
    });
    const report = { passed: failures.length === 0, fixtureApi: true, checks, failures };
    fs.writeFileSync(path.join(output, 'ui-report.json'), JSON.stringify(report, null, 2));
    clearTimeout(deadline); await run('tree.unmount();true;'); win.destroy(); app.exit(report.passed ? 0 : 1);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
