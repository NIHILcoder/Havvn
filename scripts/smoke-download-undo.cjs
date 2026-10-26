// Real session journal + trusted IPC + production preload, then real App/rows/notice/confirm controls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-undo-ui-'));
  const env = { ...process.env, HAVVN_UNDO_SCRATCH: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
    const target = path.resolve(scratch);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-undo-ui-')) throw Error('Unexpected undo fixture path');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const scratch = path.resolve(process.env.HAVVN_UNDO_SCRATCH || ''), root = path.resolve(__dirname, '..'), output = path.join(root, 'dist/download-undo-ui');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('havvn-undo-ui-')) throw Error('Missing isolated undo profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Undo UI deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const compiled = path.join(root, 'dist/electron');
    const { registerDownloadRemovalIpc } = require(path.join(compiled, 'electron/ipc/download-removal.js'));
    const { DownloadUndoFailure, restoreDownloadInMap } = require(path.join(compiled, 'shared/download-removal.js'));
    const settings = require(path.join(compiled, 'electron/db/store.js')).readSettingsImportState();
    const base = { sourceType: 'magnet', sourceUri: 'PRIVATE_SOURCE', torrentFilePath: null, savePath: 'D:/Downloads', status: 'paused',
      progress: .4, totalSize: 1024, downloadedBytes: 400, uploadedBytes: 10, downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0,
      priority: 2, category: null, createdAt: new Date(10), updatedAt: new Date(20), lastError: null };
    const records = Object.fromEntries([1, 2, 3, 4].map(i => ['row-' + i, { ...base, id: 'row-' + i, sourceUri: 'PRIVATE_SOURCE_' + i, name: 'Фильм ' + i + '.mkv' }]));
    let mainWindow, delayed = false, finishRestore, failRestore = false, failRemove = null, restoreCalls = 0;
    const engine = {
      captureDownloadRemoval: async id => ({ download: structuredClone(records[id]), signature: 'PRIVATE_SIGNATURE', metadata: 'PRIVATE_METADATA', files: [], existingFiles: [] }),
      removeDownload: async id => { if (id === failRemove) throw Error('Synthetic remove failure'); delete records[id]; },
      restoreRemovedDownload: async snapshot => {
        restoreCalls++; if (delayed) await new Promise(resolve => { finishRestore = resolve; });
        if (failRestore) throw new DownloadUndoFailure('files-missing');
        restoreDownloadInMap(records, snapshot.download, []); return { warnings: [] };
      },
      activateRestoredDownload: async () => {},
    };
    const registered = registerDownloadRemovalIpc(() => mainWindow, engine, async () => []);
    ipcMain.handle('downloads:remove', (event, id, deleteFiles) => { registered.trusted(event); return registered.journal.remove(id, deleteFiles); });
    ipcMain.handle('downloads:get', () => structuredClone(Object.values(records)));
    const page = path.join(scratch, 'ipc.html'); fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><body>Undo IPC fixture</body>');
    mainWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(compiled, 'electron/preload.js') } });
    await mainWindow.loadFile(page);
    let run = code => mainWindow.webContents.executeJavaScript(code);
    const checks = [], check = async (label, predicate) => {
      for (let n = 0; n < 50; n++) { if (await predicate()) { checks.push(label); console.log('PASS ' + label); return; } await new Promise(resolve => setTimeout(resolve, 70)); }
      throw Error(label);
    };
    const result = await run(`window.api.removeDownload('row-1', false)`);
    assert(result.undo); assert(!JSON.stringify(result).includes('PRIVATE'));
    delayed = true;
    await run(`window.undos=0;window.offUndo=window.api.onDownloadUndoChanged(()=>window.undos++);window.pendingUndo=window.api.undoDownloadRemoval(${JSON.stringify(result.undo.token)});true;`);
    await check('Production preload reports an active restore', async () => (await run('window.api.getDownloadUndo()')).items[0].status === 'restoring');
    await run(`window.secondUndo=window.api.undoDownloadRemoval(${JSON.stringify(result.undo.token)});true;`);
    assert.equal(restoreCalls, 1); delayed = false; finishRestore();
    assert((await run('window.pendingUndo')).success); assert((await run('window.secondUndo')).success); assert.equal(restoreCalls, 1);
    await check('Preload subscription confirms one idempotent restoration', async () => await run('undos > 0'));
    assert.equal((await run(`window.api.removeDownload('row-2', true)`)).undo, null);
    checks.push('File deletion has no undo');
    await run('window.offUndo();true;'); mainWindow.destroy();
    const css = require('./smoke-ui-fonts.cjs')(root) + ['renderer/styles/variables.css', 'renderer/styles/base.css', 'renderer/styles/components.css',
      'renderer/styles/layout.css', 'renderer/styles/appearance.css', 'renderer/pages/DownloadsPage.css', 'renderer/pages/DownloadViewsBar.css',
      'renderer/components/Modal.css', 'renderer/components/Select.css', 'renderer/components/DownloadUndoNotice.css', 'renderer/components/Toast.css']
      .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const ui = path.join(scratch, 'ui.html'); fs.writeFileSync(ui, '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' + css + '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>');
    mainWindow = new BrowserWindow({ show: false, width: 1280, height: 940, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    const errors = []; mainWindow.webContents.on('console-message', message => { if (message.level === 'error') { errors.push(message.message); console.error('Renderer:', message.message); } });
    await mainWindow.loadFile(ui); run = code => mainWindow.webContents.executeJavaScript(code);
    await run(`var fixtureRoot=${JSON.stringify(root)},settingsFixture=${JSON.stringify(settings)},testSavedViews=true,testDownloadUndo=true;
      var ipc=require('electron').ipcRenderer,fixtureApiOverrides={getDownloads:()=>ipc.invoke('downloads:get'),removeDownload:(id,files)=>ipc.invoke('downloads:remove',id,files),
      getDownloadUndo:()=>ipc.invoke('downloads:undo:list'),undoDownloadRemoval:token=>ipc.invoke('downloads:undo',token),onDownloadUndoChanged:fn=>{var listener=()=>fn();ipc.on('downloads:undo:changed',listener);return()=>ipc.removeListener('downloads:undo:changed',listener)}};
      ${fs.readFileSync(path.join(__dirname, 'fixtures/command-palette-ui.cjs'), 'utf8')}
      function button(key,scope=document){return [...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===t(key));}
      function row(id){return document.querySelector('[data-download-id="'+id+'"]');}
      function detail(id){row(id).querySelector('.trow-main')?.click();}
      function navigate(key){[...document.querySelectorAll('.sidebar button')].find(node=>node.getAttribute('aria-label')===t(key)).click();}
      void 0;`);
    await check('Actual App renders shared download records', () => run(`!!row('row-3')&&!!row('row-4')`));
    await run(`detail('row-3')`); await new Promise(resolve => setTimeout(resolve, 100));
    await run(`row('row-3').querySelector('.download-item').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:200}))`);
    await check('Row context menu exposes removal', () => run(`!![...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.trim()===t('downloads.remove'))`));
    await run(`[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.trim()===t('downloads.remove')).click()`);
    await check('Removing the entry uses the shared confirmation', () => run(`!!document.querySelector('.um-card')`));
    await run(`button('common.confirm',document.querySelector('.um-card')).click()`);
    await check('Row removal offers a themed undo action', () => run(`!row('row-3')&&!!document.querySelector('[data-undo-status="available"]')`));
    assert.equal(records['row-3'], undefined);
    await run(`navigate('nav.search')`);
    await check('Undo remains available after navigating away', () => run(`!document.querySelector('.downloads-list')&&!!document.querySelector('[data-undo-status="available"] button')`));
    failRestore = true; await run(`document.querySelector('[data-undo-status="available"] button').click()`);
    await check('Missing data gives a retryable failure without a false restored record', () => run(`!!document.querySelector('[data-undo-status="failed"]')&&document.body.textContent.includes(t('undo.error.files-missing'))`));
    assert.equal(records['row-3'], undefined); failRestore = false;
    delayed = true; await run(`document.querySelector('[data-undo-status="failed"] button').click()`);
    await check('Repeated restore is blocked while the owner works', () => run(`document.querySelector('[data-undo-status="restoring"] button')?.disabled===true`));
    delayed = false; finishRestore();
    await check('Restoration succeeds from another page', () => run(`!!document.querySelector('[data-undo-status="restored"]')`));
    assert(records['row-3']);
    await run(`document.querySelector('.pillar-btn').click()`);
    await check('Restored record returns with the same ID', () => run(`!!row('row-3')`));
    failRemove = 'row-4';
    await run(`dom.flushSync(()=>{for (const id of ['row-1','row-4'])row(id).querySelector('.download-checkbox').click();});document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));`);
    await check('Batch deletion uses the real confirmation', () => run(`!!document.querySelector('.um-card')`));
    await run(`button('common.confirm',document.querySelector('.um-card')).click()`);
    await check('A failed batch member remains selected and has an explicit error', () => run(`!!row('row-4')&&row('row-4').querySelector('.download-checkbox').checked&&!row('row-1')&&document.body.textContent.includes(t('undo.batchFailed').replace('{count}','1'))`));
    await check('Failure toasts remain visible above the undo notice', () => run(`(()=>{const toast=document.querySelector('.toast-container').getBoundingClientRect();const undo=document.querySelector('.download-undo-notice').getBoundingClientRect();return toast.bottom<=undo.top})()`));
    const capture = async name => {
      await mainWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(output, name), (await mainWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    };
    await capture('wide.png'); mainWindow.setSize(520, 900);
    await check('Undo notice fits a narrow window', () => run(`(()=>{const box=document.querySelector('.download-undo-notice').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1})()`));
    await capture('narrow.png');
    await run(`dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'renderer/i18n/en.json'),'utf8'));fixtureSetLanguage('en');true;`);
    await check('English strings are present without raw translation keys', () => run(`document.querySelector('.download-undo-notice').textContent.includes('Removed from the list')&&!document.body.textContent.includes('undo.error.')`));
    assert.deepEqual(errors, []); registered.dispose(); await run('tree.unmount();true;'); mainWindow.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output })); clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
