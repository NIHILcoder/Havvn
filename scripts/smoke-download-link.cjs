// Actual App, DownloadsPage and confirmation dialogs; API boundaries use fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-download-link-'));
  const output = path.join(root, 'dist/download-link-ui'); fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Download link UI deadline'); app.exit(1); }, 60_000);
  app.whenReady().then(async () => {
    const settings = require(path.join(root, 'dist/electron/electron/db/store.js')).readSettingsImportState();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/DownloadsPage.css', 'renderer/pages/DownloadViewsBar.css',
      'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/Toast.css', 'renderer/components/TorrentFileSelector.css',
      'renderer/components/SelectionCheckbox.css', 'renderer/components/DownloadDefaultsPreview.css', 'renderer/components/AddDownloadsModal.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const page = path.join(scratch, 'index.html');
    fs.writeFileSync(page, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>');
    const win = new BrowserWindow({ show: false, width: 1280, height: 940, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith('Failed to load torrent info:')) { errors.push(details.message); console.error('Renderer:', details.message); } });
    await win.loadFile(page); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const run = async code => { try { return await win.webContents.executeJavaScript(code); } catch (error) { console.error('UI step:', code.slice(0, 250)); throw error; } }, wait = () => new Promise(resolve => setTimeout(resolve, 80));
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},testSavedViews=true,testDownloadUndo=true;
      var linkRecords={},linkCalls=[],previewMode='ready',holdAdd=false,finishAdd,failAdd=false;
      var fixtureApiOverrides={getDownloads:async()=>Object.values(linkRecords),getDownloadUndo:async()=>({revision:0,items:[]}),
        onDownloadUndoChanged:()=>()=>{},selectDirectory:async()=>'D:/fixture-target',
        getTorrentInfo:async p=>{linkCalls.push(['preview',p]);if(previewMode==='error')throw Error('Fixture metadata timeout');return{name:'fixture.bin',totalSize:64,files:[{index:0,path:'fixture.bin',size:64}]};},
        addDownload:async request=>{linkCalls.push(['add',request]);if(holdAdd)await new Promise(resolve=>finishAdd=resolve);if(failAdd)throw Error('Fixture add failure');
          var id='link-'+(Object.keys(linkRecords).length+1),record={...fixtureRows[0],id,name:'fixture.bin',sourceType:request.sourceType,sourceUri:request.sourceUri,savePath:request.savePath||'D:/fixture-default',progress:0,status:'paused'};
          linkRecords[id]=record;return record;}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      cache[path.join(fixtureRoot,'renderer/components/index.ts')]={exports:components};
      components.TorrentFileSelector=load(path.join(fixtureRoot,'renderer/components/TorrentFileSelector.tsx')).TorrentFileSelector;
      function button(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim().startsWith(t(key).split('{count}')[0]));}
      function linkInput(value){var input=document.querySelector('.add-downloads textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}
      true;`);
    const checks = [], check = async (label, predicate) => {
      for (let n = 0; n < 80; n++) { if (await run(predicate)) { checks.push(label); console.log('PASS', label); return; } await wait(); }
      throw Error(label + ': ' + await run('document.body.innerText.slice(-1500)'));
    };
    const click = async key => { await run(`button(${JSON.stringify(key)}).click()`); await wait(); };
    const open = async () => { await click('downloads.add'); await check('Source queue opens with keyboard focus', `document.activeElement===document.querySelector('.add-downloads textarea')`); };
    const capture = async name => {
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await wait();
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    const pickerAligned = `(() => {
      const picker = document.querySelector('.tfs-body');
      const defaults = picker.querySelector('.download-defaults-preview').getBoundingClientRect();
      const search = picker.querySelector('.search-box').getBoundingClientRect();
      const scope = picker.querySelector('.tfs-selection-scope > label').getBoundingClientRect();
      const left = picker.getBoundingClientRect().left + picker.clientLeft;
      const inset = search.left - left;
      return inset > 0 && Math.abs(defaults.left - search.left) < 1
        && Math.abs(scope.left - search.left) < 1
        && Math.abs(left + picker.clientWidth - defaults.right - inset) < 1
        && picker.scrollWidth <= picker.clientWidth + 1;
    })()`;
    await check('Actual DownloadsPage exposes an explicit add-link button', `!!document.querySelector('.add-download-link-btn')`);
    await open(); await click('common.cancel');
    assert.equal(await run('linkCalls.length'), 0);
    await open(); await run(`linkInput('not a link')`); await wait();
    await check('Invalid links stay inline and never reach the API', `document.querySelector('.add-downloads-row small')?.textContent===t('downloads.queue.invalid')&&button('downloads.queue.continue').disabled&&linkCalls.length===0`);
    const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Fixture';
    await run(`linkInput(${JSON.stringify(magnet)})`); await wait();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await check('Enter permits another link without starting a download', `!!document.querySelector('.add-downloads textarea')&&linkCalls.length===0`);
    await click('downloads.queue.continue');
    await check('Continue opens the real file selector without adding yet', `!!document.querySelector('.file-selector-stats')&&linkCalls.filter(c=>c[0]==='add').length===0`);
    await capture('file-picker-wide.png');
    await check('Defaults, search and selection scope use the same inset', pickerAligned);
    assert.deepEqual(await run(`linkCalls.find(c=>c[0]==='preview')[1]`), { magnetUri: magnet, torrentPath: undefined });
    await click('settings.choose');
    await run(`holdAdd=true;button('filePicker.downloadSelected').click();button('filePicker.downloadSelected').click()`); await wait();
    assert.equal(await run(`linkCalls.filter(c=>c[0]==='add').length`), 1);
    assert.equal(await run(`button('filePicker.downloadSelected').disabled`), true);
    await run('holdAdd=false;finishAdd()');
    await check('Confirmed magnet reaches the download list', `!!document.querySelector('[data-download-id="link-1"]')&&!document.querySelector('[role=dialog]')`);
    assert.deepEqual(await run(`linkCalls.find(c=>c[0]==='add')[1]`), { sourceType: 'magnet', sourceUri: magnet, selectedFiles: [0], name: 'fixture.bin', savePath: 'D:/fixture-target', categoryId: undefined, paused: undefined });
    await open(); await run(`previewMode='error';linkInput(${JSON.stringify(magnet.replace('Fixture','NoMetadata'))})`); await wait(); await click('downloads.queue.continue');
    await check('Metadata failure offers the existing add-anyway path', `!!document.querySelector('.file-selector-error')&&!!button('filePicker.addAnyway')`);
    await run(`failAdd=true`); await click('filePicker.addAnyway');
    await check('Rejected addition preserves confirmation for a retry', `!!document.querySelector('.file-selector-error')&&document.body.textContent.includes(load(path.join(fixtureRoot,'renderer/utils/error-messages.ts')).readableError('Fixture add failure','ru'))`);
    await run(`failAdd=false`); await click('filePicker.addAnyway');
    await check('A magnet can be added without metadata', `!!linkRecords['link-2']&&!document.querySelector('[role=dialog]')`);
    await check('Unknown metadata does not report zero selected files', `document.body.textContent.includes(t('downloads.downloadAddedAllFiles'))`);
    assert.deepEqual(await run(`linkCalls.filter(c=>c[0]==='add').at(-1)[1].selectedFiles`), []);
    await open(); await run(`previewMode='ready';linkInput('https://example.test/download?id=1')`); await wait(); await click('downloads.queue.continue');
    await check('Torrent URL is passed as torrentPath', `linkCalls.filter(c=>c[0]==='preview').at(-1)[1].torrentPath==='https://example.test/download?id=1'`);
    await click('filePicker.downloadSelected');
    await check('Torrent URL uses the torrent-file add contract', `linkRecords['link-3']?.sourceType==='torrent_file'&&linkRecords['link-3']?.sourceUri==='https://example.test/download?id=1'`);
    await run(`document.querySelectorAll('.toast-close').forEach(button=>button.click());true;`); await wait();
    await open(); await capture('add-link-wide.png'); win.setSize(520, 820); await wait();
    await check('Add-link dialog fits a narrow window', `document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[role=dialog]').getBoundingClientRect().right<=innerWidth`);
    await capture('add-link-narrow.png'); await click('common.cancel');
    await run(`document.documentElement.dataset.theme='light';true;`);
    await open(); await run(`linkInput(${JSON.stringify(magnet)})`); await wait(); await click('downloads.queue.continue');
    await check('File picker keeps its insets in a narrow light window', pickerAligned);
    await capture('file-picker-narrow-light.png');
    await run(`document.querySelector('.download-defaults-preview summary').click();true;`); await wait();
    await check('Expanded defaults preserve the file picker alignment', pickerAligned);
    await click('common.cancel');
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');true;`); await wait();
    await open(); await check('English labels resolve', `document.querySelector('[role=dialog]').textContent.includes(t('downloads.queue.hint'))&&!document.body.textContent.includes('downloads.queue.')`);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, fixtureApi: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); await run('tree.unmount();true;'); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
