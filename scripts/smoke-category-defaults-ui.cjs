// Real category editor, file selector, inherited defaults and RSS preview in Electron.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-category-ui-'));
  const env = { ...process.env, HAVVN_CATEGORY_UI_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-category-ui-')) throw Error('Unexpected category UI fixture');
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_CATEGORY_UI_SCRATCH || ''), output = path.join(root, 'dist/category-defaults-ui');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-category-ui-')) throw Error('Missing isolated category UI profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Category UI deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const db = require(path.join(root, 'dist/electron/electron/db/store.js'));
    await db.updateSettings({ defaultDownloadDir: path.join(scratch, 'global'), defaultSeedRatioLimit: 2, defaultSeedTimeLimitMinutes: 60 });
    let window;
    const changed = () => window.webContents.send('fixture:categories');
    for (const method of ['getCategories', 'addCategory', 'updateCategory', 'deleteCategory']) ipcMain.handle('fixture:' + method, async (_event, ...args) => {
      const result = await db[method](...args); if (method !== 'getCategories') changed(); return result;
    });
    const fixture = db.readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/settings/controls.css', 'renderer/components/Select.css',
      'renderer/components/Modal.css', 'renderer/components/NumberInput.css', 'renderer/components/TorrentFileSelector.css', 'renderer/components/DownloadDefaultsPreview.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'ui.html'); fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{max-width:960px;margin:16px auto;padding:0 16px}</style><div id="root"></div></html>');
    window = new BrowserWindow({ show: false, width: 1060, height: 1100, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; window.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error('Renderer:', message.message); } });
    await window.loadFile(page); const run = code => window.webContents.executeJavaScript(code);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(fixture)},testSavedViews=true,testCategoryDefaults=true;
      var ipc=require('electron').ipcRenderer,fixtureApiOverrides={
        getCategories:()=>ipc.invoke('fixture:getCategories'),addCategory:c=>ipc.invoke('fixture:addCategory',c),updateCategory:(id,c)=>ipc.invoke('fixture:updateCategory',id,c),deleteCategory:id=>ipc.invoke('fixture:deleteCategory',id),
        onCategoriesChanged:fn=>{var listener=()=>fn();ipc.on('fixture:categories',listener);return()=>ipc.removeListener('fixture:categories',listener)},
        getTorrentInfo:async()=>({name:'Fixture',totalSize:100,files:[{index:0,path:'fixture.bin',size:100}]}),selectDirectory:async()=>${JSON.stringify(path.join(scratch, 'chosen'))}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      var Panel=load(path.join(fixtureRoot,'renderer/pages/settings/sections/CategoriesPanel.tsx')).CategoriesPanel;
      var Confirm=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      function render(child){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Confirm,null,child))));}
      function field(key){return document.querySelector('input[aria-label="'+t(key)+'"]');}
      function input(key,value){var el=field(key);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}
      function button(key){return [...document.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
      function openSelect(key){document.querySelector('[aria-label="'+t(key)+'"][aria-haspopup=listbox]').click();}
      function option(text){[...document.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===text).click();}
      render(React.createElement(Panel));true;`);
    const checks = [], check = async (label, predicate) => {
      for (let n = 0; n < 80; n++) { if (await predicate()) { checks.push(label); console.log('PASS ' + label); return; } await new Promise(resolve => setTimeout(resolve, 70)); }
      console.error(await run('document.body.innerText')); throw Error(label);
    };
    await check('Category editor renders the inherited fields', () => run(`!!field('category.defaults.seedRatioLimit')&&field('category.defaults.seedRatioLimit').value===''`));
    await run(`dom.flushSync(()=>input('category.defaults.name','UI category'));dom.flushSync(()=>input('category.defaults.savePath',${JSON.stringify(path.join(scratch, 'category'))}));dom.flushSync(()=>input('category.defaults.seedRatioLimit','0'));`);
    await run(`openSelect('category.defaults.paused')`); await run(`option(t('category.defaults.paused'))`);
    await run(`openSelect('category.defaults.sequentialDownload')`); await run(`option(t('common.yes'))`);
    await run(`button('common.save').click()`);
    await check('New category is saved with explicit zero/true through real IPC/store', async () => (await db.getCategories()).some(c => c.name === 'UI category' && c.downloadDefaults?.seedRatioLimit === 0 && c.downloadDefaults?.paused === true && c.downloadDefaults?.sequentialDownload === true));
    const category = (await db.getCategories()).find(c => c.name === 'UI category');
    await check('Saved status is visible', () => run(`document.body.textContent.includes(t('category.defaults.saved'))`));
    const capture = async name => {
      await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await capture('editor-wide.png');
    window.setSize(520, 1100);
    await check('Editor fits a narrow window', () => run(`document.documentElement.scrollWidth<=innerWidth+1`));
    await capture('editor-narrow.png');
    window.setSize(1060, 1100);
    await run(`var FileSelector=load(path.join(fixtureRoot,'renderer/components/TorrentFileSelector.tsx')).TorrentFileSelector;var submitted,failAdd=true;
      render(React.createElement(FileSelector,{torrentPath:'fixture.torrent',allowCategory:true,onCancel:()=>{},onConfirm:async(files,savePath,options)=>{submitted={files,savePath,options};if(failAdd)throw Error('Destination unavailable fixture')}}));true;`);
    await check('File selector shows global default sources before a category is chosen', () => run(`document.querySelector('[data-default-field="savePath"]')?.dataset.defaultSource==='global'`));
    await run(`openSelect('rss.form.category')`); await run(`option('UI category')`);
    await check('Manual add inherits the selected category path and paused state', () => run(`document.querySelector('[data-default-field="savePath"]')?.dataset.defaultSource==='category'&&document.querySelector('[data-default-field="paused"]').textContent.includes(t('category.defaults.paused'))`));
    await run(`openSelect('category.defaults.paused')`); await run(`option(t('category.defaults.active'))`);
    await run(`button('settings.choose').click()`);
    await check('Explicit destination and active state replace category defaults in the preview', () => run(`document.querySelector('[data-default-field="savePath"]')?.dataset.defaultSource==='explicit'&&document.querySelector('[data-default-field="paused"]').dataset.defaultSource==='explicit'`));
    await run(`[...document.querySelectorAll('button')].find(node=>node.textContent.includes(t('filePicker.downloadSelected'))).click();true;`);
    // The request itself must keep false as an explicit value.
    await check('Manual add keeps the category ID and explicit false in its request', () => run(`submitted?.options?.categoryId===${JSON.stringify(category.id)}&&submitted.options.paused===false&&submitted.savePath===${JSON.stringify(path.join(scratch, 'chosen'))}`));
    await check('A rejected destination leaves the chosen options available for retry', () => run(`document.querySelector('[role=alert]')?.textContent.includes('Destination unavailable fixture')&&document.querySelector('[data-default-field="savePath"]').dataset.defaultSource==='explicit'`));
    await run(`failAdd=false;[...document.querySelectorAll('button')].find(node=>node.textContent.includes(t('filePicker.downloadSelected'))).click();true;`);
    await run(`var Preview=load(path.join(fixtureRoot,'renderer/components/DownloadDefaultsPreview.tsx')).RuleDownloadDefaultsPreview;
      render(React.createElement(Preview,{rule:{feedIds:[],addPaused:false},feeds:[{id:'a',name:'Feed A',categoryId:${JSON.stringify(category.id)},savePath:'D:/feed-a'},{id:'b',name:'Feed B',categoryId:${JSON.stringify(category.id)},savePath:'D:/feed-b'}]}));true;`);
    await check('RSS preview uses feed destination and explicit active state', () => run(`document.querySelector('[data-default-field="savePath"]')?.textContent.includes('D:/feed-a')&&document.querySelector('[data-default-field="paused"]').textContent.includes(t('category.defaults.active'))`));
    await run(`openSelect('category.defaults.previewFeed')`); await run(`option('Feed B')`);
    await check('Multi-feed rule preview follows the selected feed', () => run(`document.querySelector('[data-default-field="savePath"]')?.textContent.includes('D:/feed-b')`));
    await run(`render(React.createElement(Panel));true;`);
    await run(`openSelect('category.defaults.edit')`); await run(`option('UI category')`);
    await run(`button('category.defaults.reset').click();true;`);
    await run(`button('common.save').click();true;`);
    await check('Reset returns the category to global inheritance', async () => Object.keys((await db.getCategories()).find(c => c.id === category.id).downloadDefaults).length === 0);
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');true;`);
    await check('English category labels render without raw keys', () => run(`document.body.textContent.includes('Category defaults')&&!document.body.textContent.includes('category.defaults.')`));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    await run('tree.unmount();true;'); window.destroy(); console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
