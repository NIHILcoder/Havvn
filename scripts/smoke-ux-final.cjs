// Production React surfaces in Electron; private temporary profile, synthetic data only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const prefix = 'havvn-ux-final-';
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), prefix)), env = { ...process.env, HAVVN_FINAL_FIXTURE: scratch }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Invalid temporary path'); fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
} else {
  const { app, BrowserWindow } = require('electron'), root = path.resolve(__dirname, '..'), scratch = path.resolve(process.env.HAVVN_FINAL_FIXTURE || ''), output = path.join(root, 'artifacts/ux-final-20261108');
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith(prefix)) throw Error('Missing temporary profile');
  app.setPath('userData', path.join(scratch, 'profile')); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Final UX UI deadline'); app.exit(1); }, 150000);
  let win;
  app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true }); const checks = [], errors = [];
    win = new BrowserWindow({ show: false, width: 1150, height: 900, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', e => { if (e.level === 'error') { errors.push(e.message); console.error('Renderer:', e.message); } });
    const run = code => win.webContents.executeJavaScript(typeof code === 'function' ? `(${code})()` : code, true), pause = (ms = 65) => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (name, code) => { for (let i = 0; i < 140; i++) { if (await run(code)) { checks.push(name); console.log('PASS:', name); return; } await pause(35); } throw Error(name + ': ' + await run(() => document.body.innerText.slice(-2000))); };
    const check = async (name, code) => { assert.equal(await run(code), true, name); checks.push(name); console.log('PASS:', name); };
    const click = async selector => { await run(`document.querySelector(${JSON.stringify(selector)}).click();true;`); await pause(); };
    const button = async key => { await run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===tr[${JSON.stringify(key)}]);if(!b)throw Error('Missing button '+${JSON.stringify(key)});b.click()})();true;`); await pause(); };
    const select = async (key, label) => { await click(`[role="combobox"][aria-label="${tr[key]}"]`); await run(`(()=>{const b=[...document.querySelectorAll('[role=option]')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing option');b.click()})();true;`); await pause(); };
    const capture = async name => { win.showInactive(); await pause(100); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); win.hide(); };
    const tr = JSON.parse(fs.readFileSync(path.join(root, 'renderer/i18n/ru.json'), 'utf8'));
    await win.loadFile(path.join(root, 'dist/ux-final-ui/index.html'));
    await run(`var tr=${JSON.stringify(tr)};function setText(el,value){Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await until('Source picker and presets load', () => !!document.querySelector('.ssp-tile') && document.querySelector('.screen-quality-presets').textContent.includes('Текст'));
    await check('Audio starts unchecked', () => !document.querySelector('.ssp-audio input').checked);
    await select('rooms.screen.resolution', '1440p'); await select('rooms.screen.frameRate', '30 FPS'); await select('rooms.screen.bitrate', '8 Мбит/с');
    await button('rooms.screen.preset.economy');
    await check('Economy displays exact bitrate in selector', () => document.querySelector('[data-screen-quality-summary]').textContent.includes('750') && [...document.querySelectorAll('[role=combobox]')].find(el=>el.getAttribute('aria-label')===tr['rooms.screen.bitrate']).textContent.includes('0,75'));
    await button('rooms.screen.preset.manual'); await check('Manual quality survives preset selection', () => document.querySelector('[data-screen-quality-summary]').textContent.includes('1440p · 30 FPS · 8000'));
    await button('rooms.screen.preset.text'); await check('Text preset does not enable audio', () => !document.querySelector('.ssp-audio input').checked && document.querySelector('[data-screen-quality-summary]').textContent.includes('4000'));
    await click('.ssp-tile'); await button('rooms.screen.start');
    await check('Start submits selected preset and separate audio consent', () => fixture.picks.length === 1 && fixture.picks[0][1] === false && fixture.picks[0][2].height === 1080 && fixture.picks[0][2].fps === 15);
    await capture('screen-presets');
    await run(() => fixture.mount('invitation')); await until('Device invitation loads', () => !!document.querySelector('.device-invitation'));
    await button('devices.invite.copy'); await check('Copy preserves exact invitation text', () => fixture.copied === fixture.invitation);
    await button('devices.invite.showQr'); await until('Local QR is rendered', () => document.querySelector('canvas')?.width === 560);
    // Compare all encoded modules with the library matrix for this exact invitation.
    const matrix = require('qrcode').create(await run(() => fixture.invitation), { errorCorrectionLevel: 'M' }).modules;
    await run(`var expectedQR=${JSON.stringify({ size: matrix.size, data: [...matrix.data] })};`);
    await check('QR modules encode the same invitation as the text', () => { const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), scale = canvas.width / (expectedQR.size + 2); for (let y = 0; y < expectedQR.size; y++) for (let x = 0; x < expectedQR.size; x++) { const pixel = ctx.getImageData(Math.round((x + 1.5) * scale), Math.round((y + 1.5) * scale), 1, 1).data[0]; if ((pixel < 128 ? 1 : 0) !== expectedQR.data[y * expectedQR.size + x]) return false; } return true; });
    await capture('device-invitation'); await run(() => { fixture.expiresAt = Date.now() + 400; fixture.repaint(); }); await pause(1300);
    await check('Expiry removes QR and secret text', () => !document.querySelector('canvas') && !document.querySelector('.device-invitation') && document.body.innerText.includes('истекло'));
    await run(() => fixture.mount('devices')); await until('Device exchange summary loads', () => !!document.querySelector('[data-device-exchange-summary]'));
    await check('Summary uses approved scopes, not wider draft configuration', () => { const s = document.querySelector('[data-device-exchange-summary]'); return s.textContent.includes('Интерфейс и плеер') && !s.textContent.includes('Сохранённые виды') && s.textContent.includes('Соединение само по себе'); });
    await run(() => { fixture.deviceState.lastApplied = { at: Date.now(), scope: 'preferences' }; fixture.deviceChanged(); });
    await until('Only confirmed application supplies synchronization time', () => !document.querySelector('[data-device-exchange-summary]').textContent.includes('Нет данных'));
    await capture('devices-summary');
    await run(() => fixture.mount('documents')); await until('Document catalog loads', () => !!document.querySelector('[data-docs-new]:not(:disabled)'));
    await click('[data-docs-new]'); await select('rooms.docs.template', tr['rooms.docs.template.meeting']);
    await check('Template inserts editable content and preserves visible writer selection', () => document.querySelector('[data-docs-initial-text]').value.includes('Решения') && document.querySelectorAll('.hd-create fieldset input:checked').length === 2);
    await run(() => document.querySelectorAll('.hd-create fieldset input')[1].click()); await pause();
    await click('[data-docs-document=note]'); await until('Existing document opens while new draft is retained', () => !!document.querySelector('[data-docs-buffer] .cm-editor'));
    await click('.hd-tab > button[aria-label]'); await click('[data-docs-new]');
    await check('Returning to new draft preserves selected writers and template', () => document.querySelectorAll('.hd-create fieldset input:checked').length === 1 && document.querySelector('[data-docs-initial-text]').value.includes('Решения'));
    await run(() => setText(document.querySelector('[data-docs-initial-text]'), 'Личный черновик')); await pause();
    await select('rooms.docs.template', tr['rooms.docs.template.tasks']); await until('Replacing edited template asks first', () => document.querySelectorAll('.um-backdrop').length === 2);
    await button('common.cancel'); await check('Cancel retains the edited text', () => document.querySelector('[data-docs-initial-text]').value === 'Личный черновик');
    await select('rooms.docs.template', tr['rooms.docs.template.tasks']); await button('common.confirm');
    await check('Confirmed replacement inserts task checklist', () => document.querySelector('[data-docs-initial-text]').value.includes('- [ ]'));
    await capture('document-templates');
    await click('.hd-modal .um-x'); await until('Closing a new document asks before discarding its draft', () => document.querySelectorAll('.um-backdrop').length === 2); await button('common.cancel');
    await check('Cancel close keeps draft and writer selection', () => document.querySelector('[data-docs-initial-text]').value.includes('- [ ]') && fixture.closed === 0);
    await run(() => { fixture.holdCreate = true; }); await button('rooms.docs.create');
    await until('Creation locks draft fields while awaiting confirmation', () => fixture.created.length === 1 && [...document.querySelectorAll('.hd-create input,.hd-create textarea,.hd-create [role=combobox]')].every(el => el.matches(':disabled')));
    await run(() => { fixture.holdCreate = false; fixture.releaseCreate(); }); await until('Creation passes initial text and explicit writers once', () => fixture.created.length === 1 && !!document.querySelector('[data-docs-buffer] .cm-editor'));
    await check('Created template remains editable ordinary text', () => fixture.templateText().includes('- [ ]') && fixture.created[0][4].length === 1);
    await run(() => { fixture.reader = true; fixture.mount('reader'); }); await until('Reader can request edit access', () => !!document.querySelector('[data-docs-access-request] button:not(:disabled)'));
    await button('rooms.docs.requestAccess'); await until('Request requires explicit send confirmation', () => document.querySelectorAll('.um-backdrop').length === 2);
    await button('common.cancel'); await check('Cancel sends no request', () => fixture.requests.length === 0);
    await button('rooms.docs.requestAccess'); await button('common.confirm'); await until('Sent status does not claim receipt or grant rights', () => fixture.requests.length === 1 && document.querySelector('[data-docs-access-request]').textContent.includes(tr['rooms.docs.request.sent']) && document.querySelector('[data-docs-access-request] button').disabled);
    await run(() => { fixture.access.own.status = 'received'; fixture.version++; }); await until('Owner receipt is shown separately', () => document.querySelector('[data-docs-access-request]').textContent.includes(tr['rooms.docs.request.received']));
    await capture('document-access');
    await run(() => { fixture.reader = false; fixture.access.own = null; fixture.access.pending = [{ documentId: 'note', policyId: 'c'.repeat(64), requestId: 'request', memberId: 'b'.repeat(32), at: Date.now() }]; fixture.version++; fixture.mount('documents'); });
    await until('Owner catalog loads', () => !!document.querySelector('[data-docs-document=note]')); await click('[data-docs-document=note]');
    await until('Owner sees the pending request', () => !!document.querySelector('[data-docs-requests]')); await click('[data-docs-requests]'); await button('rooms.docs.chooseWriter');
    await check('Choosing requested writer does not save permissions automatically', () => fixture.policies.length === 0 && document.querySelectorAll('.hd-inspector form input:checked').length === 2);
    await click('[data-docs-policy-save]'); await until('Owner explicitly saves the selected policy', () => fixture.policies.length === 1 && fixture.policies[0][4].includes('b'.repeat(32)));
    await run(() => fixture.mount('group')); await until('Group readiness loads', () => !!document.querySelector('[data-server-group-readiness] [role=switch]:not(:disabled)'));
    await check('Group publication starts disabled', () => fixture.preparations.length === 0 && document.querySelector('[role=switch]').getAttribute('aria-checked') === 'false');
    await click('[role=switch]'); await until('Opt-in sends only conservative preparation state', () => fixture.preparations.length === 1 && fixture.preparations[0].state === 'confirm');
    await run(() => fixture.confirmReady(true)); await until('Explicit confirmation publishes ready state', () => fixture.preparations.some(r => r.state === 'ready'));
    await check('Legacy member remains unsupported', () => document.querySelector('[data-preparation-member=legacy]').textContent.includes(tr['rooms.server.group.state.unsupported']));
    await capture('server-readiness');
    await click('[role=switch]'); await until('Disabling publication withdraws previous report', () => fixture.preparations.at(-1).state === 'withdrawn');
    await run(() => fixture.mount('create')); await until('Torrent creation page loads', () => !!document.querySelector('.tab-btn'));
    await run(() => [...document.querySelectorAll('.tab-btn')].at(-1).click()); await pause();
    await select('create.pieceSize', '16 КиБ'); await check('Russian piece size is localized', () => document.querySelector('[role=combobox]').textContent.includes('КиБ'));
    await run(() => fixture.language('en')); await until('Changing language updates labels and preserves selected piece size', () => document.querySelector('[role=combobox]').textContent.includes('16 KiB'));
    await run(() => fixture.language('ru')); await pause(120); await capture('torrent-creation');
    for (const mode of ['screen', 'invitation', 'documents', 'reader', 'group', 'devices', 'create']) {
      await run(`fixture.expiresAt=Date.now()+600000;fixture.reader=${JSON.stringify(mode)}==='reader';fixture.mount(${JSON.stringify(mode)});true;`); await pause(180);
      if (mode === 'documents') { await until('Narrow form catalog is ready', () => !!document.querySelector('[data-docs-new]:not(:disabled)')); await click('[data-docs-new]'); }
      for (const width of [700, 400]) { win.setContentSize(width, 820); await pause(90); await check(`${mode} fits ${width}px without page overflow`, () => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('.um-card,.um-body,.hd-main,.hd-create,.device-invitation-card,.server-group-readiness')].every(el => el.scrollWidth <= el.clientWidth + 1)); if (width === 400) await capture(mode + '-400'); }
      win.setContentSize(1150, 900); await pause();
    }
    assert.deepEqual(errors, []); checks.push('No renderer errors');
    fs.writeFileSync(path.join(output, 'ui-results.json'), JSON.stringify({ checks, errors, runtime: process.versions.electron, isolated: true }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output })); clearTimeout(deadline); win.destroy(); app.quit();
  }).catch(async error => { console.error(error); if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); clearTimeout(deadline); app.exit(1); });
}
