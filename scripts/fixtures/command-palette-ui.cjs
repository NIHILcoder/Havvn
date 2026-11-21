/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- Injected renderer fixture: its CommonJS loader and globals belong to the acceptance harness. */
// UI seams are limited to unrelated pages, services and providers.
var fs = require("node:fs"),
  path = require("node:path");
var packageRequire = require("node:module").createRequire(
  path.join(fixtureRoot, "package.json"),
);
var ts = packageRequire("typescript"),
  React = packageRequire("react"),
  dom = packageRequire("react-dom");
var createRoot = packageRequire("react-dom/client").createRoot;
var fixtureTranslationContext = React.createContext(null),
  fixtureSetLanguage;
function FixtureI18nProvider({ children }) {
  const [language, setLanguage] = React.useState("ru");
  fixtureSetLanguage = (next) => {
    localStorage.setItem('language', next); document.documentElement.lang = next;
    setLanguage(next); window.dispatchEvent(new Event('havvn:device-local'));
  };
  return React.createElement(
    fixtureTranslationContext.Provider,
    { value: { t: (key) => dict[key] || key, language, setLanguage: fixtureSetLanguage } },
    children,
  );
}
var dict = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "renderer/i18n/ru.json"), "utf8"),
);
var t = (key) => dict[key] || key,
  cache = {},
  components;
var calls = [],
  statsSubscriptions = 0,
  statsReceiver,
  roomListener,
  roomsLive = [
    {
      roomId: "r1",
      name: "Кинозал",
      onlineCount: 1,
      memberCount: 1,
      fileCount: 0,
    },
  ];
