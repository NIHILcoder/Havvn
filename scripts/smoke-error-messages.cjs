// Actual error surfaces with fixture failures, isolated profile, no user data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-error-messages-'));
  const output = path.join(root, 'artifacts/error-messages-20261030'); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Error messages UI deadline'); app.exit(1); }, 90_000);
  app.whenReady().then(async () => {
    const settings = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/components/Modal.css', 'renderer/components/Select.css',
      'renderer/components/Toast.css', 'renderer/components/ErrorMessage.css', 'renderer/components/TorrentFileSelector.css',
      'renderer/pages/DownloadsPage.css', 'renderer/pages/RSSPage.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'index.html');
    fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh;padding:20px}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith('Failed to load torrent info:')) errors.push(details.message); });
    await win.loadFile(page); const run = code => win.webContents.executeJavaScript(code), pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},testSavedViews=true,testAccessibility=true;
      var fixtureApiOverrides={getTorrentInfo:async()=>{throw Error('Torrent metadata is unavailable (NOT_ACTIVE)')},
        rss:{getFeeds:async()=>[{id:'feed',name:'Fixture feed',url:'https://fixture.invalid',enabled:true}],getRules:async()=>[],checkFeed:async()=>{throw Error('EACCES: permission denied, open C:/fixture')},getItems:async()=>[]}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      var Errors=load(path.join(fixtureRoot,'shared/user-errors.ts')).USER_ERRORS;
      var ErrorText=load(path.join(fixtureRoot,'renderer/components/ErrorMessage.tsx')).ErrorMessage;
      var Confirm=load(path.join(fixtureRoot,'renderer/components/ConfirmDialog.tsx')).ConfirmProvider;
      var NativeToast=packageRequire('react-hot-toast').toast,Toaster=load(path.join(fixtureRoot,'renderer/utils/hostToast.tsx')).HostToaster;
      var Download=load(path.join(fixtureRoot,'renderer/pages/DownloadItem.tsx')).DownloadItem;
      var DownloadRow={...fixtureRows[0],name:'Example download',status:'error',lastError:"Error invoking remote method 'downloads:resume': Error: ENOSPC: no space left on device, write"};
      var noop=()=>{};
      function mount(View,props={}){dom.flushSync(()=>tree.render(React.createElement(FixtureI18nProvider,null,React.createElement(Confirm,null,React.createElement(View,props)))));}
      function Downloads(){return React.createElement(Download,{download:DownloadRow,viewMode:'detailed',expanded:true,onPause:noop,onResume:noop,onRemove:noop,onStopSeeding:noop,onRetry:noop,onOpenFolder:noop,onShowFiles:noop});}
      function language(next){dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/'+next+'.json'),'utf8'));fixtureSetLanguage(next);}
      true;`);
    const checks = [], check = async (label, expression) => {
      for (let i = 0; i < 70; i++) { if (await run(expression)) { checks.push(label); console.log('PASS ' + label); return; } await pause(); }
      throw Error(label + ': ' + await run('document.body.innerText.slice(-2000)'));
    };
    const capture = async name => {
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await pause();
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await run('mount(Downloads);true;');
    await check('Saved download failure is explained in Russian without IPC noise', `document.body.innerText.includes(Errors.diskFull[0])&&!document.body.innerText.includes('ENOSPC')&&!document.body.innerText.includes('Error invoking')`);
    assert.equal(await run(`DownloadRow.lastError.includes('ENOSPC')`), true, 'presentation must not modify the saved error');
    await run(`document.querySelector('.user-error-details').open=true;true;`);
    await check('Original diagnostic text is available on demand', `document.body.innerText.includes('ENOSPC')`);
    await run(`document.querySelector('.user-error-details').open=false;language('en');true;`);
    await check('An already visible download error follows language changes', `document.body.innerText.includes(Errors.diskFull[1])&&!document.body.innerText.includes(Errors.diskFull[0])`);
    await capture('download-error-en.png');
    await run(`language('ru');var Files=load(path.join(fixtureRoot,'renderer/components/TorrentFileSelector.tsx')).TorrentFileSelector;mount(Files,{magnetUri:'magnet:?xt=urn:btih:'+'a'.repeat(40),onCancel:noop,onConfirm:async()=>{}});true;`);
    await check('Metadata failure offers a translated cause and the existing next action', `document.body.innerText.includes(Errors.metadata[0])&&[...document.querySelectorAll('button')].some(n=>n.textContent.includes(t('filePicker.addAnyway')))`);
    await run(`mount(Toaster);NativeToast.error("Error invoking remote method 'rooms:create': Error: mysteryInternalException at privateFunction",{duration:Infinity});true;`);
    await check('Global error toasts give an honest fallback with collapsed details', `document.body.innerText.includes(Errors.unexpected[0])&&!document.body.innerText.includes('mysteryInternalException')`);
    await run(`language('en');true;`);
    await check('Existing global toasts also switch language', `document.body.innerText.includes(Errors.unexpected[1])`);
    await run(`NativeToast.removeAll();language('ru');var RSS=load(path.join(fixtureRoot,'renderer/pages/RSSPage.tsx')).default;mount(RSS);true;`);
    await check('RSS fixture has loaded', `!!document.querySelector('.feed-card')`);
    await run(`document.querySelector('.feed-card .btn').click();true;`);
    await check('Real RSS error confirmation explains access denial', `!!document.querySelector('[role=dialog]')&&document.body.innerText.includes(Errors.permission[0])&&!document.body.innerText.includes('EACCES')`);
    assert.equal(await run(`document.querySelector('[role=dialog] .user-error-details pre').textContent.includes('EACCES')`), true);
    await run(`language('en');true;`);
    await check('An open error confirmation switches language including its title', `document.querySelector('[role=dialog]').innerText.includes(Errors.permission[1])&&document.querySelector('[role=dialog] .um-title').textContent===t('rss.error.title')`);
    win.setContentSize(440, 850); await pause();
    await check('Long translated errors fit a narrow window', `document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[role=dialog]').getBoundingClientRect().right<=innerWidth`);
    await capture('permission-narrow-en.png');
    await run(`document.querySelector('.user-error-details').open=true;true;`);
    await check('Expanded diagnostics also fit the narrow window', `document.documentElement.scrollWidth<=innerWidth`);
    await run(`mount(ErrorText,{error:'HTTP 503 <img src=x onerror=window.injected=true>',details:true});true;`);
    await check('Upstream markup is rendered as text, not HTML', `!document.querySelector('.user-error-message img')&&window.injected!==true&&document.body.innerText.includes(Errors.remoteServer[1])`);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'ui-report.json'), JSON.stringify({ passed: true, fixtureApi: true, checks }, null, 2));
    clearTimeout(deadline); await run('tree.unmount();true;'); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
