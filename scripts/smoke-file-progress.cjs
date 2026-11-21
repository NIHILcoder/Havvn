// Real FilePreview + Downloads store in Chromium; IPC responses are controlled.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist/download-progress');
  fs.mkdirSync(out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-file-progress-'));
  app.setPath('userData', path.join(temp, 'profile')); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('File progress deadline:', out); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1240, height: 900, webPreferences: {
      nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false,
    } });
    const errors = [], checks = [];
    win.webContents.on('console-message', details => {
      if (details.level === 'error' && !details.message.includes('fixture-file-read-failed')) errors.push(details.message);
    });
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css', 'renderer/pages/DownloadsPage.css', 'renderer/components/HealthBadge.css',
      'renderer/components/Modal.css', 'renderer/components/FilePreview.css', 'renderer/styles/base.css',
      'renderer/styles/layout.css', 'renderer/styles/components.css', 'renderer/styles/appearance.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(temp, 'progress.html');
    fs.writeFileSync(html, `<html data-theme="light" data-material="solid"><meta charset="utf-8"><style>${css}
      #root{height:100dvh}*{animation:none!important;transition:none!important}</style><div id="root"></div><div id="preview"></div></html>`);
    await win.loadFile(html);
    const run = expression => win.webContents.executeJavaScript(typeof expression === 'function' ? '(' + expression.toString() + ')()' : expression);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = (label, value) => { checks.push(label); assert.equal(value, true, label); };
    const until = async (label, expression) => {
      for (let attempt = 0; attempt < 60; attempt++) { if (await run(expression)) { check(label, true); return; } await pause(50); }
      assert.fail(label);
    };
    const capture = async name => {
      for (let attempt = 0; ; attempt++) {
        win.webContents.invalidate(); await pause(200);
        try { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); return; }
        catch (error) { if (attempt >= 2 || !String(error).includes('UnknownVizError')) throw error; }
      }
    };
    await run('var fixtureRoot=' + JSON.stringify(root) + ';\n' + fs.readFileSync(path.join(__dirname, 'fixtures/download-layout-ui.cjs'), 'utf8') + '\nvoid 0;');
    await run(() => {
      window.fileRows = [
        { name: 'autorun.inf', path: 'Pack/autorun.inf', length: 61, downloaded: -1465635, progress: -24026.8 },
        { name: 'data1.bin', path: 'Pack/data1.bin', length: 4194304, downloaded: 524288, progress: 0.125 },
        { name: 'data2.bin', path: 'Pack/data2.bin', length: 1048576, downloaded: 0, progress: 0 },
      ];
      window.filePulls = 0; window.activeReads = 0; window.maxReads = 0; window.holdNext = false; window.failNext = false;
      api.getTorrentFiles = async id => {
        filePulls++; activeReads++; maxReads = Math.max(maxReads, activeReads);
        const result = fileRows.map(file => ({ ...file, name: id === 'new' ? 'new-' + file.name : file.name }));
        try {
          if (holdNext) { holdNext = false; await new Promise(resolve => window.finishRead = resolve); }
          if (failNext) { failNext = false; throw Error('fixture-file-read-failed'); }
          return result;
        } finally { activeReads--; }
      };
      window.Preview = load(path.join(fixtureRoot, 'renderer/components/FilePreview.tsx')).FilePreview;
      window.previewTree = createRoot(document.querySelector('#preview'));
      window.preview = id => dom.flushSync(() => previewTree.render(React.createElement(Preview, { downloadId: id, onClose: () => dom.flushSync(() => previewTree.render(null)) })));
      window.previewText = () => document.querySelector('#preview').textContent;
      window.filePercent = name => [...document.querySelectorAll('.fp-item')].find(item => item.querySelector('.fp-item-name').textContent === name)?.querySelector('.fp-item-pct').textContent;
      window.applyTheme = mode => {
        const palette = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'themes/nihil-aero-midnight.havvn-theme.json'), 'utf8'))[mode];
        document.documentElement.style.cssText = ''; for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value);
        document.documentElement.dataset.theme = mode;
      };
      applyTheme('light'); preview('old');
    });
    await until('Negative tiny-file counter is rendered safely', () => filePercent('autorun.inf') === '0%');
    check('No NaN, undefined or negative percentage', await run(() => !/NaN|undefined|-\d+%/.test(previewText())));
    await capture('files-downloading-wide');
    await run(() => { fileRows[0].downloaded = 61; fileRows[1].downloaded = 2097152; });
    await until('Open dialog updates tiny-file and total progress', () => filePercent('autorun.inf') === '100%' && document.querySelector('.fp-chip--progress').textContent.includes('40.0%'));
    await run(() => { holdNext = true; maxReads = 0; });
    await until('Slow request started', () => activeReads === 1);
    await pause(2200);
    check('Slow IPC never overlaps polling requests', await run(() => activeReads === 1 && maxReads === 1));
    await run(() => { failNext = true; finishRead(); });
    await until('Refresh failure keeps the file list visible', () => !!document.querySelector('#preview [role="status"]') && document.querySelectorAll('.fp-item').length === 3);
    await until('Polling recovers automatically', () => !document.querySelector('#preview [role="status"]') && !!document.querySelector('.fp-list'));
    await run(() => { holdNext = true; }); await until('Old-id request held', () => activeReads === 1);
    await run(() => { preview('new'); });
    await until('Changing download loads its own files', () => filePercent('new-autorun.inf') === '100%');
    await run(() => finishRead()); await pause(100);
    check('Old request cannot overwrite another download', await run(() => filePercent('new-autorun.inf') === '100%' && filePercent('autorun.inf') === undefined));
    await run(() => preview('old'));
    await until('Original download can be reopened', () => filePercent('autorun.inf') === '100%');
    await run(() => { fileRows.forEach(file => file.downloaded = file.length); });
    await until('All files and total reach 100%', () => [...document.querySelectorAll('.fp-item-pct')].every(item => item.textContent === '100%') && document.querySelector('.fp-chip--progress').textContent.includes('100.0%'));
    await capture('files-complete-wide');
    win.setSize(680, 900); await pause(150); await run(() => applyTheme('dark')); await capture('files-complete-narrow');
    check('Dialog fits narrow window', await run(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    await run(() => dom.flushSync(() => previewTree.render(null)));
    const closedPulls = await run(() => filePulls); await pause(1200);
    check('Closing dialog stops file requests', await run(() => filePulls) === closedPulls);
    check('No renderer errors', errors.length === 0);
    fs.writeFileSync(path.join(out, 'ui-report.json'), JSON.stringify({ ok: true, checks, errors }, null, 2));
    console.log('PASS: live file progress, finite values, async races, completion and close cleanup (' + checks.length + ' checks): ' + out);
    clearTimeout(deadline); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error.stack || error); clearTimeout(deadline); app.exit(1); });
}
