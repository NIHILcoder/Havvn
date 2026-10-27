// Build with: npx webpack --config scripts/large-file-ui.webpack.cjs
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist/large-file-ui');
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-large-files-'));
  app.setPath('userData', path.join(temp, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Large-file UI deadline'); app.exit(1); }, 150000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1120, height: 900, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const errors = [], checks = [], metrics = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const run = expression => win.webContents.executeJavaScript(typeof expression === 'function' ? `(${expression})()` : expression);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const check = (name, value) => { assert.equal(value, true, name); checks.push(name); };
    const until = async (name, expression) => {
      for (let i = 0; i < 100; i++) { if (await run(expression)) { checks.push(name); return; } await pause(40); }
      assert.fail(name + ': ' + JSON.stringify(await run(() => ({ text: document.body.textContent.slice(-1600),
        rows: document.querySelectorAll('[data-file-row]').length, focused: document.activeElement?.outerHTML.slice(0, 250) }))));
    };
    const mount = async (kind, count, layout) => {
      await win.loadFile(path.join(out, 'index.html'));
      await until('Fixture loaded', () => !!window.fixture);
      await run(`fixture.mount(${JSON.stringify(kind)},${count},${JSON.stringify(layout)})`);
      if (kind === 'controls') {
        await until('Controls ready', () => !!document.querySelector('#tcm-tab-files'));
        await run(() => document.querySelector('#tcm-tab-files').click());
      }
      await until(`${kind}: file rows ready`, () => document.querySelectorAll('[data-file-row]').length > 0);
      await pause(100);
      const metric = await run(() => ({ mounted: document.querySelectorAll('[data-file-row]').length,
        ms: Math.round(performance.now() - fixture.startedAt), height: document.querySelector('.vfl').clientHeight,
        totalHeight: document.querySelector('.vfl').scrollHeight }));
      metrics.push({ kind, count, ...metric });
      check(`${kind}/${count}: bounded DOM`, metric.mounted > 0 && metric.mounted < 60);
      check(`${kind}/${count}: real scroll viewport`, metric.height > 100 && metric.totalHeight > metric.height * 5);
    };
    for (const count of [1000, 10000]) {
      await mount('selector', count);
      await run(() => { document.querySelector('.file-list').focus(); });
      await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      await until('Keyboard reaches final checkbox', () => document.activeElement?.getAttribute('aria-label') === fixture.files.at(-1).path);
      await run(() => document.activeElement.click());
      await run(() => document.querySelector('.file-list').scrollTop = 0);
      await until('Scroll returns to first file', () => !!document.querySelector('[data-file-row="0"]'));
      // Filtering + select-all must affect offscreen matches too.
      await run(() => {
        const input = document.querySelector('.search-box input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'selected-group/');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await until('Search finds the whole matching group', () => document.querySelector('.vfl-row')?.getAttribute('aria-setsize') === String(fixture.files.length / 10));
      await run(() => document.querySelector('.quick-actions button').click());
      await run(() => document.querySelector('.um-foot .btn-primary').click());
      await until('All offscreen filtered files excluded', () => fixture.confirmed.length === fixture.files.length - fixture.files.length / 10 - 1
        && !fixture.confirmed.includes(fixture.files.at(-1).index)
        && fixture.files.every(f => f.path.includes('selected-group/') ? !fixture.confirmed.includes(f.index) : f === fixture.files.at(-1) || fixture.confirmed.includes(f.index)));
      check('Selected size matches full selection', await run(() => {
        const bytes = fixture.files.filter(f => fixture.confirmed.includes(f.index)).reduce((s, f) => s + f.length, 0);
        const unit = Math.floor(Math.log(bytes) / Math.log(1024));
        const text = parseFloat((bytes / 1024 ** unit).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
        return document.querySelectorAll('.file-selector-stats .stat strong')[2].textContent === text;
      }));
      await mount('preview', count);
      await run(() => { fixture.files.at(-1).downloaded = fixture.files.at(-1).length; });
      await until('Live preview polls again', () => fixture.pulls >= 2);
      await run(() => { document.querySelector('.fp-list').focus(); });
      await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      await until('Offscreen file receives current progress', () => document.querySelector(`[data-file-row="${fixture.files.length - 1}"] .fp-item-pct`)?.textContent === '100%');
      await mount('controls', count);
      await run(() => document.querySelector('.tcm-files-list').focus());
      await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
      await until('Final priority row reachable', () => !!document.querySelector(`[data-file-row="${fixture.files.length - 1}"]`));
      await run(() => document.querySelector(`[data-file-row="${fixture.files.length - 1}"] .tcm-priority-btn:last-child`).click());
      await until('Priority uses actual torrent index', () => fixture.priorities[0] === fixture.files.at(-1).index);
      await until('Priority confirmation survives refresh', () => document.querySelector(`[data-file-row="${fixture.files.length - 1}"] .tcm-priority-btn:last-child`)?.getAttribute('aria-pressed') === 'true');
    }
    await mount('selector', 1000);
    await run(() => { fixture.holdConfirm = true; document.querySelector('.um-foot .btn-primary').click(); });
    await until('Submit enters pending state', () => !!fixture.finishConfirm);
    await run(() => document.querySelector('.file-item').click());
    check('Pending add freezes the exact selected files and controls', await run(() => fixture.confirmed.length === 1000
      && document.querySelector('.file-selector-stats strong').textContent === '1000'
      && document.querySelector('.file-item input').disabled && document.querySelector('.search-box input').disabled
      && [...document.querySelectorAll('.quick-actions button')].every(button => button.disabled)));
    await run(() => { fixture.holdConfirm = false; fixture.finishConfirm(); });
    await until('Controls unlock after add settles', () => !document.querySelector('.file-item input').disabled);
    const labels = JSON.parse(fs.readFileSync(path.join(root, 'renderer/i18n/ru.json'), 'utf8'));
    const quick = async key => {
      await until('Quick actions enabled', () => !document.querySelector('.quick-actions .dropdown-wrapper button').disabled);
      await run(() => document.querySelector('.quick-actions .dropdown-wrapper button').click());
      await until('Quick menu opened', () => !!document.querySelector('.quick-select-menu'));
      await run(`Array.from(document.querySelectorAll('.quick-select-menu button')).find(node=>node.textContent.trim()===${JSON.stringify(labels[key])}).click()`);
    };
    const confirm = async () => {
      await until('File choice ready to submit', () => !document.querySelector('.um-foot .btn-primary').disabled);
      await run(() => document.querySelector('.um-foot .btn-primary').click());
      await pause(80);
      await until('File choice settled', () => !document.querySelector('.quick-actions button').disabled);
    };
    await mount('selector',1000,'mixed');
    await quick('filePicker.onlyVideos');await confirm();
    check('Only videos replaces TXT/NFO/subtitles and includes MP4/MKV/AVI beyond the viewport',await run(()=>fixture.confirmed.length===500&&fixture.files.every((file,i)=>fixture.confirmed.includes(file.index)===[0,1,2,7].includes(i%8))));
    await quick('filePicker.excludeSamples');await confirm();
    check('Exclude sample preserves the main media files',await run(()=>fixture.confirmed.length===375&&fixture.files.every((file,i)=>fixture.confirmed.includes(file.index)===[0,1,2].includes(i%8))));
    await quick('filePicker.videoSubtitles');await confirm();
    check('Video with subtitles replaces the chosen scope with video and ASS/SRT',await run(()=>fixture.confirmed.length===750&&fixture.files.every((file,i)=>fixture.confirmed.includes(file.index)===[0,1,2,3,4,7].includes(i%8))));
    await mount('selector',1000,'mixed');
    await run(()=>document.querySelector('.quick-actions button').click());
    await run(()=>document.querySelector('input[aria-label="Archive/group-0/info.txt"]').click());
    await quick('filePicker.addMp4');await confirm();
    check('Add MP4 preserves an independently chosen text file',await run(()=>fixture.confirmed.length===251&&fixture.confirmed.includes(17)&&fixture.files.every((file,i)=>![0,7].includes(i%8)||fixture.confirmed.includes(file.index))));
    await mount('selector',1000,'mixed');
    await run(()=>{const input=document.querySelector('.search-box input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Archive/group-1/');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await until('Search scopes to the complete folder',()=>document.querySelectorAll('.file-list [data-file-row]').length===8);
    await quick('filePicker.onlyVideos');await confirm();
    check('Scoped replacement preserves selections outside the filtered list',await run(()=>fixture.confirmed.length===996&&[29,31,33,35].every(index=>!fixture.confirmed.includes(index))&&fixture.confirmed.includes(17)));
    await run(()=>document.querySelector('.tfs-selection-scope [role=combobox]').click());
    await until('Scope choices opened',()=>!!document.querySelector('[role=listbox]'));
    await run(()=>document.querySelector('[role=option]:last-child').click());
    await quick('filePicker.onlyVideos');await confirm();
    check('Explicit entire-torrent scope applies beyond the current search',await run(()=>fixture.confirmed.length===500));
    await mount('selector',10000,'folders');
    await run(()=>document.querySelector('.tfs-folder-button').click());
    await until('Large folder picker is ready',()=>document.querySelectorAll('.tfs-folders [data-file-row]').length>0);
    check('10001 folders keep a bounded mounted list',await run(()=>document.querySelectorAll('.tfs-folders [data-file-row]').length<60));
    fs.writeFileSync(path.join(out,'folder-picker.png'),(await win.webContents.capturePage()).toPNG());
    await run(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Archive/group-9999');input.dispatchEvent(new Event('input',{bubbles:true}));});
    await until('Folder search finds an offscreen directory',()=>!!document.querySelector('.tfs-folder-option[title="Archive/group-9999"]'));
    await run(()=>document.querySelector('.tfs-folder-option[title="Archive/group-9999"]').click());
    await until('Folder selection narrows the file list',()=>document.querySelectorAll('.file-list [data-file-row]').length===1);
    await quick('filePicker.onlyScope');await confirm();
    check('Keep only the folder sends its real metadata index',await run(()=>fixture.confirmed.length===1&&fixture.confirmed[0]===20005));
    fs.writeFileSync(path.join(out,'folder-selection.png'),(await win.webContents.capturePage()).toPNG());
    for (const kind of ['selector', 'preview', 'controls']) {
      win.setSize(600, 740);
      await mount(kind, 10000);
      check(`${kind}: narrow dialog fits`, await run(() => { const r = document.querySelector('[role="dialog"]').getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.querySelector('.vfl').scrollWidth <= document.querySelector('.vfl').clientWidth + 1; }));
      if (kind === 'selector') {
        fs.writeFileSync(path.join(out, 'selector-before-layout-check.png'), (await win.webContents.capturePage()).toPNG());
        console.log('Selector layout:',JSON.stringify(await run(()=>Object.fromEntries(['.um-card','.um-head','.um-body','.tfs-destination','.file-selector-controls','.tfs-selection-scope','.file-list','.um-foot'].map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return [selector,{top:r.top,bottom:r.bottom,height:r.height}];})))));
        check('Submit visible in narrow window', await run(() => { const r = document.querySelector('.um-foot').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; }));
        check('Files visible without scrolling the dialog', await run(() => {
          const r = document.querySelector('.vfl').getBoundingClientRect(), foot = document.querySelector('.um-foot').getBoundingClientRect();
          return r.top > 0 && Math.min(r.bottom, foot.top) - r.top > 120;
        }));
        await run(()=>document.querySelector('.quick-actions .dropdown-wrapper button').click());
        await until('Narrow quick menu opens',()=>!!document.querySelector('.quick-select-menu'));
        check('All quick actions fit the narrow viewport',await run(()=>{const r=document.querySelector('.quick-select-menu').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+1&&r.left>=0&&r.right<=innerWidth+1;}));
        fs.writeFileSync(path.join(out,'quick-actions-narrow.png'),(await win.webContents.capturePage()).toPNG());
        await run(()=>document.querySelector('.quick-select-menu button').click());
      }
      fs.writeFileSync(path.join(out, `${kind}-narrow.png`), (await win.webContents.capturePage()).toPNG());
    }
    check('No renderer errors', errors.length === 0);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, checks, metrics, errors }, null, 2));
    console.log('PASS large torrent UI:', JSON.stringify(metrics));
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
