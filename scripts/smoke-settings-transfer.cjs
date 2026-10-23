/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Node/Electron acceptance fixture. */
// Usage: npm run build:electron && node scripts/smoke-settings-transfer.cjs
// Two isolated profiles, production preload and IPC, real electron-store. No app services/network.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "havvn-settings-acceptance-"),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const mode of [
      "export",
      "import",
      "restart",
      "restore",
      "restored-restart",
      "crash",
      "recover",
      "recovered-restart",
    ]) {
      const result = spawnSync(
        require("electron"),
        [__filename, mode, directory],
        {
          env,
          windowsHide: true,
          encoding: "utf8",
          timeout: 45000,
        },
      );
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.status !== 0 || result.error)
        throw new Error(
          result.error?.message || result.stderr || `Fixture ${mode} failed`,
        );
    }
    console.log(
      "Settings transfer: export, merge, preview/cancel, stale preview, failure, preload invalidation and restart passed.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("havvn-settings-acceptance-")
    )
      throw new Error("Unexpected acceptance directory");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, dialog, ipcMain } = require("electron");
  const mode = process.argv[2],
    directory = path.resolve(process.argv[3]);
  assert(
    [
      "export",
      "import",
      "restart",
      "restore",
      "restored-restart",
      "crash",
      "recover",
      "recovered-restart",
    ].includes(mode),
  );
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert(path.basename(directory).startsWith("havvn-settings-acceptance-"));
  const profile = path.join(
    directory,
    mode === "export" ? "source-profile" : "target-profile",
  );
  app.setPath("userData", profile);
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 35000);
  app
    .whenReady()
    .then(async () => {
      const root = path.resolve(__dirname, ".."),
        compiled = path.join(root, "dist", "electron");
      const db = require(path.join(compiled, "electron", "db", "store.js"));
      const transfer = require(
        path.join(compiled, "electron", "ipc", "settings-transfer.js"),
      );
      const file = path.join(directory, "settings.json");
      const sourceMovie = {
        id: "movies",
        name: "Фильмы из источника",
        icon: "film",
        color: "#654321",
      };
      const sourceCustom = {
        id: "source-custom",
        name: "Общая категория",
        icon: "folder",
        color: "#123456",
      };
      const local = {
        id: "local-only",
        name: "Общая категория",
        icon: "folder",
        color: "#abcdef",
      };
      const configPath = path.join(profile, "config.json");
      const rawConfig = () => fs.readFileSync(configPath, "utf8");
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          additionalArguments: ["--havvn-settings-recovery"],
          preload: path.join(compiled, "electron", "preload.js"),
        },
      });
      transfer.registerSettingsTransferIpc(() => win);
      const html = path.join(directory, "fixture.html");
      fs.writeFileSync(
        html,
        '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'"></head><body>Settings acceptance</body></html>',
      );
      await win.loadFile(html);
      const run = (code) => win.webContents.executeJavaScript(code);
      await run(
        "window.categoryChanges=0; window.api.onCategoriesChanged(()=>window.categoryChanges++); true;",
      );
      ipcMain.handle("categories:get", () => db.getCategories());
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
      let response = 1,
        preview = "";
      dialog.showMessageBox = async (_window, options) => {
        preview = options.detail;
        return { response };
      };
      const { INTERFACE_KEYS } = require(
        path.join(compiled, "shared/interface-preferences.js"),
      );
      const ui = () =>
        run(
          `Object.fromEntries(${JSON.stringify(INTERFACE_KEYS)}.map(key=>[key,localStorage.getItem(key)]))`,
        );
      const setUi = (values) =>
        run(
          `for(const [key,value] of Object.entries(${JSON.stringify(values)})){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);} true;`,
        );
      const originalUiFile = path.join(directory, "original-ui.json");
      const sourceUiFile = path.join(directory, "source-ui.json");

      if (mode === "export") {
        const { DEFAULT_APPEARANCE } = require(
          path.join(compiled, "shared/appearance.js"),
        );
        const font = fs
          .readFileSync(
            path.join(
              root,
              "node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2",
            ),
          )
          .toString("base64");
        const theme = {
          id: "portable-theme",
          name: "Переносимая тема",
          dark: {},
          light: {},
          font: '"Portable Inter", sans-serif',
          fontData: `data:font/woff2;base64,${font}`,
        };
        const appearance = {
          ...DEFAULT_APPEARANCE,
          acrylic: true,
          nativeMaterial: "mica",
          background: "image",
          wallpaper: "",
        };
        const image =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
        await setUi({
          theme: "light",
          accentColor: "#123456",
          fontChoice: "inter",
          "havvn.theme.library": JSON.stringify([theme]),
          "havvn.theme.active": theme.id,
          "havvn.appearance.v1": JSON.stringify(appearance),
          "havvn.appearance.wallpaper.v1": image,
          "havvn.appearance.profiles.v1": JSON.stringify([
            {
              version: 1,
              name: "Профиль",
              appearance: { ...appearance, wallpaper: image },
              theme,
              mode: "light",
              accent: "#123456",
              font: "inter",
              density: "compact",
              reduceMotion: true,
            },
          ]),
          hotkeys: JSON.stringify([
            { id: "open-settings", keys: ["Alt", "KeyK"] },
          ]),
          roomLayout: JSON.stringify({ railW: 300, chatW: 410 }),
          'havvn.panels.v1': JSON.stringify({ sidebar: false, statusBar: true }),
          'havvn.working-profiles.v1': JSON.stringify({ version: 1, activeId: 'source-profile', previous: null, profiles: [{
            id: 'source-profile', name: 'Source working set', values: { startPage: 'rooms', viewId: 'source-view',
              panels: { sidebar: false, statusBar: true }, appearanceName: 'Профиль',
              notifications: require(path.join(compiled, 'shared/working-profile-schema.js')).readProfileNotifications(await db.getSettings()) },
          }] }),
          "havvn.navigation.v1": JSON.stringify({
            version: 1,
            utilities: [{ id: 'rss', visible: true }, { id: 'search', visible: false }],
            showHistory: false,
            favorites: [{ kind: 'view', id: 'source-view' }, { kind: 'room', id: 'unavailable-room' }, { kind: 'command', id: 'open-search' }],
          }),
          "havvn.download-views.v1": JSON.stringify({
            version: 1,
            activeId: "source-view",
            views: [
              {
                id: "source-view",
                name: "Фильмы",
                pinned: true,
                conditions: {
                  status: "completed",
                  category: "source-custom",
                  name: "film",
                  path: "D:/source",
                  minBytes: 1048576,
                },
                sort: { by: "speed", direction: "desc" },
                mode: "detailed",
              },
            ],
          }),
          uiScale: "125",
          density: "compact",
          reduceMotion: "1",
          startPage: "rooms",
          speedUnits: "si",
          language: "ru",
          privateSearchToken: "synthetic-private-ui-token",
        });
        fs.writeFileSync(sourceUiFile, JSON.stringify(await ui()));
        const state = db.readSettingsImportState();
        db.store.set("categories", [
          ...state.categories.filter((category) => category.id !== "movies"),
          sourceMovie,
          sourceCustom,
        ]);
        await db.updateSettings({
          maxDownKbps: 777,
          proxyPassword: "synthetic-source-proxy",
          customTurnCredential: "synthetic-source-turn",
          webRemoteToken: "synthetic-source-token",
        });
        await db.updateScheduler({
          enabled: true,
          schedules: [
            {
              id: "night",
              days: [0, 1],
              startTime: "23:00",
              endTime: "02:00",
              speedLimit: 25,
            },
          ],
        });
        await db.updatePrivacyConfig({ vpnKillSwitch: true });
        assert.deepEqual(await run("window.api.exportSettings()"), {
          success: true,
          path: file,
        });
        assert.equal((await run('window.api.getSettingsExportOperation()')).status, 'succeeded');
        const text = fs.readFileSync(file, "utf8"),
          exported = JSON.parse(text);
        assert.equal(exported.version, 2);
        assert.deepEqual(exported.interfacePreferences.values, await ui());
        assert(
          exported.categories.some(
            (category) => category.id === sourceCustom.id,
          ),
        );
        for (const secret of [
          "proxyPassword",
          "customTurnCredential",
          "webRemoteToken",
          "synthetic-source",
          "synthetic-private-ui-token",
        ])
          assert(!text.includes(secret));
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: path.join(directory, "hotkeys.json"),
        });
        await run(`window.api.exportSettings({sections:['hotkeys']})`);
        let finishSave;
        dialog.showSaveDialog = () => new Promise(resolve => { finishSave = resolve; });
        await run(`window.operationChanges=0;window.offOperation=window.api.onSettingsExportOperation(()=>window.operationChanges++);
          window.pendingExport=window.api.exportSettings();true;`);
        for (let attempt = 0; attempt < 50 && !finishSave; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(typeof finishSave, 'function');
        const waiting = await run('window.api.getSettingsExportOperation()');
        assert.equal(waiting.stage, 'choose-file'); assert.equal(waiting.progress, null);
        assert.equal(await run(`window.api.exportSettings().then(()=>false,()=>true)`), true);
        finishSave({ canceled: true });
        assert.deepEqual(await run('window.pendingExport'), { success: false });
        assert.equal((await run('window.api.getSettingsExportOperation()')).status, 'cancelled');
        assert((await run('window.operationChanges')) >= 2);
        await run('window.offOperation();true;');
        const selective = JSON.parse(
          fs.readFileSync(path.join(directory, "hotkeys.json"), "utf8"),
        );
        assert.deepEqual(selective.sections, ["hotkeys"]);
        assert.equal(selective.interfacePreferences.values.theme, null);
        assert.equal(
          selective.interfacePreferences.values["havvn.theme.library"],
          null,
        );
        assert(!("categories" in selective));
        console.log(
          JSON.stringify({
            phase: mode,
            portableExport: true,
            categoryCount: exported.categories.length,
          }),
        );
      } else if (mode === "import") {
        await setUi({
          theme: "dark",
          accentColor: "#abcdef",
          hotkeys: JSON.stringify([
            { id: "open-settings", keys: ["Ctrl", "KeyO"] },
          ]),
          roomLayout: JSON.stringify({ railW: 240, chatW: 340 }),
          'havvn.panels.v1': JSON.stringify({ sidebar: true, statusBar: false }),
          'havvn.working-profiles.v1': JSON.stringify({ version: 1, activeId: null, previous: null, profiles: [{
            id: 'target-profile', name: 'Target working set', values: { startPage: 'downloads', viewId: 'target-view',
              panels: { sidebar: true, statusBar: false }, appearanceName: null,
              notifications: require(path.join(compiled, 'shared/working-profile-schema.js')).readProfileNotifications(await db.getSettings()) },
          }] }),
          "havvn.navigation.v1": JSON.stringify({
            version: 1, utilities: [], showHistory: true,
            favorites: [{ kind: 'view', id: 'target-view' }],
          }),
          "havvn.download-views.v1": JSON.stringify({
            version: 1,
            activeId: "target-view",
            views: [
              {
                id: "target-view",
                name: "Местный вид",
                pinned: false,
                conditions: { status: "all", name: "local", path: "" },
                sort: { by: "added", direction: "asc" },
                mode: "compact",
              },
            ],
          }),
          density: "normal",
          uiScale: "100",
          language: "en",
          privateSearchToken: "target-private-ui-token",
        });
        fs.writeFileSync(originalUiFile, JSON.stringify(await ui()));
        const state = db.readSettingsImportState();
        db.store.set("categories", [...state.categories, local]);
        db.store.set("windowBounds", { width: 1000, height: 700 });
        await db.updateSettings({
          proxyPassword: "synthetic-target-proxy",
          customTurnCredential: "synthetic-target-turn",
          webRemoteToken: "synthetic-target-token",
        });
        const originalSecrets = db.readSettingsImportState().settings;
        await db.createDownload({
          name: "Category reference",
          sourceType: "magnet",
          sourceUri: `magnet:?xt=urn:btih:${"1".repeat(40)}`,
          savePath: path.join(directory, "no-download-started"),
          status: "paused",
          category: "movies",
        });
        const downloadPath = path.join(profile, "downloads.json"),
          originalDownloads = fs.readFileSync(downloadPath, "utf8");

        response = 0;
        const beforeCancel = rawConfig();
        assert.deepEqual(await run("window.api.importSettings()"), {
          success: false,
        });
        assert.equal(rawConfig(), beforeCancel);
        assert(
          preview.includes("Movies") && preview.includes(sourceMovie.name),
        );

        dialog.showMessageBox = async () => {
          const current = db.readSettingsImportState();
          db.store.set("categories", [
            ...current.categories,
            {
              id: "during-preview",
              name: "Concurrent edit",
              icon: "folder",
              color: "#123456",
            },
          ]);
          return { response: 1 };
        };
        await assert.rejects(
          run("window.api.importSettings()"),
          /changed during/,
        );
        assert.equal(
          db.readSettingsImportState().settings.maxDownKbps,
          state.settings.maxDownKbps,
        );
        db.store.set("categories", [...state.categories, local]);
        dialog.showMessageBox = async (_window, options) => {
          preview = options.detail;
          return { response: 1 };
        };

        // Inject an actual filesystem refusal at electron-store's write boundary.
        const savedWrite = db.store._write;
        assert.equal(typeof savedWrite, "function");
        const blocker = path.join(directory, "not-a-directory");
        fs.writeFileSync(blocker, "blocker");
        dialog.showMessageBox = async () => {
          db.store._write = (value) =>
            fs.writeFileSync(
              path.join(blocker, "config.json"),
              JSON.stringify(value),
            );
          return { response: 1 };
        };
        await assert.rejects(run("window.api.importSettings()"));
        db.store._write = savedWrite;
        assert.equal(fs.readFileSync(downloadPath, "utf8"), originalDownloads);
        const failedState = db.readSettingsImportState();
        assert.equal(
          failedState.settings.maxDownKbps,
          state.settings.maxDownKbps,
        );
        assert(
          !failedState.categories.some(
            (category) => category.id === sourceCustom.id,
          ),
        );
        dialog.showMessageBox = async (_window, options) => {
          preview = options.detail;
          return { response: 1 };
        };

        await run(`window.api.importSettings({sections:['hotkeys']})`);
        assert.equal(
          db.readSettingsImportState().settings.maxDownKbps,
          state.settings.maxDownKbps,
        );
        const onlyHotkeys = await ui(),
          originalUi = JSON.parse(fs.readFileSync(originalUiFile, "utf8"));
        assert.equal(onlyHotkeys.theme, originalUi.theme);
        assert.equal(onlyHotkeys.roomLayout, originalUi.roomLayout);
        assert.equal(onlyHotkeys['havvn.navigation.v1'], originalUi['havvn.navigation.v1']);
        assert.equal(onlyHotkeys['havvn.working-profiles.v1'], originalUi['havvn.working-profiles.v1']);
        assert.equal(onlyHotkeys['havvn.panels.v1'], originalUi['havvn.panels.v1']);
        assert.equal(
          onlyHotkeys["havvn.download-views.v1"],
          originalUi["havvn.download-views.v1"],
        );
        assert.notEqual(onlyHotkeys.hotkeys, originalUi.hotkeys);
        await run(`window.api.restoreSettings({sections:['hotkeys']})`);
        assert.deepEqual(await ui(), originalUi);
        const invalidationsBefore = await run("window.categoryChanges");
        assert.deepEqual(await run("window.api.importSettings()"), {
          success: true,
        });
        const after = db.readSettingsImportState();
        assert(
          after.categories.some((category) => category.id === sourceCustom.id),
        );
        assert.deepEqual(
          after.categories.find((category) => category.id === "movies"),
          sourceMovie,
        );
        assert.deepEqual(
          after.categories.find((category) => category.id === local.id),
          local,
        );
        assert.equal(after.settings.maxDownKbps, 777);
        assert.equal(after.scheduler.enabled, true);
        assert.equal(after.privacyConfig.vpnKillSwitch, true);
        for (const key of [
          "proxyPassword",
          "customTurnCredential",
          "webRemoteToken",
        ])
          assert.equal(after.settings[key], originalSecrets[key]);
        assert.deepEqual(db.store.get("windowBounds"), {
          width: 1000,
          height: 700,
        });
        assert.equal(fs.readFileSync(downloadPath, "utf8"), originalDownloads);
        assert.equal(
          (await run("window.api.getCategories()")).find(
            (category) => category.id === "movies",
          ).name,
          sourceMovie.name,
        );
        assert.equal(
          await run("window.categoryChanges"),
          invalidationsBefore + 1,
        );
        assert.deepEqual(
          await ui(),
          JSON.parse(fs.readFileSync(sourceUiFile, "utf8")),
        );
        assert.equal(
          await run(`localStorage.getItem('privateSearchToken')`),
          "target-private-ui-token",
        );
        assert.deepEqual(after.nativeAppearance, {
          acrylic: true,
          material: "mica",
        });
        assert((await run("window.api.getSettingsTransferStatus()")).backupAt);
        console.log(
          JSON.stringify({
            phase: mode,
            mergedCategories: true,
            referencesKept: true,
            secretsKept: true,
            preloadInvalidation: true,
            failureKeptOriginal: true,
          }),
        );
      } else if (mode === "restart") {
        const after = db.readSettingsImportState();
        assert.equal(after.settings.maxDownKbps, 777);
        assert(
          after.categories.some((category) => category.id === sourceCustom.id),
        );
        assert(after.categories.some((category) => category.id === local.id));
        assert.equal(after.privacyConfig.vpnKillSwitch, true);
        assert.equal((await db.getAllDownloads())[0].category, "movies");
        assert.deepEqual(
          await ui(),
          JSON.parse(fs.readFileSync(sourceUiFile, "utf8")),
        );
        console.log(
          JSON.stringify({ phase: mode, persistedAcrossRestart: true }),
        );
      } else if (mode === "restore") {
        await db.createDownload({
          name: "New assignment after import",
          sourceType: "magnet",
          sourceUri: `magnet:?xt=urn:btih:${"2".repeat(40)}`,
          savePath: path.join(directory, "not-started"),
          status: "paused",
          category: sourceCustom.id,
        });
        assert.deepEqual(await run("window.api.restoreSettings()"), {
          success: true,
        });
        assert.equal(db.readSettingsImportState().settings.maxDownKbps, 0);
        assert(
          db
            .readSettingsImportState()
            .categories.some((category) => category.id === sourceCustom.id),
        );
        assert.deepEqual(
          await ui(),
          JSON.parse(fs.readFileSync(originalUiFile, "utf8")),
        );
        assert.equal(
          (await run("window.api.getSettingsTransferStatus()")).backupAt,
          null,
        );
        console.log(
          JSON.stringify({
            phase: mode,
            restoredBothStores: true,
            assignedCategoryKept: true,
          }),
        );
      } else if (mode === "crash") {
        ipcMain.removeHandler("settings:transfer:finish");
        ipcMain.handle("settings:transfer:finish", () => {
          win.webContents.session.flushStorageData();
          console.log(
            JSON.stringify({ phase: mode, stoppedBeforeConfirmation: true }),
          );
          clearTimeout(deadline);
          app.exit(0);
        });
        void run("window.api.importSettings()").catch(() => {});
        return;
      } else {
        assert.equal(db.readSettingsImportState().settings.maxDownKbps, 0);
        assert.deepEqual(
          await ui(),
          JSON.parse(fs.readFileSync(originalUiFile, "utf8")),
        );
        assert.equal(
          (await run("window.api.getSettingsTransferStatus()")).recoveryNeeded,
          false,
        );
        assert.deepEqual(db.readSettingsImportState().nativeAppearance, {
          acrylic: false,
          material: "acrylic",
        });
        console.log(
          JSON.stringify({ phase: mode, originalPreferencesRecovered: true }),
        );
      }
      win.destroy();
      clearTimeout(deadline);
      app.quit();
    })
    .catch((error) => {
      console.error(error);
      clearTimeout(deadline);
      app.exit(1);
    });
}
