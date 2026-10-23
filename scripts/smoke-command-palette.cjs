/* Isolated Electron UI: real App, palette, hotkeys, settings and virtualized downloads. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
if (!process.versions.electron) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "havvn-commands-ui-"));
  const env = { ...process.env, HAVVN_COMMANDS_SCRATCH: scratch };
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
      !path.basename(target).startsWith("havvn-commands-ui-")
    )
      throw Error("Unexpected fixture path");
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
} else {
  const { app, BrowserWindow } = require("electron");
  const root = path.resolve(__dirname, ".."),
    scratch = path.resolve(process.env.HAVVN_COMMANDS_SCRATCH || "");
  if (
    path.dirname(scratch) !== path.resolve(os.tmpdir()) ||
    !path.basename(scratch).startsWith("havvn-commands-ui-")
  )
    throw Error("Missing isolated profile");
  const output = path.join(root, "dist/command-palette-ui");
  fs.mkdirSync(output, { recursive: true });
  app.setPath("userData", path.join(scratch, "profile"));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => {
    console.error("Command palette deadline");
    app.exit(1);
  }, 90000);
  app
    .whenReady()
    .then(async () => {
      const db = require(path.join(root, "dist/electron/electron/db/store.js"));
      const fixture = db.readSettingsImportState();
      const css =
        require("./smoke-ui-fonts.cjs")(root) +
        [
          "renderer/styles/variables.css",
          "renderer/styles/base.css",
          "renderer/styles/components.css",
          "renderer/styles/layout.css",
          "renderer/pages/DownloadsPage.css",
          "renderer/pages/SettingsPage.css",
          "renderer/pages/settings/shell.css",
          "renderer/pages/settings/controls.css",
          "renderer/components/Modal.css",
          "renderer/components/CommandPalette.css",
          "renderer/components/Select.css",
          "renderer/pages/DownloadViewsBar.css",
        ]
          .map((file) =>
            fs
              .readFileSync(path.join(root, file), "utf8")
              .replace(/^@import[^;]+;/gm, ""),
          )
          .join("\n");
      const page = path.join(scratch, "ui.html");
      fs.writeFileSync(
        page,
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
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") {
          errors.push(details.message);
          console.error("Renderer:", details.message);
        }
      });
      await win.loadFile(page);
      const run = (code) => win.webContents.executeJavaScript(code);
      const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
      const capture = async (name) => {
        win.webContents.invalidate();
        await win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        await run(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        fs.writeFileSync(
          path.join(output, name),
          (
            await win.webContents.capturePage(undefined, {
              stayHidden: true,
              stayAwake: true,
            })
          ).toPNG(),
        );
      };
      await run(
        "var fixtureRoot=" +
          JSON.stringify(root) +
          ",settingsFixture=" +
          JSON.stringify(fixture) +
          ";\n" +
          fs.readFileSync(
            path.join(__dirname, "fixtures/command-palette-ui.cjs"),
            "utf8",
          ),
      );
      const check = async (label, code) => {
        let ok = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          ok = await run(code);
          if (ok) break;
          await pause();
        }
        if (!ok)
          console.error(
            await run(
              '({active:document.activeElement?.outerHTML.slice(0,500),heading:document.querySelector("h1")?.textContent,query:document.querySelector("[role=combobox]")?.value,options:[...document.querySelectorAll("[role=option]")].slice(0,3).map(el=>el.textContent),target:document.querySelector("[data-settings-search-target]")?.outerHTML.slice(0,500)})',
            ),
          );
        assert.ok(ok, label);
        console.log("PASS " + label);
      };
      const key = (keyCode, modifiers = []) => {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      };
      const open = async () => {
        key("k", ["control"]);
        await pause();
        await pause();
      };
      const query = async (text) => {
        await run("setQuery(" + JSON.stringify(text) + ")");
        await pause();
      };
      await pause();
      await pause();
      await run("commandsButton().focus()");
      await open();
      await check(
        "Ctrl+K focuses the search field",
        'document.activeElement?.getAttribute("role")==="combobox"',
      );
      const initialOption = await run(
        'document.activeElement.getAttribute("aria-activedescendant")',
      );
      key("Down");
      await pause();
      assert.notEqual(
        await run(
          'document.activeElement.getAttribute("aria-activedescendant")',
        ),
        initialOption,
      );
      key("Up");
      await pause();
      assert.equal(
        await run(
          'document.activeElement.getAttribute("aria-activedescendant")',
        ),
        initialOption,
      );
      console.log("PASS Arrow keys select results without leaving the input");
      key("Escape");
      await pause();
      await check(
        "Escape restores the invoking control",
        "document.activeElement===commandsButton()",
      );
      await open();
      await query("Автозапуск");
      key("Enter");
      await pause();
      await pause();
      await check(
        "Exact setting receives focus after the palette closes",
        'document.activeElement?.dataset.settingLabel===t("settings.autoLaunch")&&!document.querySelector(".command-palette")',
      );
      await run('document.querySelector("[data-setting-label]").focus()');
      await open();
      key("Tab");
      await pause();
      key("Tab");
      await pause();
      await check(
        "Tab remains inside the dialog",
        '!!document.activeElement.closest(".command-palette")',
      );
      await query("ПРИЕМ");
      await check(
        "Russian normalization and download identity",
        '[...document.querySelectorAll("[data-command-id]")].some(el=>el.dataset.commandId==="download:fixture-79")',
      );
      key("Enter");
      await pause();
      await pause();
      await pause();
      await check(
        "Offscreen virtual download is selected and focused",
        'document.activeElement?.dataset.downloadId==="fixture-79"',
      );
      await run(
        'document.querySelector(".search-input-wrapper input, .downloads-search input, input[type=search]")?.focus()',
      );
      await open();
      await query("Nothing-matches-918827");
      await check(
        "Empty results are accessible",
        '!!document.querySelector(".command-palette-empty")&&!document.querySelector("[role=option]")',
      );
      await query("Кинозал");
      await run("roomsLive=[]");
      await run(
        "var oldRoomList=window.api.rooms.list,resolveRoomList;window.api.rooms.list=()=>new Promise(resolve=>resolveRoomList=resolve);void 0",
      );
      key("Enter");
      await pause();
      key("Enter");
      key("Escape");
      await pause();
      await check(
        "Running command keeps one modal active",
        '!!document.querySelector(".command-palette [aria-busy=true]")',
      );
      await run("window.api.rooms.list=oldRoomList;resolveRoomList([])");
      await pause();
      await check(
        "Removed room reports an error without closing",
        '!!document.querySelector(".command-palette [role=alert]")',
      );
      await run('roomsLive=[{roomId:"r1",name:"Кинозал"}]');
      key("Enter");
      await pause();
      await pause();
      await check(
        "Room membership is checked and the requested room opens",
        'document.querySelector("#test-room")?.textContent==="r1"',
      );
      await open();
      await query("звонку");
      await run('setQuery(t("hotkeys.voiceMute"))');
      await pause();
      await check(
        "Unavailable actions explain why",
        'document.querySelector("[data-command-id=voice-mute]")?.getAttribute("aria-disabled")==="true"',
      );
      key("Escape");
      await pause();
      await run(
        'dict=JSON.parse(fs.readFileSync(path.join(fixtureRoot,"renderer/i18n/en.json"),"utf8"));document.documentElement.lang="en";fixtureSetLanguage("en");commandsButton().click()',
      );
      await pause();
      await query("upload speed");
      await check(
        "English settings are localized",
        'document.querySelector("[role=option]")?.textContent.includes("Upload")',
      );
      await capture("english.png");
      key("Escape");
      await pause();
      await run(
        'var child=window.open("about:blank","havvn-test-commands");child.document.write("<button id=origin>Origin</button>");var stopChild=load(path.join(fixtureRoot,"renderer/commands/windows.ts")).registerCommandWindow(child);child.document.querySelector("button").focus();child.dispatchEvent(new child.KeyboardEvent("keydown",{code:"KeyK",ctrlKey:true,bubbles:true}))',
      );
      await pause();
      await pause();
      await check(
        "Detached window owns the palette and focus",
        'child.document.activeElement?.getAttribute("role")==="combobox"&&!document.querySelector(".command-palette")',
      );
      await run(
        'child.dispatchEvent(new child.KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
      );
      await pause();
      await check(
        "Detached Escape restores focus in that window",
        'child.document.activeElement?.id==="origin"',
      );
      await run(
        'child.dispatchEvent(new child.KeyboardEvent("keydown",{code:"KeyK",ctrlKey:true,bubbles:true}))',
      );
      await pause();
      await run("child.close();stopChild()");
      await pause();
      await check(
        "Closing a detached window dismisses its palette",
        '!document.querySelector(".command-palette")',
      );
      await run("commandsButton().click()");
      await pause();
      await query("download");
      win.setSize(520, 700);
      await pause();
      await check(
        "520px dialog fits the viewport",
        'document.querySelector(".command-palette").getBoundingClientRect().right<=innerWidth&&document.querySelector(".command-palette").getBoundingClientRect().left>=0',
      );
      await capture("narrow.png");
      await check(
        "Typing never calls content providers",
        "calls.every(call=>!/^search|provider/i.test(call[0]))",
      );
      key("Escape");
      await pause();
      await run(
        'var hotkeyModule=load(path.join(fixtureRoot,"renderer/utils/hotkeys.ts"));hotkeyModule.saveHotkeys(hotkeyModule.rebindHotkey(hotkeyModule.loadHotkeys(),"open-command-palette",["Ctrl","KeyJ"]));commandsButton().focus()',
      );
      await open();
      await check(
        "Previous shortcut stops opening the palette",
        '!document.querySelector(".command-palette")',
      );
      key("j", ["control"]);
      await pause();
      await check(
        "Edited shortcut applies without restart",
        '!!document.querySelector(".command-palette")',
      );
      key("Escape");
      await pause();
      key("o", ["control"]);
      await pause();
      await pause();
      await check(
        "Add torrent shortcut opens the actual file picker",
        'calls.some(call=>call[0]==="selectTorrentFiles")',
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
