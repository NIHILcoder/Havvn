// Verify the static website in Chromium without starting the desktop application.
require("./stamp-site-assets.cjs")({ check: true });
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(
    require("electron"),
    [__filename],
    { env, windowsHide: true, stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow } = require("electron");
  const assert = require("node:assert/strict");
  const fs = require("node:fs"),
    path = require("node:path"),
    os = require("node:os");
  const root = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-site-smoke-"));
  app.setPath("userData", profile);
  app.on("window-all-closed", () => {});
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
  app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  const deadline = setTimeout(() => {
    console.error("Site smoke timed out");
    app.exit(1);
  }, 120000);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const imageHash = (image) =>
    require("node:crypto")
      .createHash("sha256")
      .update(image.toPNG())
      .digest("hex");
  app
    .whenReady()
    .then(async () => {
      const preview = require("./serve-site.cjs");
      await new Promise((resolve) => preview.listen(0, "127.0.0.1", resolve));
      const baseUrl = "http://127.0.0.1:" + preview.address().port + "/";
      const win = new BrowserWindow({
        width: 1440,
        height: 1000,
        frame: false,
        show: false,
        webPreferences: {
          offscreen: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const errors = [];
      const requests = [];
      win.webContents.session.webRequest.onBeforeRequest(
        (details, callback) => {
          requests.push(details.url);
          callback({});
        },
      );
      win.webContents.on("console-message", (detail) => {
        if (detail.level === "error") errors.push(detail.message);
      });
      const run = (code) =>
        win.webContents.executeJavaScript(code).catch((error) => {
          throw new Error("Browser check failed: " + code, { cause: error });
        });
      const waitFor = async (condition, message) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await run(condition)) return;
          await wait(100);
        }
        assert.fail(message);
      };
      await win.loadURL(baseUrl);
      await run("document.fonts.ready.then(()=>true)");
      await waitFor(
        "document.querySelector('.hero-art').dataset.scene === 'webgl'",
        "Three.js scene renders through WebGL",
      );
      assert.ok(
        requests.some((url) => url.includes("three.module.min.js")),
        "Local Three.js module loads",
      );
      assert.ok(
        requests.every(
          (url) => url.startsWith(baseUrl) || url.startsWith("data:"),
        ),
        "Website makes no external asset requests",
      );
      const screenshots = path.join(root, "artifacts", "site");
      fs.mkdirSync(screenshots, { recursive: true });
      await wait(1300);
      fs.writeFileSync(
        path.join(screenshots, "desktop.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await run("document.querySelector('#shot-downloads').focus()");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
      await wait(30);
      assert.equal(await run("document.activeElement.id==='shot-workspace' && !document.querySelector('#screen-workspace').hidden && document.querySelector('#screen-downloads').hidden"),true,'Actual application screenshots support keyboard selection');
      await run("document.querySelector('#shot-light').click()");
      assert.equal(await run("!document.querySelector('#screen-light').hidden && document.querySelector('#screen-light img').naturalWidth>0"),true,'Light application screenshot loads');
      await run("document.querySelector('#shot-downloads').click()");
      assert.equal(
        await run(
          "!document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === 0",
        ),
        true,
        "Scene controls are keyboard accessible",
      );
      await run(
        "document.querySelector('#network').scrollIntoView({behavior:'instant'});document.querySelector('#motion-toggle').click();document.querySelector('#network-scene').focus({preventScroll:true})",
      );
      await wait(80);
      const crop = await run(
        "(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {x:Math.round(b.left+b.width*.24),y:Math.round(b.top+b.height*.25),width:Math.round(b.width*.65),height:Math.round(b.height*.5)}})()",
      );
      const initialView = imageHash(await win.webContents.capturePage(crop));
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await wait(80);
      const rotatedView = imageHash(await win.webContents.capturePage(crop));
      assert.notEqual(
        rotatedView,
        initialView,
        "Arrow keys visibly rotate the paused sculpture",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
      await wait(80);
      const resetView = imageHash(await win.webContents.capturePage(crop));
      assert.notEqual(
        resetView,
        rotatedView,
        "Home visibly resets the rotated sculpture",
      );
      await run("document.querySelector('#scene-explode').click()");
      assert.equal(await run("document.querySelector('#scene-explode').getAttribute('aria-pressed')"),'true','Sculpture can be separated while motion is paused');
      await wait(80);
      fs.writeFileSync(path.join(screenshots,'network-exploded.png'),(await win.webContents.capturePage()).toPNG());
      await run("document.querySelector('#scene-reset').click();document.querySelector('#network-scene').focus({preventScroll:true})");
      assert.equal(await run("document.querySelector('#scene-explode').getAttribute('aria-pressed')"),'false','Reset reassembles the sculpture');
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await wait(50);
      assert.equal(
        await run(
          "/→ 6/.test(document.querySelector('#scene-status').textContent)",
        ),
        true,
        "Enter sends a pulse while paused",
      );
      await run("document.querySelector('#language').click()");
      await wait(20);
      assert.equal(
        await run(
          "document.querySelector('#scene-status').textContent.startsWith(document.documentElement.lang==='ru'?'Демо P2P · узел':'P2P demo · peer')",
        ),
        true,
        "Selected peer status follows language",
      );
      await run("document.querySelector('#scene-reset').click()");
      const canvasBounds = await run(
        "(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height}})()",
      );
      const dragX = Math.round(canvasBounds.left + canvasBounds.width * 0.68);
      const dragY = Math.round(canvasBounds.top + canvasBounds.height * 0.48);
      const mouse = (type, x, y, extra = {}) =>
        win.webContents.sendInputEvent({ type, x, y, ...extra });
      mouse("mouseDown", dragX, dragY, { button: "left", clickCount: 1 });
      mouse("mouseMove", dragX + 65, dragY + 25, {
        modifiers: ["leftButtonDown"],
      });
      mouse("mouseUp", dragX + 65, dragY + 25, {
        button: "left",
        clickCount: 1,
      });
      await wait(80);
      assert.notEqual(
        imageHash(await win.webContents.capturePage(crop)),
        resetView,
        "Mouse drag visibly rotates the sculpture",
      );
      assert.equal(
        await run(
          "document.querySelector('#scene-status').textContent.includes('→')",
        ),
        false,
        "Dragging does not accidentally activate a peer",
      );
      await run("document.querySelector('#scene-reset').click()");
      // Click a small grid on the upper/front network, without reading scene internals.
      let picked = false;
      for (const y of [0.18, 0.24, 0.3, 0.36]) {
        for (const x of [0.48, 0.56, 0.64, 0.72, 0.8, 0.88]) {
          const px = Math.round(canvasBounds.left + canvasBounds.width * x),
            py = Math.round(canvasBounds.top + canvasBounds.height * y);
          mouse("mouseDown", px, py, { button: "left", clickCount: 1 });
          mouse("mouseUp", px, py, { button: "left", clickCount: 1 });
          await wait(15);
          picked = await run(
            "document.querySelector('#scene-status').textContent.includes('→')",
          );
          if (picked) break;
        }
        if (picked) break;
      }
      assert.ok(picked, "Clicking a network peer selects it and sends a pulse");
      await run(
        "document.querySelector('#scene-reset').click();document.querySelector('#scene-pulse').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#scene-status').textContent.includes('→ 6')",
        ),
        true,
        "Pulse button selects a peer",
      );
      fs.writeFileSync(
        path.join(screenshots, "interactive.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await run(
        "document.querySelector('#scene-reset').click();document.querySelector('#motion-toggle').click()",
      );
      assert.equal(
        await run(
          "document.styleSheets.length > 0 && [...document.images].every(image=>image.complete && image.naturalWidth>0)",
        ),
        true,
        "Styles and images load",
      );
      assert.equal(
        await run(
          "document.fonts.check(document.documentElement.lang==='ru'?'600 50px \"Exo 2\"':'600 50px \"Chakra Petch\"') && document.fonts.check('400 15px Inter')",
        ),
        true,
        "Local fonts load",
      );
      const localAssets = await run(
        "[...document.querySelectorAll('link[href],script[src],img[src]')].map(el=>el.getAttribute('href')||el.getAttribute('src')).filter(url=>url&&!/^(https?:|#)/.test(url))",
      );
      localAssets.forEach((asset) =>
        assert.ok(
          fs.existsSync(
            path.resolve(
              root,
              "docs",
              new URL(asset, "http://localhost/").pathname.slice(1),
            ),
          ),
          "Local asset exists: " + asset,
        ),
      );
      assert.deepEqual(
        await run(
          "[...document.querySelectorAll('a[href^=\"#\"]')].map(el=>el.getAttribute('href')).filter(href=>href!=='#'&&!document.querySelector(href))",
        ),
        [],
        "All anchor destinations exist",
      );

      const checks = [];
      for (const width of [
        320, 360, 390, 600, 768, 900, 1024, 1280, 1440, 1920, 2560,
      ]) {
        win.setSize(width, 900);
        await wait(70);
        for (const language of ["en", "ru"]) {
          await run(
            "if(document.documentElement.lang!==" +
              JSON.stringify(language) +
              ")document.querySelector('#language').click()",
          );
          await run("document.fonts.ready.then(()=>true)");
          const metrics = await run(
            "({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})",
          );
          if (metrics.scroll > metrics.client + 1)
            console.error(
              await run(
                "[...document.querySelectorAll('main *,header *,footer *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>document.documentElement.clientWidth+1||b.left< -1)}).slice(0,10).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,45),width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right}))",
              ),
            );
          assert.ok(
            metrics.scroll <= metrics.client + 1,
            width +
              "px " +
              language +
              " has no horizontal overflow: " +
              JSON.stringify(metrics),
          );
          if (width >= 1600) {
            const alignment = await run(
              "({sceneRight:document.querySelector('.hero-art').getBoundingClientRect().right,contentRight:document.querySelector('nav.wrap').getBoundingClientRect().right})",
            );
            assert.ok(
              alignment.sceneRight <= alignment.contentRight + 80,
              width +
                "px " +
                language +
                " hero scene stays beside the centered content",
            );
          }
          checks.push(width + ":" + language);
          for (const mode of ["voice", "files", "watch"]) {
            await run(
              "document.querySelector('#room-mode-" + mode + "').click()",
            );
            assert.equal(
              await run(
                "document.documentElement.scrollWidth<=document.documentElement.clientWidth+1",
              ),
              true,
              width +
                "px " +
                language +
                " room " +
                mode +
                " has no horizontal overflow",
            );
          }
        }
      }
      assert.equal(
        await run(
          "document.title.includes('хорошая компания') && document.querySelector('meta[name=\"description\"]').content.includes('Бесплатный')",
        ),
        true,
        "Russian metadata",
      );
      assert.equal(
        await run("localStorage.getItem('havvn-site-language')"),
        "ru",
        "Language preference persists",
      );
      await new Promise((resolve) => {
        win.webContents.once("did-finish-load", resolve);
        win.reload();
      });
      await wait(100);
      assert.equal(
        await run("document.documentElement.lang"),
        "ru",
        "Stored language survives reload",
      );
      await run("document.querySelector('#tab-downloads').focus()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await wait(30);
      assert.equal(
        await run(
          "document.activeElement.id === 'tab-rooms' && !document.querySelector('#panel-rooms').hidden && document.querySelector('#panel-downloads').hidden",
        ),
        true,
        "Keyboard switches tabs and focus",
      );
      await run(
        "document.querySelector('#tab-watch').click();document.querySelector('#demo-play').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#demo-play').getAttribute('aria-pressed')==='true' && document.querySelector('.cinema').classList.contains('is-playing')",
        ),
        true,
        "Play demo",
      );
      await run("document.querySelector('#language').click()");
      assert.equal(
        await run("document.querySelector('#demo-state').textContent"),
        "Demo playing",
        "Language preserves demo state",
      );
      await run("document.querySelector('#tab-downloads').click()");
      assert.equal(
        await run(
          "document.querySelector('#demo-play').getAttribute('aria-pressed')",
        ),
        "false",
        "Leaving watch pauses demo",
      );

      await run(
        "document.querySelector('#demo-search').value='ubuntu';document.querySelector('#demo-search').dispatchEvent(new Event('input',{bubbles:true}))",
      );
      assert.deepEqual(
        await run(
          "[...document.querySelectorAll('[data-file]:not([hidden]) b')].map(e=>e.textContent)",
        ),
        ["Ubuntu Desktop"],
        "Sample search filters files",
      );
      await run(
        "document.querySelector('#demo-search').value='no-such-file';document.querySelector('#demo-search').dispatchEvent(new Event('input',{bubbles:true}))",
      );
      assert.equal(
        await run("!document.querySelector('#demo-empty').hidden"),
        true,
        "Sample search has an empty state",
      );
      await run(
        "document.querySelector('#demo-search').value='';document.querySelector('#demo-search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#demo-transfer').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#demo-transfer').getAttribute('aria-pressed')==='true' && document.querySelector('#transfer-status').textContent.includes('paused')",
        ),
        true,
        "Sample transfer can be paused",
      );
      await run(
        "document.querySelector('#demo-transfer').click();document.querySelector('#tab-rooms').click();document.querySelector('#demo-invite').click()",
      );
      assert.equal(
        await run(
          "!document.querySelector('#demo-guest').hidden && document.querySelector('#guest-count').textContent==='3 people'",
        ),
        true,
        "Invitation adds a sample guest",
      );
      await run(
        "document.querySelector('#demo-message').value='<img src=x onerror=alert(1)>';document.querySelector('#demo-chat').requestSubmit()",
      );
      assert.equal(
        await run(
          "document.querySelector('[data-local-message] p').textContent",
        ),
        "<img src=x onerror=alert(1)>",
        "Chat treats user input as text",
      );
      assert.equal(
        await run("document.querySelectorAll('#demo-messages img').length"),
        0,
        "Chat does not inject HTML",
      );
      await run("document.querySelector('#language').click()");
      assert.equal(
        await run(
          "document.querySelector('#guest-count').textContent==='3 участника' && document.querySelector('[data-demo-author]').textContent==='Ты'",
        ),
        true,
        "Language preserves demo state and translates local labels",
      );
      await run(
        "document.querySelector('#language').click();document.querySelector('#demo-invite').click()",
      );
      const previewBackground = await run(
        "getComputedStyle(document.querySelector('.app-preview')).backgroundColor",
      );
      await run("document.querySelector('[data-preview-theme=paper]').click()");
      assert.notEqual(
        await run(
          "getComputedStyle(document.querySelector('.app-preview')).backgroundColor",
        ),
        previewBackground,
        "Appearance switch visibly changes the mockup",
      );
      assert.equal(
        await run(
          "document.querySelectorAll('[data-preview-theme][aria-pressed=true]').length",
        ),
        1,
        "Exactly one preview palette is selected",
      );
      await run(
        "document.querySelector('[data-preview-theme=moss]').click();document.querySelector('[data-preview-theme=graphite]').click();document.querySelector('#tab-downloads').click()",
      );
      await run("document.querySelector('#platform-windows').focus()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await wait(30);
      assert.equal(
        await run(
          "document.activeElement.id==='platform-linux' && !document.querySelector('#download-linux').hidden && document.querySelector('#download-windows').hidden",
        ),
        true,
        "Platform picker supports keyboard navigation",
      );
      await run("document.querySelector('#platform-windows').click()");
      await run("document.querySelector('#room-mode-watch').focus()");
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
      await wait(30);
      assert.equal(
        await run(
          "document.activeElement.id==='room-mode-voice' && !document.querySelector('#room-scene-voice').hidden && document.querySelector('#room-scene-watch').hidden",
        ),
        true,
        "Room modes support arrow-key selection",
      );
      await run(
        "document.querySelector('#room-mic').click();document.querySelector('#language').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#room-mic').getAttribute('aria-pressed')==='true' && document.querySelector('#room-mic-status').textContent==='Демо-голос выключен'",
        ),
        true,
        "Sample microphone state survives language switching",
      );
      await run(
        "document.querySelector('#language').click();document.querySelector('#room-mic').click();document.querySelector('#room-mode-voice').focus()",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "End" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "End" });
      await wait(30);
      assert.equal(
        await run(
          "document.activeElement.id==='room-mode-files' && !document.querySelector('#room-scene-files').hidden",
        ),
        true,
        "End selects the room file preview",
      );
      await run(
        "document.querySelector('#room-mode-watch').click();document.querySelector('.room-demo-link').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#tab-rooms').getAttribute('aria-selected')==='true' && !document.querySelector('#panel-rooms').hidden",
        ),
        true,
        "Room call to action opens the chat demonstration",
      );
      assert.ok(
        requests.every(
          (url) => url.startsWith(baseUrl) || url.startsWith("data:"),
        ),
        "Product demos make no external requests",
      );

      win.setSize(390, 844);
      await wait(70);
      await run("document.querySelector('#menu-toggle').click()");
      assert.equal(
        await run(
          "getComputedStyle(document.querySelector('#navigation')).display !== 'none' && document.querySelector('#menu-toggle').getAttribute('aria-expanded')==='true'",
        ),
        true,
        "Mobile menu opens",
      );
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await wait(30);
      assert.equal(
        await run(
          "document.querySelector('#menu-toggle').getAttribute('aria-expanded')==='false' && document.activeElement.id==='menu-toggle'",
        ),
        true,
        "Escape closes menu and restores focus",
      );
      await run(
        "document.querySelector('#menu-toggle').click();document.querySelector('#navigation a').click()",
      );
      assert.equal(
        await run(
          "document.querySelector('#menu-toggle').getAttribute('aria-expanded')",
        ),
        "false",
        "Navigation closes menu",
      );
      await run(
        "document.querySelector('#faq details').open=true;document.querySelector('.verify').open=true",
      );
      assert.equal(
        await run(
          "document.querySelector('#faq details').open && document.querySelector('.verify').open",
        ),
        true,
        "FAQ and verification expand",
      );
      assert.deepEqual(errors, [], "No browser console errors");
      await run(
        "document.documentElement.style.scrollBehavior='auto';document.querySelector('#network').scrollIntoView({behavior:'instant'})",
      );
      await wait(100);
      await waitFor(
        "document.querySelector('.hero-art').dataset.scene === 'webgl'",
        "Three.js scene returns after reload",
      );
      const sceneBefore = await run(
        "document.querySelector('#network-scene').dataset.frame",
      );
      await wait(250);
      assert.notEqual(
        await run("document.querySelector('#network-scene').dataset.frame"),
        sceneBefore,
        "Three.js scene animates",
      );
      await run("document.querySelector('#motion-toggle').click()");
      await wait(30);
      const still = await run(
        "document.querySelector('#network-scene').dataset.frame",
      );
      await wait(100);
      assert.equal(
        await run("document.querySelector('#network-scene').dataset.frame"),
        still,
        "Motion control freezes the scene",
      );
      await run("document.querySelector('#motion-toggle').click()");

      win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      assert.equal(
        await run(
          "matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('.hero-mark')).animationName==='none' && getComputedStyle(document.querySelector('.scene-halo')).animationName==='none'",
        ),
        true,
        "Reduced motion disables animation",
      );
      await wait(100);
      const reducedFrame = await run(
        "document.querySelector('#network-scene').dataset.frame",
      );
      await wait(150);
      assert.equal(
        await run("document.querySelector('#network-scene').dataset.frame"),
        reducedFrame,
        "Reduced motion freezes WebGL rendering",
      );
      await run("document.querySelector('#scene-pulse').click()");
      assert.equal(
        await run(
          "document.querySelector('#scene-status').textContent.includes('→ 6')",
        ),
        true,
        "Reduced motion supports a static selected route",
      );
      await run("document.querySelector('#scene-reset').click()");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [],
      });
      win.webContents.debugger.detach();
      // Restoring normal motion restarts the CSS entrance; capture its settled state.
      win.setSize(390, 1250);
      await wait(1200);
      fs.writeFileSync(
        path.join(screenshots, "network-mobile.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await run("document.querySelector('#motion-toggle').click()");
      win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        { enabled: true, maxTouchPoints: 1 },
      );
      const touchBounds = await run(
        "(()=>{const b=document.querySelector('#network-scene').getBoundingClientRect();return {x:Math.round(b.left+b.width*.53),y:Math.round(b.top+b.height*.43)}})()",
      );
      const touchBefore = imageHash(await win.webContents.capturePage());
      await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: touchBounds.x, y: touchBounds.y, id: 1 }],
      });
      await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: touchBounds.x + 70, y: touchBounds.y, id: 1 }],
      });
      await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await wait(80);
      assert.notEqual(
        imageHash(await win.webContents.capturePage()),
        touchBefore,
        "Touch drag visibly rotates the sculpture",
      );
      assert.equal(
        await run(
          "getComputedStyle(document.querySelector('#network-scene')).touchAction",
        ),
        "pan-y",
        "Scene permits vertical page scrolling on touch screens",
      );
      await win.webContents.debugger.sendCommand(
        "Emulation.setTouchEmulationEnabled",
        { enabled: false },
      );
      win.webContents.debugger.detach();
      await run(
        "document.querySelector('#scene-reset').click();document.querySelector('#motion-toggle').click()",
      );
      await run(
        "document.querySelector('#download').scrollIntoView({behavior:'instant'})",
      );
      await wait(200);
      const offscreenFrame = await run(
        "document.querySelector('#network-scene').dataset.frame",
      );
      await wait(150);
      assert.equal(
        await run("document.querySelector('#network-scene').dataset.frame"),
        offscreenFrame,
        "Offscreen scene stops rendering",
      );
      await run("document.querySelector('#network').scrollIntoView({behavior:'instant'})");
      await wait(200);
      assert.notEqual(
        await run("document.querySelector('#network-scene').dataset.frame"),
        offscreenFrame,
        "Scene resumes on return",
      );
      await run(
        "window.contextLossTest = document.querySelector('#network-scene').getContext('webgl2').getExtension('WEBGL_lose_context');window.contextLossTest.loseContext()",
      );
      await waitFor(
        "document.querySelector('.hero-art').dataset.scene === 'fallback'",
        "Context loss shows the original SVG",
      );
      assert.equal(
        await run(
          "getComputedStyle(document.querySelector('.hero-sculpture')).visibility",
        ),
        "visible",
        "Brand remains visible after context loss",
      );
      assert.equal(
        await run(
          "document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === -1",
        ),
        true,
        "Unavailable scene controls leave the tab order",
      );
      await run("window.contextLossTest.restoreContext()");
      await waitFor(
        "document.querySelector('.hero-art').dataset.scene === 'webgl'",
        "Scene recovers after context restoration",
      );
      assert.deepEqual(
        errors,
        [],
        "No browser errors after scene lifecycle checks",
      );
      await run(
        "document.querySelectorAll('[data-local-message]').forEach(e=>e.remove());document.querySelector('#demo-messages').scrollTop=0;document.querySelector('.verify').open=false;document.querySelectorAll('#faq details').forEach(e=>e.open=true)",
      );
      win.setSize(1440, 1000);
      await wait(100);
      await run(
        "if(document.documentElement.lang!=='ru')document.querySelector('#language').click()",
      );
      for (const [file, section, tab] of [
        ["experience", "#experience", "#tab-downloads"],
        ["room-demo", "#experience", "#tab-rooms"],
        ["watch-demo", "#experience", "#tab-watch"],
        ["rooms", "#rooms"],
        ["features", "#features"],
        ["privacy", "#privacy"],
        ["download", "#download"],
      ]) {
        if (tab)
          await run(
            "document.querySelector(" + JSON.stringify(tab) + ").click()",
          );
        await run(
          "document.querySelector(" +
            JSON.stringify(section) +
            ").scrollIntoView({behavior:'instant'})",
        );
        await wait(1100);
        fs.writeFileSync(
          path.join(screenshots, file + ".png"),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      for (const mode of ["voice", "files", "watch"]) {
        await run(
          "document.querySelector('#room-mode-" +
            mode +
            "').click();document.querySelector('#rooms').scrollIntoView({behavior:'instant'})",
        );
        await wait(100);
        fs.writeFileSync(
          path.join(screenshots, "rooms-" + mode + ".png"),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      win.setSize(390, 1250);
      await wait(100);
      await run(
        "document.querySelector('#rooms').scrollIntoView({behavior:'instant'})",
      );
      await wait(100);
      fs.writeFileSync(
        path.join(screenshots, "rooms-mobile.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await run("window.scrollTo({top:0,behavior:'instant'})"); await wait(100);
      fs.writeFileSync(path.join(screenshots,'mobile.png'),(await win.webContents.capturePage()).toPNG());
      win.setSize(1440,1000); await wait(100);
      await run("document.querySelector('#signal-outro').scrollIntoView({behavior:'instant'})");
      await waitFor("document.querySelector('#signal-outro').dataset.scene==='webgl'",'Scroll finale renders through Three.js');
      assert.ok(await run("Number(document.querySelector('#signal-canvas').dataset.instances)>300"),'Finale wordmark uses real instanced geometry');
      const signalBounds=await run("(()=>{const e=document.querySelector('#signal-outro'),header=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-height'));return {top:scrollY+e.getBoundingClientRect().top-header,travel:e.offsetHeight-(innerHeight-header)}})()");
      const seekSignal=async progress=>{
        await run('window.scrollTo({top:'+Math.round(signalBounds.top+signalBounds.travel*progress)+",behavior:'instant'})");
        await wait(120);
      };
      await seekSignal(.2);
      assert.ok(await run("Number(document.querySelector('#signal-outro').dataset.progress)<.3"),'Finale progress follows scroll position');
      fs.writeFileSync(path.join(screenshots,'signal-scattered.png'),(await win.webContents.capturePage()).toPNG());
      await seekSignal(.7);
      assert.ok(await run("parseFloat(document.querySelector('#signal-outro').style.getPropertyValue('--signal-blur'))>0"),'Scroll produces bounded blur in the finale');
      fs.writeFileSync(path.join(screenshots,'signal-glitch.png'),(await win.webContents.capturePage()).toPNG());
      await seekSignal(.99); await wait(900);
      assert.ok(await run("Number(document.querySelector('#signal-outro').dataset.progress)>.9"),'Finale settles into the assembled wordmark');
      fs.writeFileSync(path.join(screenshots,'signal-complete.png'),(await win.webContents.capturePage()).toPNG());
      const idleSignalFrame=await run("document.querySelector('#signal-canvas').dataset.frame");
      await wait(160);
      assert.equal(await run("document.querySelector('#signal-canvas').dataset.frame"),idleSignalFrame,'Finale does not render continuously while idle');
      await run("document.querySelector('#outro-motion').click()");
      await seekSignal(.3);
      assert.equal(await run("document.querySelector('#signal-outro').dataset.progress==='1.0000' && document.querySelector('#signal-outro').style.getPropertyValue('--signal-blur')==='0px'"),true,'Pause removes glitch and shows a static complete wordmark');
      await run("document.querySelector('#outro-motion').click()");
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await run("document.querySelector('#signal-outro').scrollIntoView({behavior:'instant'})");
      await wait(200);
      const stillSignal=await run("document.querySelector('#signal-canvas').dataset.frame");
      await wait(150);
      assert.equal(await run("document.querySelector('#signal-canvas').dataset.frame"),stillSignal,'Reduced-motion finale stays static');
      assert.equal(await run("document.querySelector('#signal-outro').dataset.progress==='1.0000' && getComputedStyle(document.querySelector('#signal-canvas')).filter==='none'"),true,'Reduced motion disables blur and the assembly transition');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      win.webContents.debugger.detach();
      await run("window.signalLossTest=document.querySelector('#signal-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');window.signalLossTest.loseContext()");
      await waitFor("document.querySelector('#signal-outro').dataset.scene==='fallback'",'Finale survives context loss');
      assert.equal(await run("getComputedStyle(document.querySelector('.signal-fallback')).visibility"),'visible','Finale shows a legible fallback wordmark');
      await run("window.signalLossTest.restoreContext()");
      await waitFor("document.querySelector('#signal-outro').dataset.scene==='webgl'",'Finale restores its WebGL resources');
      win.setSize(390,844);await wait(100);
      await run("document.querySelector('#signal-outro').scrollIntoView({behavior:'instant'})");
      await wait(180);
      assert.equal(await run("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"),true,'Mobile scroll finale fits the viewport');
      fs.writeFileSync(path.join(screenshots,'signal-mobile.png'),(await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors,[],'No browser errors in application screenshots or the WebGL finale');
      win.destroy();

      // Observe the presentation as a visitor: no clicks or focused controls needed.
      const autoplay = new BrowserWindow({
        width: 1440, height: 1000, frame: false, show: false,
        webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      autoplay.webContents.on('console-message', (detail) => {
        if (detail.level === 'error') errors.push(detail.message);
      });
      const autoRun = (code) => autoplay.webContents.executeJavaScript(code);
      const autoWait = async (condition, message) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await autoRun(condition)) return;
          await wait(100);
        }
        assert.fail(message);
      };
      const autoShot = async (file) => fs.writeFileSync(path.join(screenshots, file + '.png'), (await autoplay.webContents.capturePage()).toPNG());
      await autoplay.loadURL(baseUrl);
      await autoRun("document.fonts.ready.then(()=>true)");
      await autoRun("document.querySelector('.app-preview').scrollIntoView({behavior:'instant',block:'center'})");
      await autoWait("document.querySelector('#experience').dataset.presentationState==='playing'", 'Product presentation starts on entering the viewport');
      await autoRun("window.autoStatusChanges=0;window.autoStatusObserver=new MutationObserver(records=>window.autoStatusChanges+=records.length);document.querySelectorAll('#guest-count,#transfer-status,#room-mic-status').forEach(e=>window.autoStatusObserver.observe(e,{childList:true,characterData:true,subtree:true}))");
      await wait(7800);
      assert.equal(await autoRun("document.querySelector('#tab-rooms').getAttribute('aria-selected')"), 'true', 'Product scenarios advance without interaction');
      assert.equal(await autoRun("window.autoStatusChanges"), 0, 'Automatic scenes do not repeatedly announce unchanged live statuses');
      await autoRun("window.autoStatusObserver.disconnect()");
      await wait(1700);
      await autoShot('presentation-chat');
      await autoRun("document.querySelector('#demo-message').focus();document.querySelector('#demo-message').value='Keep my draft';document.querySelector('#demo-message').dispatchEvent(new Event('input',{bubbles:true}))");
      const manualStep = await autoRun("document.querySelector('#experience').dataset.sequenceStep");
      await wait(7600);
      assert.equal(await autoRun("document.querySelector('#experience').dataset.sequenceStep"), manualStep, 'Autoplay never replaces a focused input or current demo');
      assert.equal(await autoRun("document.querySelector('#demo-message').value"), 'Keep my draft', 'Manual input survives the presentation timer');
      await autoRun("document.activeElement.blur();document.querySelector('.room-preview').scrollIntoView({behavior:'instant',block:'center'})");
      await autoWait("document.querySelector('#rooms').dataset.presentationState==='playing'", 'Rooms start presenting on their own');
      await wait(7100);
      assert.equal(await autoRun("document.querySelector('#room-mode-voice').getAttribute('aria-selected')"), 'true', 'Room presentation advances to voice automatically');
      assert.equal(await autoRun("getComputedStyle(document.querySelector('.room-level i')).animationPlayState"), 'running', 'Voice drawing animates in the visible scene');
      await autoShot('presentation-voice');
      await autoRun("document.querySelector('#motion-toggle').click()");
      await wait(100);
      const voiceTime = await autoRun("document.querySelector('.room-level i').getAnimations()[0].currentTime");
      await wait(200);
      assert.equal(await autoRun("document.querySelector('.room-level i').getAnimations()[0].currentTime"), voiceTime, 'Global pause freezes the automatic drawings');
      assert.equal(await autoRun("document.querySelector('#rooms').dataset.presentationState"), 'paused', 'Global pause also stops the scene timer');
      await autoRun("document.querySelector('#motion-toggle').click()");
      autoplay.webContents.debugger.attach('1.3');
      await autoplay.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: [{name:'prefers-reduced-motion',value:'reduce'}]});
      await wait(100);
      assert.equal(await autoRun("document.querySelectorAll('[data-presentation-state=playing]').length"), 0, 'Reduced motion prevents automatic scene changes');
      assert.equal(await autoRun("getComputedStyle(document.querySelector('.room-level i')).animationName"), 'none', 'Reduced motion shows static drawings');
      await autoplay.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features: []});
      autoplay.webContents.debugger.detach();
      const offscreenStep = await autoRun("document.querySelector('#rooms').dataset.sequenceStep");
      await autoRun("window.scrollTo({top:0,behavior:'instant'})");
      await autoWait("document.querySelector('#overview').dataset.presentationState==='playing'", 'Screenshot gallery starts when visible');
      await wait(7100);
      assert.equal(await autoRun("document.querySelector('#rooms').dataset.sequenceStep"), offscreenStep, 'Offscreen sections do not advance their presentation');
      assert.equal(await autoRun("document.querySelector('#shot-workspace').getAttribute('aria-selected')"), 'true', 'Actual application screenshots advance automatically');
      await autoShot('presentation-gallery');
      await autoRun("document.querySelector('.hero-art').scrollIntoView({behavior:'instant',block:'center'})");
      await autoWait("document.querySelector('.hero-art').dataset.autoCue==='1'", 'Three.js mark unfolds without interaction');
      await wait(550);
      assert.equal(await autoRun("document.querySelector('#scene-explode').getAttribute('aria-pressed')"), 'true', 'Automatic network sequence visibly separates the mark');
      await autoShot('presentation-network');
      autoplay.setSize(390,844);
      await autoRun("document.querySelector('.room-preview').scrollIntoView({behavior:'instant',block:'center'})");
      await wait(1300);
      assert.equal(await autoRun("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"), true, 'Mobile presentation fits the viewport');
      await autoShot('presentation-mobile');
      await autoRun("document.querySelector('.capability-item').scrollIntoView({behavior:'instant',block:'center'})");
      await wait(1300);
      await autoShot('presentation-tools-mobile');
      assert.equal(await autoRun("[...document.querySelectorAll('.capability-item > p')].every(e=>e.getBoundingClientRect().height>0)"), true, 'Every tool description is available without expanding anything');
      assert.equal(await autoRun("[...document.querySelectorAll('#faq details')].every(e=>e.open)"), true, 'FAQ answers are visible without clicks');
      assert.deepEqual(errors, [], 'Automatic presentation produces no browser errors');
      autoplay.destroy();

      const fallback = new BrowserWindow({
        width: 390,
        height: 844,
        frame: false,
        show: false,
        webPreferences: {
          offscreen: true,
          webgl: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await fallback.loadURL(baseUrl);
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await fallback.webContents.executeJavaScript(
            "document.querySelector('.hero-art').dataset.scene === 'fallback'",
          )
        )
          break;
        await wait(100);
      }
      assert.equal(
        await fallback.webContents.executeJavaScript(
          "document.querySelector('.hero-art').dataset.scene === 'fallback' && getComputedStyle(document.querySelector('.hero-sculpture')).visibility === 'visible'",
        ),
        true,
        "No WebGL keeps the SVG fallback visible",
      );
      assert.equal(
        await fallback.webContents.executeJavaScript(
          "document.querySelector('.scene-tools').hidden && document.querySelector('#network-scene').tabIndex === -1",
        ),
        true,
        "No WebGL hides interactive controls",
      );
      await fallback.webContents.executeJavaScript(
        "document.querySelector('#language').click();document.querySelector('#motion-toggle').click()",
      );
      assert.equal(
        await fallback.webContents.executeJavaScript(
          "document.querySelector('#motion-toggle').getAttribute('aria-pressed')",
        ),
        "true",
        "Controls work without WebGL",
      );
      await fallback.webContents.executeJavaScript(
        "document.querySelector('#signal-outro').scrollIntoView({behavior:'instant'})",
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await fallback.webContents.executeJavaScript(
          "document.querySelector('#signal-outro').dataset.scene==='fallback'",
        )) break;
        await wait(100);
      }
      assert.equal(await fallback.webContents.executeJavaScript(
        "document.querySelector('#signal-outro').dataset.scene==='fallback' && getComputedStyle(document.querySelector('.signal-fallback')).visibility==='visible' && document.querySelector('.signal-bottom .button').getBoundingClientRect().height>0",
      ), true, 'Finale preserves the wordmark and download link without WebGL');
      fallback.destroy();

      const plain = new BrowserWindow({
        width: 390,
        height: 844,
        frame: false,
        show: false,
        webPreferences: { offscreen: true, javascript: false },
      });
      await plain.loadURL(baseUrl);
      // Inspect through the DevTools protocol while page JavaScript remains disabled.
      plain.webContents.debugger.attach("1.3");
      const visible = await plain.webContents.debugger.sendCommand(
        "Runtime.evaluate",
        {
          expression:
            "document.querySelector('h1').getBoundingClientRect().height>0 && document.querySelector('#panel-downloads').getBoundingClientRect().height>0 && document.querySelector('#download-windows a').getAttribute('href').endsWith('/releases/latest') && document.querySelector('.scene-tools').hidden",
          returnByValue: true,
        },
      );
      assert.equal(
        visible.result.value,
        true,
        "Content stays visible without JavaScript",
      );
      plain.webContents.debugger.detach();
      plain.destroy();
      console.log(
        JSON.stringify(
          {
            result: "passed",
            layouts: checks,
            screenshots,
            checks: [
              "asset cache hashes",
              "local Three.js assets",
              "no external requests",
              "fonts",
              "anchors",
              "language persistence",
              "metadata",
              "keyboard tabs",
              "actual application screenshot gallery",
              "automatic gallery, product and room sequences",
              "automatic Three.js unfolding and pulses",
              "manual takeover preserves input",
              "presentation pause, reduced motion and offscreen suspension",
              "demo controls",
              "sample file search and pause",
              "local chat and guest invitation",
              "preview appearance palettes",
              "keyboard platform picker",
              "room feature tabs at every layout",
              "sample voice state and language",
              "room chat navigation",
              "mobile navigation",
              "FAQ",
              "keyboard scene rotation and reset",
              "mouse and touch dragging",
              "peer picking and pulse controls",
              "manual sculpture disassembly and reset",
              "translated peer status",
              "WebGL animation and pause",
              "offscreen suspension",
              "reduced motion with manual interaction",
              "WebGL context restoration",
              "instanced scroll finale and bounded blur",
              "finale idle suspension and reduced motion",
              "finale pause and context restoration",
              "no WebGL fallback",
              "no JavaScript",
              "browser console",
            ],
          },
          null,
          2,
        ),
      );
      preview.close();
      clearTimeout(deadline);
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
