// Exercise the real DownloadsPage and TanStack virtualizer with Chromium layout.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, windowsHide: true, stdio: 'inherit',
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), probe = process.argv.includes('--probe');
  const out = path.join(root, 'dist/download-layout'); fs.mkdirSync(out, { recursive: true });
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-download-layout-'));
  app.setPath('userData', path.join(temp, 'profile'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('Download layout deadline:', temp); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: {
      nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false,
    } });
    const errors = [], checks = [];
    win.webContents.on('console-message', details => {
      if (details.level === 'error') { errors.push(details.message); console.error('Renderer:', details.message); }
    });
    const css = require('./smoke-ui-fonts.cjs')(root) + [
      'renderer/styles/variables.css', 'renderer/pages/DownloadsPage.css', 'renderer/components/HealthBadge.css',
      'renderer/styles/base.css', 'renderer/styles/layout.css', 'renderer/styles/components.css', 'renderer/styles/appearance.css',
      'renderer/pages/DownloadViewsBar.css', 'renderer/components/Select.css', 'renderer/components/Modal.css',
    ].map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^@import[^;]+;/gm, '')).join('\n');
    const html = path.join(temp, 'layout.html');
    fs.writeFileSync(html, `<html data-theme="dark" data-material="glass"><meta charset="utf-8"><style>${css}
      #root{height:100dvh}*{animation:none!important;transition:none!important}</style><div id="root"></div></html>`);
    await win.loadFile(html);
    const run = async code => {
      const source = typeof code === 'function' ? '(' + code.toString() + ')()' : code;
      try { return await win.webContents.executeJavaScript(source); }
      catch (error) { console.error('UI step:', source.slice(0, 240)); throw error; }
    };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    await run('var fixtureRoot=' + JSON.stringify(root) + ';\n' + fs.readFileSync(path.join(__dirname, 'fixtures/download-layout-ui.cjs'), 'utf8') + '\nvoid 0;');
    const check = (label, result, details) => {
      checks.push({ label, ok: !!result, ...(result ? {} : { details }) });
      if (!result && !probe) assert.fail(label + ': ' + JSON.stringify(details));
    };
    const geometry = async label => {
      await pause(250);
      const state = await run('layout()');
      const misplaced = state.rows.filter((row, i) => i > 0 && Math.abs(row.top - state.rows[i - 1].bottom) > 1);
      check(label, state.rows.length > 0 && misplaced.length === 0, state);
      return state;
    };
    const compact = async label => {
      const state = await geometry(label + ' geometry');
      check(label + ' collapsed', state.compact && state.rows.every(row => !row.detailed), state);
    };
    const detailed = async label => {
      const state = await geometry(label + ' geometry');
      check(label + ' expanded', !state.compact && state.rows.every(row => row.detailed), state);
    };
    const capture = async name => {
      win.webContents.invalidate(); await pause(100);
      fs.writeFileSync(path.join(out, (probe ? 'before-' : '') + name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    for (let attempts = 0; attempts < 50 && !(await run('layout().rows.length')); attempts++) await pause(100);
    await compact('Initial compact list');
    check('Wide view toolbar uses one row', await run(() => {
      const select = document.querySelector('.download-views-select .custom-select-trigger');
      const actions = [...document.querySelectorAll('.download-views-toolbar > .btn')];
      return !!select && actions.length > 0 && actions.every(button => Math.abs(button.getBoundingClientRect().top - select.getBoundingClientRect().top) < 1);
    }));
    check('View selector matches the action height', await run(() => {
      const select = document.querySelector('.download-views-select .custom-select-trigger');
      const button = document.querySelector('.download-views-toolbar > .btn');
      return !!select && !!button && Math.abs(select.getBoundingClientRect().height - button.getBoundingClientRect().height) < 1;
    }));
    await run('expand(0);expand(1);expand(2)');
    const manual = await geometry('Three manually expanded rows');
    check('Only the chosen rows expand manually', manual.rows.every(row => row.detailed === (row.index < 3)), manual);
    await capture('manually-expanded');
    await run('mode("detailed")'); await detailed('Manual expansion to detailed'); await capture('detailed-wide');
    await run('mode("compact")'); await compact('Return to compact'); await capture('compact-wide');
    if (!probe) {
      check('No redundant refresh button', await run(() => ![...document.querySelectorAll('.page-actions [title]')]
        .some(button => button.title === t('downloads.refresh'))));
      await run('expand(0);toggleModeKey()'); await detailed('Keyboard to detailed');
      await run('toggleModeKey()'); await compact('Keyboard to compact');
      await run('expand(0);mode("compact")'); await compact('Clicking compact collapses manual rows');
      await run('pushStats()'); await geometry('Live stats update');
      check('Live progress appears automatically', await run(() => document.querySelector('.downloads-vrow[data-index="0"]').textContent.includes('73.0%')));
      await run('mode("detailed");scrollList(12000)'); await detailed('Detailed list scrolled');
      check('List remains virtualized', await run('layout().rows.length < fixtureRows.length && layout().rows[0].index > 0'));
      await run('mode("compact")'); await compact('Compact after scrolling');
      await run('scrollList(0)'); await compact('Return to previously measured rows');
      win.setSize(680, 860); await geometry('Resize to narrow list');
      await run('expand(0);expand(1);mode("detailed")'); await detailed('Narrow detailed after manual expansion');
      await capture('detailed-narrow');
      await run('longError()'); await geometry('Error text changes row height');
      await run('removeFirst()'); await geometry('Removing a measured row');
      await run('mode("compact")'); await compact('Narrow compact'); await capture('compact-narrow');
      for (let cycle = 0; cycle < 3; cycle++) {
        await run('expand(0);mode("detailed")'); await detailed('Repeated detailed ' + cycle);
        await run('mode("compact")'); await compact('Repeated compact ' + cycle);
      }
      // The header does not need manual refresh: a push updates live stats,
      // and the shared store also reconciles the complete list every 5 seconds.
      const pullsBefore = await run('pulls');
      for (let attempt = 0; attempt < 55 && await run('pulls') <= pullsBefore; attempt++) await pause(100);
      check('Automatic list reconciliation stays active', await run('pulls') > pullsBefore);
      win.setSize(1280, 860);
      await run('mode("detailed");scrollList(0);pushOperation({stage:"metadata"})');
      await geometry('Metadata wait changes measured row height');
      check('Metadata has an explanation and an indeterminate accessible progress bar', await run(() => {
        const row = document.querySelector('.downloads-vrow');
        return row.textContent.includes(t('operation.wait.metadata-peers')) && !row.querySelector('[role=progressbar]').hasAttribute('aria-valuenow');
      }));
      await capture('operations-metadata');
      await run('pushOperation({stage:"checking",fraction:.23},"completed")');
      await geometry('Measured Native check');
      check('Check progress replaces old file completion', await run(() => {
        const row = document.querySelector('.downloads-vrow');
        return row.textContent.includes('23.0%') && row.querySelector('[role=progressbar]').getAttribute('aria-valuenow') === '23';
      }));
      await run('pushOperation({stage:"checking"},"completed")');
      await geometry('Unmeasured Classic check');
      check('An unmeasured check does not display the file percentage', await run(() => !document.querySelector('.downloads-vrow [role=progressbar]').hasAttribute('aria-valuenow')));
      await capture('operations-checking');
      win.setSize(520, 860); await geometry('Narrow operation explanation');
      check('Operation details fit a narrow row', await run(() => {
        const row = document.querySelector('.downloads-vrow'); return row.scrollWidth <= row.clientWidth + 1;
      }));
      await capture('operations-narrow');
    }
    check('No renderer errors', errors.length === 0, errors);
    const report = { ok: checks.every(check => check.ok), probe, checks, errors };
    fs.writeFileSync(path.join(out, probe ? 'before-report.json' : 'report.json'), JSON.stringify(report, null, 2));
    console.log('Download layout ' + (probe ? 'probe' : 'regression') + ': ' + JSON.stringify({ ok: report.ok, checks: checks.length, failures: checks.filter(check => !check.ok).map(check => check.label), out }));
    clearTimeout(deadline); win.destroy(); app.exit(report.ok || probe ? 0 : 1);
  }).catch(error => { console.error(error); console.error('Fixture output:', out); clearTimeout(deadline); app.exit(1); });
}
