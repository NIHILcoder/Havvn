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
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  const deadline = setTimeout(() => {console.error('Site smoke timed out');app.exit(1);}, 120000);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const imageHash = image => require('node:crypto').createHash('sha256').update(image.toPNG()).digest('hex');
  app.whenReady().then(async () => {
    const preview = require('./serve-site.cjs');
    await new Promise(resolve => preview.listen(0,'127.0.0.1',resolve));
    const baseUrl = 'http://127.0.0.1:' + preview.address().port + '/';
    const win = new BrowserWindow({width:1440,height:1000,frame:false,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    const errors = [];
    const requests = [];
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      requests.push(details.url);
      callback({});
    });
    win.webContents.on('console-message', detail => {if(detail.level==='error')errors.push(detail.message);});
    const run = code => win.webContents.executeJavaScript(code).catch(error => {
      throw new Error('Browser check failed: ' + code, {cause:error});
    });
    const waitFor = async (condition, message) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await run(condition)) return;
        await wait(100);
      }
      assert.fail(message);
    };
    await win.loadURL(baseUrl);
    await run('document.fonts.ready.then(()=>true)');
    await waitFor("document.querySelector('.hero-art').dataset.scene === 'webgl'", 'Three.js scene renders through WebGL');
    assert.ok(requests.some(url => url.includes('three.module.min.js')), 'Local Three.js module loads');
    assert.ok(requests.every(url => url.startsWith(baseUrl) || url.startsWith('data:')), 'Website makes no external asset requests');
    const screenshots = path.join(root, 'artifacts', 'site');
    fs.mkdirSync(screenshots, {recursive:true});
    await wait(200);
    fs.writeFileSync(path.join(screenshots, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run("!document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === 0"), true, 'Scene controls are keyboard accessible');
    await run("document.querySelector('#motion-toggle').click();document.querySelector('#network-scene').focus({preventScroll:true})");
    await wait(80);
    const crop = await run("(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {x:Math.round(b.left+b.width*.24),y:Math.round(b.top+b.height*.25),width:Math.round(b.width*.65),height:Math.round(b.height*.5)}})()");
    const initialView = imageHash(await win.webContents.capturePage(crop));
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await wait(80);
    const rotatedView = imageHash(await win.webContents.capturePage(crop));
    assert.notEqual(rotatedView, initialView, 'Arrow keys visibly rotate the paused sculpture');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Home'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Home'});
    await wait(80);
    const resetView = imageHash(await win.webContents.capturePage(crop));
    assert.notEqual(resetView, rotatedView, 'Home visibly resets the rotated sculpture');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    assert.equal(await run("/→ 6/.test(document.querySelector('#scene-status').textContent)"), true, 'Enter sends a pulse while paused');
    await run("document.querySelector('#language').click()");
    await wait(20);
    assert.equal(await run("document.querySelector('#scene-status').textContent.startsWith(document.documentElement.lang==='ru'?'Демо P2P · узел':'P2P demo · peer')"), true, 'Selected peer status follows language');
    await run("document.querySelector('#scene-reset').click()");
    const canvasBounds = await run("(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height}})()");
    const dragX = Math.round(canvasBounds.left + canvasBounds.width * .68);
    const dragY = Math.round(canvasBounds.top + canvasBounds.height * .48);
    const mouse = (type, x, y, extra={}) => win.webContents.sendInputEvent({type,x,y,...extra});
    mouse('mouseDown',dragX,dragY,{button:'left',clickCount:1});
    mouse('mouseMove',dragX+65,dragY+25,{modifiers:['leftButtonDown']});
    mouse('mouseUp',dragX+65,dragY+25,{button:'left',clickCount:1});
    await wait(80);
    assert.notEqual(imageHash(await win.webContents.capturePage(crop)), resetView, 'Mouse drag visibly rotates the sculpture');
    assert.equal(await run("document.querySelector('#scene-status').textContent.includes('→')"), false, 'Dragging does not accidentally activate a peer');
    await run("document.querySelector('#scene-reset').click()");
    // Click a small grid on the upper/front network, without reading scene internals.
    let picked = false;
    for(const y of [.18,.24,.30,.36]) {
      for(const x of [.48,.56,.64,.72,.80,.88]) {
        const px=Math.round(canvasBounds.left+canvasBounds.width*x),py=Math.round(canvasBounds.top+canvasBounds.height*y);
        mouse('mouseDown',px,py,{button:'left',clickCount:1});
        mouse('mouseUp',px,py,{button:'left',clickCount:1});
        await wait(15);
        picked = await run("document.querySelector('#scene-status').textContent.includes('→')");
        if(picked) break;
      }
      if(picked) break;
    }
    assert.ok(picked,'Clicking a network peer selects it and sends a pulse');
    await run("document.querySelector('#scene-reset').click();document.querySelector('#scene-pulse').click()");
    assert.equal(await run("document.querySelector('#scene-status').textContent.includes('→ 6')"), true, 'Pulse button selects a peer');
    fs.writeFileSync(path.join(screenshots,'interactive.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('#scene-reset').click();document.querySelector('#motion-toggle').click()");
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
    await waitFor("document.querySelector('.hero-art').dataset.scene === 'webgl'", 'Three.js scene returns after reload');
    const sceneBefore = await run("document.querySelector('#network-scene').dataset.frame");
    await wait(250);
    assert.notEqual(await run("document.querySelector('#network-scene').dataset.frame"),sceneBefore,'Three.js scene animates');
    await run("document.querySelector('#motion-toggle').click()");
    await wait(30);
    const still = await run("document.querySelector('#network-scene').dataset.frame");
    await wait(100);
    assert.equal(await run("document.querySelector('#network-scene').dataset.frame"),still,'Motion control freezes the scene');
    await run("document.querySelector('#motion-toggle').click()");

    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await run("matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.hero-mark')).animationName==='none' && getComputedStyle(document.querySelector('.scene-halo')).animationName==='none'"), true, 'Reduced motion disables animation');
    await wait(100);
    const reducedFrame = await run("document.querySelector('#network-scene').dataset.frame");
    await wait(150);
    assert.equal(await run("document.querySelector('#network-scene').dataset.frame"), reducedFrame, 'Reduced motion freezes WebGL rendering');
    await run("document.querySelector('#scene-pulse').click()");
    assert.equal(await run("document.querySelector('#scene-status').textContent.includes('→ 6')"),true,'Reduced motion supports a static selected route');
    await run("document.querySelector('#scene-reset').click()");
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[]});
    win.webContents.debugger.detach();
    // Restoring normal motion restarts the CSS entrance; capture its settled state.
    win.setSize(390,1250); await wait(1200);
    fs.writeFileSync(path.join(screenshots, 'mobile.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('#motion-toggle').click()");
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const touchBounds=await run("(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {x:Math.round(b.left+b.width*.53),y:Math.round(b.top+b.height*.43)}})()");
    const touchBefore=imageHash(await win.webContents.capturePage());
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchBounds.x,y:touchBounds.y,id:1}]});
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchBounds.x+70,y:touchBounds.y,id:1}]});
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await wait(80);
    assert.notEqual(imageHash(await win.webContents.capturePage()),touchBefore,'Touch drag visibly rotates the sculpture');
    assert.equal(await run("getComputedStyle(document.querySelector('#network-scene')).touchAction"),'pan-y','Scene permits vertical page scrolling on touch screens');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});
    win.webContents.debugger.detach();
    await run("document.querySelector('#scene-reset').click();document.querySelector('#motion-toggle').click()");
    await run("document.querySelector('#download').scrollIntoView({behavior:'instant'})");
    await wait(200);
    const offscreenFrame = await run("document.querySelector('#network-scene').dataset.frame");
    await wait(150);
    assert.equal(await run("document.querySelector('#network-scene').dataset.frame"), offscreenFrame, 'Offscreen scene stops rendering');
    await run("window.scrollTo({top:0,behavior:'instant'})");
    await wait(200);
    assert.notEqual(await run("document.querySelector('#network-scene').dataset.frame"), offscreenFrame, 'Scene resumes on return');
    await run("window.contextLossTest = document.querySelector('#network-scene').getContext('webgl2').getExtension('WEBGL_lose_context');window.contextLossTest.loseContext()");
    await waitFor("document.querySelector('.hero-art').dataset.scene === 'fallback'", 'Context loss shows the original SVG');
    assert.equal(await run("getComputedStyle(document.querySelector('.hero-sculpture')).visibility"), 'visible', 'Brand remains visible after context loss');
    assert.equal(await run("document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === -1"), true, 'Unavailable scene controls leave the tab order');
    await run("window.contextLossTest.restoreContext()");
    await waitFor("document.querySelector('.hero-art').dataset.scene === 'webgl'", 'Scene recovers after context restoration');
    assert.deepEqual(errors, [], 'No browser errors after scene lifecycle checks');
    win.destroy();

    const fallback = new BrowserWindow({width:390,height:844,frame:false,show:false,webPreferences:{offscreen:true,webgl:false,contextIsolation:true,nodeIntegration:false}});
    await fallback.loadURL(baseUrl);
    for(let attempt=0;attempt<100;attempt++) {
      if(await fallback.webContents.executeJavaScript("document.querySelector('.hero-art').dataset.scene === 'fallback'")) break;
      await wait(100);
    }
    assert.equal(await fallback.webContents.executeJavaScript("document.querySelector('.hero-art').dataset.scene === 'fallback' && getComputedStyle(document.querySelector('.hero-sculpture')).visibility === 'visible'"),true,'No WebGL keeps the SVG fallback visible');
    assert.equal(await fallback.webContents.executeJavaScript("document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === -1"),true,'No WebGL hides interactive controls');
    await fallback.webContents.executeJavaScript("document.querySelector('#language').click();document.querySelector('#motion-toggle').click()");
    assert.equal(await fallback.webContents.executeJavaScript("document.querySelector('#motion-toggle').getAttribute('aria-pressed')"),'true','Controls work without WebGL');
    fallback.destroy();

    const plain = new BrowserWindow({width:390,height:844,frame:false,show:false,webPreferences:{offscreen:true,javascript:false}});
    await plain.loadURL(baseUrl);
    // Inspect through the DevTools protocol while page JavaScript remains disabled.
    plain.webContents.debugger.attach('1.3');
    const visible = await plain.webContents.debugger.sendCommand('Runtime.evaluate', {expression:"[...document.querySelectorAll('.reveal')].every(el=>getComputedStyle(el).opacity==='1')",returnByValue:true});
    assert.equal(visible.result.value, true, 'Content stays visible without JavaScript');
    plain.webContents.debugger.detach();plain.destroy();
    console.log(JSON.stringify({result:'passed',layouts:checks,screenshots,checks:['asset cache hashes','local Three.js assets','no external requests','fonts','anchors','language persistence','metadata','keyboard tabs','demo controls','mobile navigation','FAQ','keyboard scene rotation and reset','mouse and touch dragging','peer picking and pulse controls','translated peer status','WebGL animation and pause','offscreen suspension','reduced motion with manual interaction','WebGL context restoration','no WebGL fallback','no JavaScript','browser console']},null,2));
    preview.close();clearTimeout(deadline);app.quit();
  }).catch(error => {console.error(error);clearTimeout(deadline);app.exit(1);});
}
