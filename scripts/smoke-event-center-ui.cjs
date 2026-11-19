// Real App/EventCenter with isolated deterministic service adapters and Chromium layout.
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-event-center-"));
  const env = { ...process.env, HAVVN_EVENT_CENTER_SCRATCH: scratch };
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
    const target = path.resolve(scratch);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("havvn-event-center-")
    )
      throw Error("Unexpected UI profile");
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
} else {
  const { app, BrowserWindow } = require("electron"),
    root = path.resolve(__dirname, ".."),
    scratch = path.resolve(process.env.HAVVN_EVENT_CENTER_SCRATCH || "");
  if (
    path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith("havvn-event-center-")
  )
    throw Error("Missing UI profile");
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const output = path.join(root, "dist/event-center-ui");
  fs.mkdirSync(output, { recursive: true });
  const deadline = setTimeout(() => app.exit(1), 60000);
  app
    .whenReady()
    .then(async () => {
      const settings =
        require("../dist/electron/electron/db/store.js").readSettingsImportState();
      const css =
        require("./smoke-ui-fonts.cjs")(root) +
        [
          "renderer/styles/variables.css",
          "renderer/styles/base.css",
          "renderer/styles/components.css",
          "renderer/styles/layout.css",
          "renderer/pages/DownloadsPage.css",
          "renderer/components/Modal.css",
          "renderer/components/CommandPalette.css",
          "renderer/components/EventCenter.css",
          "renderer/components/Select.css",
          "renderer/pages/DownloadViewsBar.css",
        ]
          .map((file) =>
            fs
              .readFileSync(path.join(root, file), "utf8")
              .replace(/^@import[^;]+;/gm, ""),
          )
          .join("\n");
      const html = path.join(scratch, "ui.html");
      fs.writeFileSync(
        html,
        '<html lang="ru" data-theme="dark"><meta charset="utf-8"><style>' +
          css +
          '*{animation:none!important;transition:none!important}#root{height:100vh}</style><div id="root"></div></html>',
      );
      const win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 850,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          backgroundThrottling: false,
        },
      });
      const errors = [];
      win.webContents.on("console-message", (message) => {
        if (message.level === "error") {
          errors.push(message.message);
          console.error(message.message);
        }
      });
      await win.loadFile(html);
      const run = (code) => win.webContents.executeJavaScript(code),
        pause = () => new Promise((resolve) => setTimeout(resolve, 90));
      const check = async (label, code) => {
        let result = false;
        for (let i = 0; i < 40; i++) {
          result = await run(code);
          if (result) break;
          await pause();
        }
        assert.ok(result, label);
        console.log("PASS " + label);
      };
      const key = (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      };
      await run(
        "var fixtureRoot=" +
          JSON.stringify(root) +
          ",settingsFixture=" +
          JSON.stringify(settings) +
          ",testEventCenter=true;\n" +
          fs.readFileSync(
            path.join(__dirname, "fixtures/command-palette-ui.cjs"),
            "utf8",
          ),
      );
      await pause();
      await pause();
      const openEvents = async () => {
        await run("commandsButton().click()");
        await pause();
        await run('setQuery(t("events.title"))');
        await pause();
        key("Enter");
        await check(
          "Event center opens from the command registry",
          '!!document.querySelector(".event-center")',
        );
      };
      await openEvents();
      await check(
        "First page and summary are bounded",
        'document.querySelectorAll("[data-event-id]").length===40&&document.querySelector(".event-center-head").textContent.includes("3")',
      );
      await run(
        '[...document.querySelectorAll(".event-center button")].find(button=>button.textContent===t("events.more")).click()',
      );
      await check(
        "Cursor pagination loads the remaining records",
        'document.querySelectorAll("[data-event-id]").length===58',
      );
      await run(
        '[...document.querySelectorAll(".event-center button")].find(button=>button.textContent===t("events.readAll")).click()',
      );
      await check(
        "Read-all preserves active problems",
        "eventStore.summary().unread===0&&eventStore.summary().active===3",
      );
      await run(
        '[...document.querySelectorAll(".event-center-filters button")].find(button=>button.textContent===t("events.filter.problems")).click()',
      );
      await check(
        "Problem view shows active rows only",
        'document.querySelectorAll("[data-event-id]").length===3',
      );
      await run(
        'eventButton(eventRow("download-error"),"events.action.retry").click()',
      );
      await check(
        "A stale retry button is revalidated",
        '!!document.querySelector(".event-center [role=alert]")&&retryCalls===0',
      );
      await run(
        'fixtureRows.find(row=>row.id==="fixture-79").status="error";eventButton(eventRow("download-error"),"events.action.retry").click()',
      );
      await pause();
      await run(
        'eventButton(eventRow("download-error"),"events.action.retry").click()',
      );
      await check(
        "Duplicate retry stays blocked",
        'retryCalls===1&&eventButton(eventRow("download-error"),"events.action.retry").disabled',
      );
      await run("finishRetry()");
      await pause();
      await check(
        "Successful retry alone does not mark the problem solved",
        "eventStore.summary().active===3",
      );
      await run(
        'eventStore.resolve("download-error",{kind:"download",id:"fixture-79"})',
      );
      await check(
        "Source recovery removes the active problem",
        'document.querySelectorAll("[data-event-id]").length===2&&eventStore.summary().active===2',
      );
      await run(
        'roomsLive=[];eventButton(eventRow("room-disconnected"),"events.action.open").click()',
      );
      await check(
        "Removed room produces a recoverable message",
        'document.querySelector(".event-center [role=alert]")?.textContent.includes(t("events.actionError.missing"))',
      );
      await run(
        'eventStore.record("download-error",{kind:"download",id:"fixture-79"},{reason:"permission"})',
      );
      await pause();
      await pause();
      await run(
        'eventButton(eventRow("download-error"),"events.action.open").click()',
      );
      await check(
        "Object navigation reaches the exact virtual download",
        'document.activeElement?.dataset.downloadId==="fixture-79"',
      );
      await check(
        "Leaving the page removes its subscription",
        "eventListeners.size===1",
      );
      await openEvents();
      await run(
        'dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,"renderer/i18n/en.json"),"utf8"));document.documentElement.lang="en";fixtureSetLanguage("en");eventStore.record("settings-exported",{kind:"system"})',
      );
      await pause();
      await pause();
      await check(
        "Event codes localize in English",
        'document.querySelector(".event-center h1")?.textContent==="Events"',
      );
      win.setSize(520, 750);
      await pause();
      await check(
        "Narrow history fits without horizontal overflow",
        'document.querySelector(".event-center").scrollWidth<=innerWidth&&document.querySelector(".event-center").getBoundingClientRect().right<=innerWidth',
      );
      win.webContents.invalidate();
      await win.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      });
      await run(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      fs.writeFileSync(
        path.join(output, "narrow.png"),
        (
          await win.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
        ).toPNG(),
      );
      assert.deepEqual(errors, []);
      await run("tree.unmount()");
      win.destroy();
      clearTimeout(deadline);
      console.log(JSON.stringify({ passed: true, output }));
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