var fixtureRows = Array.from({ length: 80 }, (_, index) => ({
  id: "fixture-" + index,
  name: index === 79 ? "Приём материалов" : "Archive " + index,
  savePath: "D:/Downloads",
  sourceType: "magnet",
  sourceUri: "magnet:test",
  torrentFilePath: null,
  status: "paused",
  progress: 0.4,
  totalSize: 1024,
  downloadedBytes: 400,
  uploadedBytes: 0,
  downSpeedBps: 0,
  upSpeedBps: 0,
  etaSeconds: null,
  peers: 0,
  seeds: 0,
  priority: 1,
  category: null,
  lastError: null,
  createdAt: new Date(1735689600000 - index * 1000),
  updatedAt: new Date(1735689600000),
}));
window.api = new Proxy(
  {
    devices: { state: async () => null, changed: () => () => {}, localChanged: () => {}, activeMedia: () => {}, start: async () => null },
    getDownloads: async () => fixtureRows,
    onDownloadStats: (callback) => {
      statsSubscriptions++;
      statsReceiver = callback;
      return () => {
        statsSubscriptions--;
        statsReceiver = undefined;
      };
    },
    getSettings: async () => structuredClone(settingsFixture.settings),
    getPrivacyConfig: async () => settingsFixture.privacyConfig,
    getScheduler: async () => settingsFixture.scheduler,
    getCompletionAction: async () => ({
      action: "none",
      pending: null,
      available: ["none"],
    }),
    getAltSpeed: async () => ({ altSpeedEnabled: false }),
    selectTorrentFiles: async () => { calls.push(["selectTorrentFiles"]); return []; },
    getSettingsTransferStatus: async () => ({
      backupAt: null,
      recoveryNeeded: false,
    }),
    getDohTemplates: async () => [],
    getNetworkProfiles: async () => ({
      profiles: [],
      activeId: null,
      current: null,
    }),
    getAppStats: async () => ({
      totalDownloads: 80,
      totalUploaded: "0",
      totalDownloaded: "0",
      diskUsage: "0",
      activeDownloads: 0,
      completedDownloads: 0,
    }),
    webRemote: { getInfo: async () => ({ enabled: false }) },
    getAutoLaunch: async () => false,
    isDefaultClient: async () => false,
    getAppVersion: async () => "3.2.0",
    getRunningEngine: async () => "native",
    getEngineCapabilities: async () => require(path.join(fixtureRoot, "dist/electron/shared/engine-capabilities.js")).engineCapabilities("native"),
    getRunningTransport: async () => null,
    win: {
      isMaximized: async () => false,
      onMaximizeChange: () => () => {},
      toggleMaximize: () => {},
      minimize: () => {},
      close: () => {},
    },
    rooms: {
      list: async () => {
        calls.push(["rooms.list"]);
        return roomsLive;
      },
      setActiveRoom: async () => {},
      voice: { mute: async () => {}, deafen: async () => {} },
    },
  },
  {
    get: (target, key) =>
      key in target
        ? target[key]
        : String(key).startsWith("on")
          ? () => () => {}
          : async (...args) => {
              calls.push([key, ...args]);
            },
  },
);
if (typeof fixtureApiOverrides !== 'undefined') Object.assign(window.api, fixtureApiOverrides);
function load(file) {
  if (cache[file]) return cache[file].exports;
  var mod = { exports: {} };
  cache[file] = mod;
  var js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  if (typeof testResourceMode !== 'undefined' && testResourceMode && file.endsWith('RoomsPage.tsx')) js += '\nmodule.exports.ResourceRoomFileRow = RoomFileRow;';
  // First-steps smoke keeps the actual RoomsPage dialogs, requests and file
  // handlers. The unrelated room workspace/dock is outside this fixture.
  if (typeof testFirstSteps !== 'undefined' && testFirstSteps && file.endsWith('RoomsPage.tsx')) {
    js = js.replace('const RoomDetail =', 'let RoomDetail =') + '\nRoomDetail = props => React.createElement("div", {"data-fixture-room": props.room.roomId});';
  }
  new Function("require", "module", "exports", js)(
    (name) => {
      if (name.endsWith(".css")) return {};
      if (typeof testFirstSteps !== 'undefined' && testFirstSteps && file.endsWith('RoomsPage.tsx') && name.startsWith('./rooms/')) return {};
      if (name.includes("i18nContext"))
        return {
          useTranslation: () =>
            React.useContext(fixtureTranslationContext) ?? {
              t,
              language: "ru",
            },
          I18nProvider: FixtureI18nProvider,
        };
      if (name.includes("useCategories") && !(typeof testCategoryDefaults !== 'undefined' && testCategoryDefaults))
        return {
          useCategories: () =>
            typeof fixtureCategories === "undefined" ? [] : fixtureCategories,
          categoryLabel: (categories, id) =>
            categories.find((category) => category.id === id)?.name ?? id,
        };
      if (
        name.includes("ConfirmDialog") &&
        !(typeof testSavedViews !== "undefined" && testSavedViews)
      )
        return {
          ConfirmProvider: ({ children }) => children,
          useConfirm: () => ({ confirm: async () => false }),
        };
      if (name.includes("hostToast"))
        return {
          HostToaster: () => null,
          ToastRealmProvider: ({ children }) => children,
          useHostToast: () => ({
            error: (message) => calls.push(["toast", message]),
          }),
        };
      if (name === "./utils/appearance") return { bootAppearance: () => {} };
      if (name === "./utils/splash")
        return { dismissSplash: () => {}, setSplashStage: () => {} };
      if (name === "./utils/theme-library")
        return { bootApplyActiveTheme: () => {} };
      if (name === "./utils/theme-prefs")
        return { restoreThemePrefs: () => {} };
      if (name === "./utils/externalWatch")
        return { receiveExternalWatch: () => {} };
      if (name.endsWith("/components")) return components;
      if (name === "./layout")
        return {
          TitleBar: load(path.join(fixtureRoot, "renderer/layout/TitleBar.tsx"))
            .TitleBar,
        };
      if (
        name.includes("DownloadIndicators") &&
        !(typeof testSavedViews !== "undefined" && testSavedViews)
      )
        return { DownloadSidebar: () => null, DownloadStatusBar: () => null };
      if (name === "./pages/RoomsPage" && !(typeof testFirstSteps !== 'undefined' && testFirstSteps))
        return {
          __esModule: true,
          default: ({ focusRoomId, onFocusHandled }) => {
            var [id, setId] = React.useState("");
            React.useEffect(() => {
              if (focusRoomId) {
                setId(focusRoomId);
                onFocusHandled?.();
              }
            }, [focusRoomId]);
            return React.createElement("div", { id: "test-room" }, id);
          },
        };
      if (
        /\.\/pages\/(SearchPage|RSSPage|SwarmPage|WatchHistoryPage|CreateTorrentPage)/.test(
          name,
        )
      )
        return {
          __esModule: true,
          default: () => React.createElement("div", null, name),
        };
      if (name === "./components/Onboarding" && !(typeof testFirstSteps !== 'undefined' && testFirstSteps)) return { Onboarding: () => null };
      if (name.includes("/ExternalPlayerSessions"))
        return { ExternalPlayerSessions: () => null };
      if (name.includes("/ExternalPlayerPreferences"))
        return { ExternalPlayerPreferences: () => null };
      if (name === "./components/CompletionCountdown")
        return { CompletionCountdown: () => null };
      if (name.startsWith(".")) {
        var target = path.resolve(path.dirname(file), name);
        if (target.endsWith(".json"))
          return JSON.parse(fs.readFileSync(target, "utf8"));
        for (var ext of [".tsx", ".ts", "/index.ts"])
          if (fs.existsSync(target + ext)) return load(target + ext);
        throw Error("Missing fixture import: " + target);
      }
      return packageRequire(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}
var errorTranslations = load(path.join(fixtureRoot, 'renderer/utils/error-messages.ts'));
for (var errorLanguage of ['ru', 'en']) errorTranslations.registerErrorTranslations(errorLanguage,
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'renderer/i18n/' + errorLanguage + '.json'), 'utf8')));
components = Object.assign(
  {
    ToastContainer: () => null,

    useConfirm: () => ({ confirm: async () => false }),
  },
  ...[
    "Button",
    "Icon",
    "Select",
    "Alert",
    "Input",
    "Toggle",
    "ProgressBar",
    "Badge",
    "HealthBadge",
    "DropdownMenu",
    "ContextMenu",
    "EmptyState",
  ].map((name) =>
    load(path.join(fixtureRoot, "renderer/components/" + name + ".tsx")),
  ),
);
Object.assign(
  components,
  load(path.join(fixtureRoot, "renderer/components/Logo.tsx")),
);
if (typeof testDownloadUndo !== 'undefined' && testDownloadUndo || typeof testAccessibility !== 'undefined' && testAccessibility) {
  Object.assign(components, load(path.join(fixtureRoot, 'renderer/components/Toast.tsx')));
  components.useConfirm = load(path.join(fixtureRoot, 'renderer/components/ConfirmDialog.tsx')).useConfirm;
}
if (!(typeof testFirstSteps !== 'undefined' && testFirstSteps)) localStorage.setItem("onboarded", "1");
if (typeof testEventCenter !== "undefined" && testEventCenter) {
  var persistedEvents = null,
    eventNow = Date.now(),
    eventListeners = new Set(),
    retryCalls = 0,
    finishRetry;
  var EventStore = load(
    path.join(fixtureRoot, "electron/services/app-event-store.ts"),
  ).AppEventStore;
  var EventActions = load(
    path.join(fixtureRoot, "electron/services/app-event-actions.ts"),
  ).AppEventActions;
  var eventStore = new EventStore(
    {
      read: () => persistedEvents,
      write: (value) => {
        persistedEvents = structuredClone(value);
      },
    },
    () => eventNow,
  );
  for (var index = 0; index < 55; index++) {
    eventNow++;
    eventStore.record("download-complete", {
      kind: "download",
      id: "history-" + index,
    });
  }
  eventNow++;
  eventStore.record(
    "download-error",
    { kind: "download", id: "fixture-79" },
    { reason: "permission" },
  );
  eventNow++;
  eventStore.record("room-disconnected", { kind: "room", id: "r1" });
  eventNow++;
  eventStore.record("disk-low", { kind: "system" });
  var eventActions = new EventActions(eventStore, {
    getDownload: async (id) => fixtureRows.find((row) => row.id === id) || null,
    getRoomIds: async () => roomsLive.map((room) => room.roomId),
    retry: () => {
      retryCalls++;
      return new Promise((resolve) => (finishRetry = resolve));
    },
  });
  window.api.events = {
    list: async (query) => eventStore.list(query),
    summary: async () => eventStore.summary(),
    read: async (id) => eventStore.read(id),
    run: (id, action) => eventActions.run(id, action),
    onChanged: (callback) => {
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },
  };
  eventStore.subscribe(() => eventListeners.forEach((callback) => callback()));
  function eventRow(code) {
    var item = eventStore.list().items.find((event) => event.code === code);
    return [...document.querySelectorAll("[data-event-id]")].find(
      (row) => row.dataset.eventId === item?.id,
    );
  }
  function eventButton(row, key) {
    return [...row.querySelectorAll("button")].find(
      (button) => button.textContent === t(key),
    );
  }
}
var App = load(path.join(fixtureRoot, "renderer/App.tsx")).default;
var tree = createRoot(document.querySelector("#root"));
dom.flushSync(() => tree.render(React.createElement(App)));
function setQuery(value, doc = document) {
  var input = doc.querySelector(".command-palette-input");
  if (!input) throw Error("Missing palette input");
  Object.getOwnPropertyDescriptor(
    input.ownerDocument.defaultView.HTMLInputElement.prototype,
    "value",
  ).set.call(input, value);
  input.dispatchEvent(
    new input.ownerDocument.defaultView.Event("input", { bubbles: true }),
  );
}
function commandsButton() {
  return document.querySelector(".titlebar-commands[title]");
}
void 0;
