// Verify the static website in Chromium without starting the desktop application.
require('./stamp-site-assets.cjs')({check:true});
if (!process.versions.electron) {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {env, windowsHide:true, stdio:'inherit'});
  child.on('error', error => {console.error(error);process.exitCode=1;});
  child.on('exit', code => {process.exitCode=code ?? 1;});
} else {
  const {app,BrowserWindow} = require('electron');
  const assert = require('node:assert/strict');
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-site-smoke-'));
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => {console.error('Site smoke timed out');app.exit(1);}, 60000);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    const preview = require('./serve-site.cjs');
    await new Promise(resolve => preview.listen(0,'127.0.0.1',resolve));
    const baseUrl = 'http://127.0.0.1:' + preview.address().port + '/';
    const win = new BrowserWindow({width:1440,height:1000,frame:false,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    const errors = [];
    win.webContents.on('console-message', detail => {if(detail.level==='error')errors.push(detail.message);});
    const run = code => win.webContents.executeJavaScript(code);
    await win.loadURL(baseUrl);
    await run('document.fonts.ready.then(()=>true)');
    assert.equal(await run("document.styleSheets.length > 0 && [...document.images].every(image=>image.complete && image.naturalWidth>0)"), true, 'Styles and images load');
    assert.equal(await run("document.fonts.check('700 60px Inter') && document.fonts.check('400 15px Inter')"), true, 'Local fonts load');
    const localAssets = await run("[...document.querySelectorAll('link[href],script[src],img[src]')].map(el=>el.getAttribute('href')||el.getAttribute('src')).filter(url=>url&&!/^(https?:|#)/.test(url))");
    localAssets.forEach(asset => assert.ok(fs.existsSync(path.resolve(root,'docs',new URL(asset,'http://localhost/').pathname.slice(1))), 'Local asset exists: ' + asset));
    assert.deepEqual(await run("[...document.querySelectorAll('a[href^=\"#\"]')].map(el=>el.getAttribute('href')).filter(href=>href!=='#'&&!document.querySelector(href))"), [], 'All anchor destinations exist');

    const checks = [];
    for(const width of [320,360,390,600,768,900,1024,1280,1440,1920,2560]) {
      win.setSize(width,900);
      await wait(70);
      for(const language of ['en','ru']) {
        await run("if(document.documentElement.lang!=="+JSON.stringify(language)+")document.querySelector('#language').click()");
        await run('document.fonts.ready.then(()=>true)');
        const metrics = await run("({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})");
        assert.ok(metrics.scroll <= metrics.client + 1, width + 'px ' + language + ' has no horizontal overflow: ' + JSON.stringify(metrics));
        if(width>=1600){
          const alignment=await run("({sceneRight:document.querySelector('.hero-art').getBoundingClientRect().right,contentRight:document.querySelector('nav.wrap').getBoundingClientRect().right})");
          assert.ok(alignment.sceneRight<=alignment.contentRight+80,width+'px '+language+' hero scene stays beside the centered content');
        }
        checks.push(width + ':' + language);
      }
    }
    assert.equal(await run("document.title.includes('Твои файлы') && document.querySelector('meta[name=\"description\"]').content.includes('Бесплатный')"), true, 'Russian metadata');
    assert.equal(await run("localStorage.getItem('havvn-site-language')"), 'ru', 'Language preference persists');
    await new Promise(resolve => {win.webContents.once('did-finish-load',resolve);win.reload();});
    await wait(100);
    assert.equal(await run("document.documentElement.lang"), 'ru', 'Stored language survives reload');
    await run("document.querySelector('#tab-downloads').focus()");
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await wait(30);
    assert.equal(await run("document.activeElement.id === 'tab-rooms' && !document.querySelector('#panel-rooms').hidden && document.querySelector('#panel-downloads').hidden"), true, 'Keyboard switches tabs and focus');
    await run("document.querySelector('#tab-watch').click();document.querySelector('#demo-play').click()");
    assert.equal(await run("document.querySelector('#demo-play').getAttribute('aria-pressed')==='true' && document.querySelector('.cinema').classList.contains('is-playing')"), true, 'Play demo');
    await run("document.querySelector('#language').click()");
    assert.equal(await run("document.querySelector('#demo-state').textContent"), 'Demo playing', 'Language preserves demo state');
    await run("document.querySelector('#tab-downloads').click()");
    assert.equal(await run("document.querySelector('#demo-play').getAttribute('aria-pressed')"), 'false', 'Leaving watch pauses demo');

    win.setSize(390,844);await wait(70);
    await run("document.querySelector('#menu-toggle').click()");
    assert.equal(await run("getComputedStyle(document.querySelector('#navigation')).display !== 'none' && document.querySelector('#menu-toggle').getAttribute('aria-expanded')==='true'"), true, 'Mobile menu opens');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait(30);
    assert.equal(await run("document.querySelector('#menu-toggle').getAttribute('aria-expanded')==='false' && document.activeElement.id==='menu-toggle'"), true, 'Escape closes menu and restores focus');
    await run("document.querySelector('#menu-toggle').click();document.querySelector('#navigation a').click()");
    assert.equal(await run("document.querySelector('#menu-toggle').getAttribute('aria-expanded')"), 'false', 'Navigation closes menu');
    await run("document.querySelector('#faq details').open=true;document.querySelector('.verify').open=true");
    assert.equal(await run("document.querySelector('#faq details').open && document.querySelector('.verify').open"), true, 'FAQ and verification expand');
    assert.deepEqual(errors, [], 'No browser console errors');
    await run("document.documentElement.style.scrollBehavior='auto';window.scrollTo({top:0,behavior:'instant'})");
    await wait(100);
    const sceneBefore = await run("document.querySelector('#network-scene').toDataURL()");
    await wait(150);
    assert.notEqual(await run("document.querySelector('#network-scene').toDataURL()"),sceneBefore,'Particle scene animates');
    await run("document.querySelector('#motion-toggle').click()");
    await wait(30);
    const still = await run("document.querySelector('#network-scene').toDataURL()");
    await wait(100);
    assert.equal(await run("document.querySelector('#network-scene').toDataURL()"),still,'Motion control freezes the scene');
    await run("document.querySelector('#motion-toggle').click()");

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await run("matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.hero-mark')).animationName==='none' && getComputedStyle(document.querySelector('.scene-halo')).animationName==='none'"), true, 'Reduced motion disables animation');
    win.webContents.debugger.detach();
    win.destroy();

    const plain = new BrowserWindow({width:390,height:844,frame:false,show:false,webPreferences:{offscreen:true,javascript:false}});
    await plain.loadURL(baseUrl);
    // Inspect through the DevTools protocol while page JavaScript remains disabled.
    plain.webContents.debugger.attach('1.3');
    const visible = await plain.webContents.debugger.sendCommand('Runtime.evaluate', {expression:"[...document.querySelectorAll('.reveal')].every(el=>getComputedStyle(el).opacity==='1')",returnByValue:true});
    assert.equal(visible.result.value, true, 'Content stays visible without JavaScript');
    plain.webContents.debugger.detach();plain.destroy();
    console.log(JSON.stringify({result:'passed',layouts:checks,checks:['asset cache hashes','local assets','fonts','anchors','language persistence','metadata','keyboard tabs','demo controls','mobile navigation','FAQ','reduced motion','no JavaScript','browser console']},null,2));
    preview.close();clearTimeout(deadline);app.quit();
  }).catch(error => {console.error(error);clearTimeout(deadline);app.exit(1);});
}
