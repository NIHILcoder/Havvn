if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist/screen-view-ui');
  const dict = JSON.parse(fs.readFileSync(path.join(root, 'renderer/i18n/ru.json')));
  app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-screen-view-')));
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => { console.error('Screen view deadline'); app.exit(1); }, 90000);
  app.whenReady().then(async () => {
    const errors = [], checks = [], children = [];
    const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false };
    const win = new BrowserWindow({ show: false, width: 1040, height: 720, webPreferences: prefs });
    win.webContents.setWindowOpenHandler(({ url, frameName }) => ({ action: url === 'about:blank' && frameName === 'havvn-screen-view' ? 'allow' : 'deny',
      overrideBrowserWindowOptions: { show: true, opacity: 0, skipTaskbar: true, focusable: false, frame: false, width: 850, height: 560, webPreferences: prefs } }));
    win.webContents.on('did-create-window', child => { children.push(child); child.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); });
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const run = (code, target = win) => target.webContents.executeJavaScript(typeof code === 'function' ? `(${code})()` : code, true);
    const until = async (name, code, target = win) => {
      for (let i = 0; i < 140; i++) { if (await run(code, target)) { checks.push(name); return; } await pause(35); }
      assert.fail(name + ': ' + await run(() => document.body.textContent.slice(-1200), target));
    };
    const check = (name, value) => { assert.equal(value, true, name); checks.push(name); };
    const capture = async (name, target = win) => {
      const visible = target.isVisible(), opacity = target.getOpacity();
      try {
        // Native hidden/transparent windows can return a stale compositor frame.
        // Briefly paint the owned synthetic fixture without taking keyboard focus.
        target.setOpacity(1); target.showInactive();
        await run(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), target);
        await pause(100);
        for (let attempt = 0; ; attempt++) {
          try { fs.writeFileSync(path.join(out, name + '.png'), (await target.webContents.capturePage()).toPNG()); break; }
          catch (error) { if (attempt >= 2 || !String(error).includes('UnknownVizError')) throw error; await pause(150); }
        }
      } finally { target.setOpacity(opacity); if (!visible) target.hide(); }
    };
    const clickMenu = async (key, target = win) => {
      await run(`(()=>{const b=[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent===${JSON.stringify(dict[key])});if(!b)throw Error('Missing menu action');b.click();})()`, target);
    };
    const menu = async (target = win) => {
      await run(() => document.querySelector('.ssv-stage').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 4, clientY: innerHeight - 4 })), target);
      await until('Context menu visible', () => !!document.querySelector('.context-menu') && getComputedStyle(document.querySelector('.context-menu')).visibility === 'visible', target);
    };
    await win.loadFile(path.join(out, 'index.html')); await until('Fixture loaded', () => !!window.fixture);
    await run(() => fixture.mount(true));
    await until('Real loopback receives live video', () => document.querySelector('.ssv-video')?.readyState >= 2);
    await run(() => { fixture.originalVideo = document.querySelector('.ssv-video'); });
    await menu();
    await pause(150);
    await capture('controls-menu');
    check('Menu clamps to viewport', await run(() => { const r = document.querySelector('.context-menu').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    await clickMenu('player.detach');
    await until('Window detaches and files become available', () => fixture.detached && !!document.querySelector('#files-ready') && !!fixture.child?.document.querySelector('.ssv-video'));
    const child = children.at(-1);
    await until('Detached video is playing', () => document.querySelector('.ssv-video')?.readyState >= 2 && !document.querySelector('.ssv-video').paused, child);
    check('Same video, one watch, no reconnect', await run(() => fixture.originalVideo === fixture.child.document.querySelector('.ssv-video') && fixture.starts === 1 && fixture.stops === 0));
    const firstFrame = await run(() => document.querySelector('.ssv-video').getVideoPlaybackQuality().totalVideoFrames, child);
    await pause(250);
    check('Frames continue in detached window', await run(() => document.querySelector('.ssv-video').getVideoPlaybackQuality().totalVideoFrames, child) > firstFrame);
    await pause(150);
    await capture('detached-window', child);
    await menu(child); await clickMenu('rooms.screen.quality', child);
    await until('Quality dialog is in the owning window', () => document.querySelectorAll('[role=combobox]').length === 3, child);
    await run(() => document.querySelector('[role=combobox]').click(), child);
    await run(() => [...document.querySelectorAll('[role=option]')].find(el => el.textContent === '720p').click(), child);
    await run(() => document.querySelectorAll('[role=combobox]')[1].click(), child);
    await run(() => [...document.querySelectorAll('[role=option]')].find(el => el.textContent === '60 FPS').click(), child);
    await pause(150);
    await capture('quality-settings', child);
    await run(() => { fixture.holdConfigure = true; });
    await run(() => { document.querySelector('.um-foot .btn-primary').click(); document.querySelector('.um-foot .btn-primary').click(); }, child);
    await until('One quality request while busy', () => fixture.configured.length === 1);
    await run(() => { fixture.holdConfigure = false; fixture.finishConfigure(); });
    await until('Quality applies without closing viewer', () => !document.querySelector('[role=dialog]') && !!document.querySelector('.ssv-video'), child);
    check('Selected quality reached capture', await run(() => fixture.settings.height === 720 && fixture.settings.fps === 60 && fixture.starts === 1 && fixture.stops === 0));
    await menu(child); await clickMenu('rooms.screen.fill', child);
    check('Fill mode applied', await run(() => document.querySelector('.ssv-video').style.objectFit === 'cover', child));
    child.setSize(460, 400); await pause(200);
    await capture('detached-narrow', child);
    const narrow = await run(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth,
      head: document.querySelector('.ssv-head').scrollWidth, body: document.body.getBoundingClientRect().width,
      video: (()=>{const v=document.querySelector('.ssv-video'),c=document.createElement('canvas');c.width=2;c.height=2;
        c.getContext('2d').drawImage(v,v.videoWidth*.12,v.videoHeight*.5,1,1,0,0,1,1);const r=v.getBoundingClientRect();return {width:r.width,height:r.height,sourceWidth:v.videoWidth,sourceHeight:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,pixel:[...c.getContext('2d').getImageData(0,0,1,1).data]};})() }), child);
    console.log('Narrow video:', JSON.stringify(narrow));
    check('Actual video pixels survive resize and quality change', narrow.video.pixel[0] > 150 && narrow.video.pixel[3] === 255);
    check('Detached controls fit narrow window ' + JSON.stringify(narrow), narrow.page <= narrow.viewport + 1 && narrow.head <= narrow.viewport + 1);
    await menu(child); await clickMenu('player.attach', child);
    await until('View docks back', () => !fixture.detached && document.querySelector('.ssv-video') === fixture.originalVideo && !document.querySelector('.ssv-video').paused);
    check('Docking back keeps watch', await run(() => fixture.starts === 1 && fixture.stops === 0));
    await run(() => {
      const stage = document.querySelector('.ssv-stage'); stage.focus();
      stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await until('Keyboard opens and focuses the menu', () => document.activeElement?.getAttribute('role') === 'menuitem');
    await run(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    check('Arrow key advances the menu', await run(() => document.activeElement === document.querySelectorAll('.context-menu button')[1]));
    await run(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until('Escape closes menu without closing video', () => !document.querySelector('.context-menu') && fixture.closed === 0 && !!document.querySelector('.ssv-video'));
    await menu(); await clickMenu('rooms.screen.quality');
    await run(() => { fixture.failConfigure = true; });
    await run(() => document.querySelector('.um-foot .btn-primary').click());
    await until('Failed quality change keeps dialog and stream', () => !!document.querySelector('[role=alert]') && document.querySelector('.ssv-video').readyState >= 2);
    await run(() => { fixture.failConfigure = false; document.querySelector('.um-foot .btn-primary').click(); });
    await until('Settings retry succeeds', () => !document.querySelector('[role=dialog]'));
    await run(() => document.querySelector('.ssv-stage').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await until('Fullscreen enters', () => !!document.fullscreenElement);
    await menu(); check('Fullscreen menu stays in top layer', await run(() => document.fullscreenElement.contains(document.querySelector('.context-menu'))));
    await clickMenu('rooms.screen.quality');
    check('Fullscreen settings stay in top layer', await run(() => document.fullscreenElement.contains(document.querySelector('[role=dialog]'))));
    await run(() => document.querySelector('.um-foot .btn-ghost').click());
    await run(() => document.exitFullscreen()); await pause(300);
    await menu(); await clickMenu('player.detach'); await until('Second detach', () => fixture.detached);
    children.at(-1).close();
    await until('Native close returns the same live view', () => !fixture.detached && document.querySelector('.ssv-video') === fixture.originalVideo && !document.querySelector('.ssv-video').paused);
    check('Native close preserves loopback', await run(() => fixture.starts === 1 && fixture.stops === 0 && fixture.closed === 0));
    const returnedFrame = await run(() => document.querySelector('.ssv-video').getVideoPlaybackQuality().totalVideoFrames);
    await until('Video keeps producing frames after native close', `document.querySelector('.ssv-video').getVideoPlaybackQuality().totalVideoFrames > ${returnedFrame}`);
    await run(() => { fixture.holdWatch = true; fixture.mount(false); });
    await until('Switching participant clears the old video while the new watch waits', () => fixture.starts === 2 && document.querySelector('.ssv-video').srcObject === null);
    await run(() => { fixture.holdWatch = false; fixture.finishWatch(); });
    await until('New participant receives its own video', () => document.querySelector('.ssv-video').readyState >= 2);
    await win.loadFile(path.join(out, 'index.html')); await until('Remote fixture loaded', () => !!window.fixture);
    await run(() => fixture.mount(false));
    await until('Remote video playing', () => document.querySelector('.ssv-video')?.readyState >= 2);
    await menu();
    check('Viewer cannot configure another sender', await run(`![...document.querySelectorAll('.context-menu button')].some(el=>el.textContent===${JSON.stringify(dict['rooms.screen.quality'])})`));
    await clickMenu('rooms.screen.mutePlayback');
    await until('Mute targets screen audio API', () => fixture.playback.at(-1)?.muted === true && fixture.playback.at(-1)?.memberId === 'remote');
    await run(() => { const slider = document.querySelector('.ssv-sound input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '25'); slider.dispatchEvent(new Event('input', { bubbles: true })); });
    await until('Volume targets screen audio API', () => fixture.playback.at(-1)?.volume === .25);
    await capture('viewer-inline');
    await menu(); await clickMenu('rooms.screen.closeView');
    await until('Closing preview stops only its watch', () => fixture.stops === 1 && fixture.closed === 1 && !fixture.sharingStopped);
    check('No renderer errors', errors.length === 0);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: true, checks, errors, syntheticVideoOnly: true }, null, 2));
    console.log(`PASS screen view: ${checks.length} checks; sandboxed WebRTC, detach/return, quality, fullscreen, screen-only audio.`);
    win.destroy(); clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
