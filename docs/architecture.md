# Архитектура Havvn

Havvn — десктопное Electron-приложение: приватный serverless P2P-хаб на базе BitTorrent-клиента. Облачного бэкенда, аккаунтов и центральных серверов нет. Вся логика, хранение и сеть живут на машине пользователя и напрямую между пирами.

Версия, от которой снята схема: **3.0.3**. Платформа поставки: Windows (NSIS / portable). macOS и Linux — в планах.

```mermaid
flowchart LR
  subgraph User["Пользователь"]
    UI["React UI<br/>7 страниц + dock комнат"]
  end

  subgraph App["Один процесс-оболочка Electron"]
    Main["Main process<br/>оркестрация, IPC, store"]
    Host["Utility process<br/>торрент-движок"]
    Hidden["Hidden BrowserWindows<br/>WebRTC: rooms / share / cast"]
    Helper["Elevated helper<br/>Wintun Virtual LAN"]
  end

  subgraph Peers["Внешний мир — только P2P / localhost"]
    BT["BitTorrent swarm"]
    RTC["WebRTC mesh комнат"]
    LAN["Локальная сеть:<br/>HLS, Chromecast, web-remote"]
    Track["Rendezvous-трекеры<br/>только рукопожатие"]
  end

  UI <-->|window.api / IPC| Main
  Main <-->|RPC parentPort| Host
  Main <-->|message-pass| Hidden
  Main -.->|UAC spawn, не на пути пакетов| Helper
  Host <--> BT
  Hidden <--> RTC
  Hidden <--> Helper
  Host --> LAN
  Hidden -.-> Track
```

---

## 1. Что это за система

| Свойство | Как устроено |
|----------|----------------|
| Тип продукта | Один desktop-app, не монорепо и не клиент-сервер |
| Источник истины | Main-процесс + локальные JSON (`electron-store`) |
| UI | React 18, клиентский «роутинг» через `currentPage` в `App.tsx` |
| Контракт UI ↔ ядро | Типизированный `IpcApi` (`shared/types.ts`) → `window.api` |
| Движок закачки | Transmission sidecar (по умолчанию) + WebTorrent fallback |
| Комнаты / шаринг / голос | WebTorrent + WebRTC в скрытых `BrowserWindow` |
| Идентичность | Локальная Ed25519-пара на установку, без аккаунтов |
| Сеть разработчика | Нулевая: никаких своих серверов, кроме опциональных публичных WebRTC-трекеров |

Три TypeScript-корня компилируются раздельно:

| Корень | Роль | Сборка |
|--------|------|--------|
| `electron/` | Main, сервисы, IPC, нативные sidecar | `tsc -p tsconfig.electron.json` → `dist/electron/` |
| `renderer/` | React UI | Webpack → `dist/renderer/` |
| `shared/` | Типы и чистая логика для обоих процессов | Компилируется с electron, type-check для renderer |

```
Havvn/
├── electron/          main, IPC, torrent, rooms, LAN, game servers
├── renderer/          React pages, layout, i18n
├── shared/            типы, state-machine, LAN/RSS/search parsers
├── docs/              дизайн-доки и этот файл
├── scripts/           fetch-wintun, fetch-transmission, релизы
├── themes/            пресеты .havvn-theme.json
├── vendor/            Transmission + Wintun (gitignore, качаются скриптами)
└── .github/workflows/ CI (Windows) + release по тегу v*
```

---

## 2. Слои приложения

```mermaid
flowchart TB
  subgraph R["renderer/ — презентация"]
    Pages["Pages: Downloads, Rooms, Search, RSS,<br/>Create Torrent, Swarm, Settings"]
    Layout["TitleBar · Sidebar · StatusBar"]
    Local["useState / useRef + редкий Zustand"]
  end

  subgraph B["Граница безопасности"]
    Preload["preload.ts<br/>contextBridge → window.api"]
  end

  subgraph M["electron/ — оркестрация и I/O"]
    IPC["ipc/handlers.ts — ~100+ каналов"]
    Mgrs["Managers: Torrent · Room · Share · LAN · Server"]
    Svcs["Services: RSS · Search · Blocklist · Scheduler"]
    DB["db/store.ts — единственный владелец JSON"]
  end

  subgraph S["shared/ — чистые функции"]
    Types["types.ts, gameserver-types, lan-types"]
    Pure["state-machine, rss-rules, lan-router,<br/>magnet, opml, theme, chat-format"]
  end

  Pages --> Layout
  Pages --> Local
  Pages --> Preload
  Preload --> IPC
  IPC --> Mgrs
  IPC --> Svcs
  Mgrs --> DB
  Svcs --> DB
  Mgrs --> Pure
  Svcs --> Pure
  Pages --> Types
```

Правило слоёв:

1. **`shared/`** — без Electron, без `fs`, без побочных эффектов. Юнит-тесты Vitest живут рядом (`.test.ts`).
2. **`electron/`** — процессы, диски, дочерние процессы, IPC. Бизнес-решения по возможности делегирует в `shared/`.
3. **`renderer/`** — ввод пользователя и подписки. Не ходит в сеть и не пишет store напрямую.

---

## 3. Модель процессов

Одно приложение — несколько процессов с жёстким разделением ответственности. Тяжёлая работа и WebRTC специально вынесены из main, чтобы UI не замерзал и нативный `wrtc` не падал под Electron.

```mermaid
flowchart TB
  subgraph ElectronApp["Havvn.exe"]
    direction TB

    subgraph MainP["Main process — electron/main.ts"]
      Tray["Tray + frameless window"]
      Handlers["IPC handlers"]
      Store[(electron-store JSON)]
      TM["TorrentManagerProxy"]
      RM["RoomManager"]
      SM["ShareManager"]
      LM["LanManager"]
      GS["ServerManager"]
      RSS["RSSService"]
      SCH["SchedulerEngine"]
    end

    subgraph RendererP["Renderer — видимое окно"]
      ReactUI["App.tsx + pages"]
    end

    subgraph UtilP["Utility process — torrent-host.ts"]
      Eng{"engine flag"}
      Native["NativeTorrentManager<br/>+ transmission-daemon"]
      WT["TorrentManager<br/>WebTorrent fallback"]
      Cast["CastServer / HLS / ffmpeg"]
    end

    subgraph HiddenP["Hidden BrowserWindows — Chromium WebRTC"]
      RE["room-engine.ts<br/>gossip, файлы, голос, LAN data-plane"]
      SS["share-seeder.ts<br/>instant share links"]
      RC["remote-cast-engine.ts<br/>WebRTC cast за NAT"]
    end

    subgraph ElevP["Elevated relaunch — --lan-helper"]
      HH["helper-main.ts<br/>Wintun ring ↔ named pipe"]
    end

    subgraph ChildP["Child processes"]
      MC["Minecraft JAR / JVM"]
    end
  end

  ReactUI <-->|contextBridge| Handlers
  Handlers --> Store
  Handlers --> TM
  Handlers --> RM
  Handlers --> SM
  Handlers --> GS
  TM <-->|parentPort RPC| UtilP
  Eng --> Native
  Eng --> WT
  RM <-->|ipc message-pass| RE
  SM <--> SS
  Handlers --> RC
  RM --> LM
  LM -.->|Start-Process -Verb RunAs| HH
  RE <-->|ACL named pipe, сырые кадры| HH
  GS --> MC
  Native --> Trans["transmission-daemon.exe"]
```

| Процесс | Файл входа | Зачем отдельный |
|---------|------------|-----------------|
| Main | `electron/main.ts` | Окна, tray, IPC, store, оркестрация. Не хеширует торренты и не держит WebRTC. |
| Renderer | `renderer/index.tsx` | UI. Изолирован: сеть и диск только через `window.api`. |
| Torrent host | `electron/torrent/host/torrent-host.ts` | Utility process: hashing, piece I/O, ffmpeg, stats 750 мс. |
| Room engine | `electron/sharing/room-engine.ts` | Hidden window: Chromium WebRTC (нативный `wrtc` падает в Electron). |
| Share seeder | `electron/sharing/share-seeder.ts` | Отдельное hidden window: шаринг в браузер друга. |
| Remote cast | `electron/sharing/remote-cast-engine.ts` | WebRTC-стрим за пределы LAN. |
| LAN helper | `electron/lan/helper-main.ts` | Админ-права только здесь. Тривиален: ring ↔ pipe, нуль протокольной логики. |
| Game server | spawn из `gameserver/` | JVM/JAR. Модуль игры **не** спавнит сам — только возвращает план. |

Особый режим запуска: `Havvn.exe --lan-helper` **не** поднимает окно, tray и торрент-движок. `app.whenReady` сразу вызывает `runLanHelper()`.

---

## 4. Последовательность старта

Окно поднимается **до** восстановления торрентов: верификация диска может идти десятки секунд, UI при этом уже интерактивен (API менеджера ждёт `initialize()`).

```mermaid
sequenceDiagram
  participant OS
  participant Main as Main process
  participant Win as Renderer window
  participant Host as torrent-host
  participant Side as transmission-daemon

  OS->>Main: Havvn.exe
  alt --lan-helper
    Main->>Main: runLanHelper() и выход из полного старта
  else обычный запуск
    Main->>Main: i18n, app menu, tray
    Main->>Main: initCompletionAction
    Main->>Win: createWindow + setupIpcHandlers
    Win->>Main: app:rendererReady
    Main-->>Win: отложенные magnet / havvn://join
    Main->>Host: utilityProcess.fork + init{env}
    Host->>Side: spawn sidecar (native engine)
    Host-->>Main: ready
    Main->>Main: seedDefaults, scheduler.start
    Main->>Main: VPN / disk / network-profile guards
    Main->>Main: UPnP, updater, web-remote, blocklist, RSS, watch-folder
    Main->>Main: startup VPN check + LAN orphan sweep
  end
```

Глубокие ссылки буферятся до `app:rendererReady`:

- `magnet:` и `.torrent` → `app:openTorrent` (диалог добавления, без тихого add).
- `havvn://join/<invite>` → `app:joinInvite` (Join-диалог **с подтверждением**, автоджойна нет).

---

## 5. IPC: как UI говорит с ядром

Единственный мост — `contextBridge` в `electron/preload.ts`. Renderer видит `window.api: IpcApi`. Обработчики — `electron/ipc/handlers.ts`.

```mermaid
sequenceDiagram
  participant Page as DownloadsPage
  participant API as window.api
  participant Pre as preload.ts
  participant H as handlers.ts
  participant P as TorrentManagerProxy
  participant Host as torrent-host
  participant Eng as Transmission / WebTorrent

  Page->>API: pauseDownload(id)
  API->>Pre: ipcRenderer.invoke('downloads:pause')
  Pre->>H: ipcMain.handle
  H->>P: pause(id)
  P->>Host: rpc{method:'pause', args}
  Host->>Eng: pause torrent
  Eng-->>Host: ok
  Host-->>P: rpc-res
  P-->>H: void
  H-->>Page: Promise resolved

  loop каждые 750 мс
    Host-->>P: event{stats}
    P-->>Page: webContents.send('downloads:stats')
    Page->>Page: setState
  end
```

Обратный поток (main → renderer) — push-каналы, не polling:

| Канал | Что несёт |
|-------|-----------|
| `downloads:stats` | Живые скорости/прогресс всех торрентов |
| `rooms:update` | Полный `RoomState` одной комнаты |
| `rooms:srvUpdate` / `srvAlert` / `srvConsoleLines` | Игровой сервер |
| `app:openTorrent` / `app:joinInvite` | OS file association / deep link |
| `vpn:dropped` / `vpn:bind` | Kill-switch и пропавший bind |
| `completion:pending` | Обратный отсчёт sleep/shutdown |

Состояние UI — в основном React `useState` в `App.tsx` и страницах. Zustand только у мастера создания торрента. `localStorage` — тема, стартовая страница, часть префов. **Источник истины всегда main + store.**

---

## 6. Карта фич и страниц

Роутера нет: `App.tsx` держит `currentPage: PageId`. Downloads грузится eagerly, остальные страницы — `React.lazy`.

```mermaid
flowchart LR
  subgraph Shell["Оболочка окна"]
    TB[TitleBar HUD]
    SB[Sidebar]
    ST[StatusBar: скорости, VPN, голос, presence]
  end

  subgraph Pages["Страницы"]
    D[downloads]
    R[rooms]
    SE[search]
    RS[rss]
    C[create-torrent]
    SW[swarm]
    SET[settings]
  end

  SB --> Pages
  Pages --> ST

  subgraph Dock["Rooms dock — вкладки"]
    Ppl[People]
    Vc[Voice]
    Stg[Stage / screen]
    Ch[Chat]
    Fl[Files]
    Ln[LAN]
    Srv[Server]
  end

  R --> Dock
  Dock -.->|tear-off| Pop["Pop-out BrowserWindow<br/>тот же React-realm"]
```

| Страница | Файл | Задача |
|----------|------|--------|
| Downloads | `renderer/pages/DownloadsPage.tsx` | Список закачек, add, плеер |
| Rooms | `renderer/pages/RoomsPage.tsx` | Дружеские рои: dock People/Voice/Stage/Chat/Files/LAN/Server |
| Search | `renderer/pages/SearchPage.tsx` | Поиск по пользовательским индексаторам |
| RSS | `renderer/pages/RSSPage.tsx` | Ленты, правила, OPML |
| Create torrent | `renderer/pages/CreateTorrentPage.tsx` | Мастер раздачи |
| Swarm | `renderer/pages/SwarmPage.tsx` | Карта пиров (d3-geo) |
| Settings | `renderer/pages/SettingsPage.tsx` | 12 секций |

Секции Settings: `general`, `downloads`, `connection`, `privacy`, `sharing`, `seeding`, `scheduler`, `interface`, `hotkeys`, `notifications`, `system`, `about`.

Группы навигации: **core / privacy / seeding / appearance / system**.

---

## 7. Домен закачек (BitTorrent)

### 7.1 Два движка за одним швом

UI и IPC **не знают**, какой движок работает. Main видит `TorrentManagerProxy`; host лениво `require()`-ит native или webtorrent по флагу настроек.

```mermaid
flowchart TB
  UI["Renderer / IPC"] --> Proxy["TorrentManagerProxy<br/>electron/torrent/host/manager-proxy.ts"]
  Proxy -->|"parentPort: init / rpc / db-res"| Host["torrent-host.ts"]
  Host -->|"db{fn,args} — store только в main"| Proxy
  Host --> Flag{"settings.engine"}
  Flag -->|native, default| NTM["NativeTorrentManager"]
  Flag -->|webtorrent| WTM["TorrentManager — legacy"]
  NTM -->|JSON-RPC localhost| TD["transmission-daemon.exe<br/>vendor/transmission"]
  WTM --> WTLib["webtorrent npm"]
  Host --> Cast["CastServer + ffmpeg-static"]
```

Контракт шва: `docs/native-host-contract.md`. Host шлёт `stats` каждые **750 мс**; прогресс батчем пишется в `downloads.json` каждые **5 с**.

Зачем WebTorrent остаётся: комнаты, instant share и remote-cast идут по WebRTC. Transmission качает файлы; WebRTC-фичи крутятся в hidden windows.

### 7.2 Машина состояний загрузки

Определена в `shared/state-machine.ts`. Нелегальный переход бросает `InvalidStateTransitionError`.

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> downloading: слот свободен
  queued --> paused
  downloading --> paused: pause
  paused --> downloading: resume есть торрент
  paused --> queued: resume нет торрента
  downloading --> seeding: готово
  downloading --> completed: без сидирования
  seeding --> paused
  seeding --> completed: stop
  paused --> completed: был seeding
  completed --> seeding: re-seed
  completed --> queued: recheck
  queued --> error
  downloading --> error
  paused --> error
  seeding --> error
  error --> queued: retry
  error --> downloading
  queued --> removed
  downloading --> removed
  paused --> removed
  seeding --> removed
  completed --> removed
  error --> removed
  removed --> [*]
```

Любое состояние кроме `removed` может уйти в `error`. Любое — в `removed` (терминал).

### 7.3 Потоки вокруг закачки

```mermaid
flowchart LR
  subgraph In["Как торрент попадает в клиент"]
    File[".torrent / drag-drop"]
    Mag["magnet:"]
    URL["URL .torrent"]
    Search["Search → add"]
    Feed["RSS rule match"]
    Watch["Watch folder"]
    Clip["Clipboard watcher"]
    OS["OS association"]
  end

  In --> Add["downloads:add"]
  Add --> Host
  Host --> Disk["savePath / категории"]

  subgraph Out["Что можно сделать с файлом"]
    Play["Встроенный плеер + субтитры"]
    HLS["LAN HLS + QR"]
    TV["Chromecast"]
    Remote["WebRTC remote cast"]
    Share["Instant share link"]
    Room["Share into room"]
  end

  Disk --> Out
```

Cast/HLS живёт в torrent-host (рядом с кусками и ffmpeg). Chromecast — discovery в LAN. Web-remote — отдельный token-gated HTTP на пользовательском порту (по умолчанию 8788, выключен).

---

## 8. Комнаты (friend swarms)

Комната — приглашение-only mesh: файлы, чат, голос, скрин, виртуальный LAN, выделенный игровой сервер. Нет своего сигналинг-сервера: рукопожатие через публичные (или свои) WebRTC-трекеры; полезная нагрузка по data-каналам.

`RoomManager` в main — прокси + персист. Живая логика — в hidden `room-engine.ts`.

```mermaid
flowchart TB
  UI["RoomsPage + dock"] -->|rooms:* IPC| RM["RoomManager main"]
  RM --> StoreR[("rooms.json<br/>чат E2E at rest")]
  RM -->|room-cmd / room-res| Eng["room-engine hidden window"]

  Eng --> Gossip["Gossip: roster, files,<br/>chat, ownership, kick/rekey"]
  Eng --> WT["WebTorrent file sync"]
  Eng --> Voice["room-voice.ts mesh"]
  Eng --> Screen["screen share + AEC"]
  Eng --> LANDP["room-lan.ts data-plane"]

  Gossip <-->|WebRTC data channels| Peers["Другие участники"]
  Voice <--> Peers
  WT <--> Peers
  LANDP <--> Peers

  Trackers["Rendezvous trackers<br/>только SDP/handshake"] -.-> Gossip
  TURN["Опциональный TURN"] -.-> Voice
```

### 8.1 Идентичность и крипто

Аккаунтов нет. Безопасность — криптография установки и членства:

| Механизм | Назначение |
|----------|------------|
| Ed25519 на установку | Подпись чата, конфига, ownership chain |
| Invite-код | Выводит ключи комнаты; `codeIsE2E` отличает E2E-инвайт |
| AES-256-GCM | E2E содержимого и чата at rest |
| TOFU pubkeys | Привязка memberId → ключ при первом контакте |
| Owner-signed e2eCfg | Раздача content-key членам |
| transferChain | Подписанная цепочка смены владельца |
| Kick → rekey | Ротация topic/ключей, чтобы выгнанный не читал дальше |

Секреты (приватный ключ) — `electron/db/secrets.ts` через OS DPAPI / Keychain, не в открытом JSON.

### 8.2 Живое состояние, которое видит UI

Main кэширует последний `RoomState` и пушит `rooms:update`. В агрегат входят члены, файлы/папки, трансферы, голос, LAN, sync, unread.

Персист (`rooms.json`): комнаты, профиль, манифесты файлов, tombstones/revives (чтобы удаление пережило рестарт и gossip), last-read, LAN prefs.

---

## 9. Голос и экран

Голос — serverless mesh в том же room-engine, **не** тот же набор `RTCPeerConnection`, что LAN (разные каналы и другая авторизация).

```mermaid
flowchart LR
  Mic["Микрофон"] --> RN["RNNoise WASM AudioWorklet"]
  RN --> Mix["Voice mix + PTT gate"]
  Mix --> Mesh["WebRTC MediaPeer mesh"]
  Screen["Screen + system audio"] --> AEC["Echo cancellation worklet"]
  AEC --> Mesh
  OSK["uiohook-napi global PTT"] --> MainPTT["main: startGlobalPtt"]
  MainPTT --> Mix
```

- Нейро-шумодав: `@jitsi/rnnoise-wasm`.
- Глобальный PTT крутится в main **только** пока какая-то комната в голосе в режиме PTT.
- В голосе максимум одна комната; `App.tsx` зеркалит call в StatusBar на всех страницах.

---

## 10. Виртуальный LAN

Hamachi-подобный L3-туннель внутри комнаты: игры, которые видят только LAN, ходят через интернет. Windows-first, Wintun, адреса из `100.64.0.0/10`, MTU **1280**.

Главное разделение: **helper тривиален и privileged, мозг — в engine-окне, main только оркестрирует и никогда не на пути пакета.**

```mermaid
flowchart TB
  subgraph MainLAN["Main — asInvoker"]
    LM2["LanManager"]
    LM2 -->|"1× UAC, SID + handshake path в argv"| Spawn["Start-Process -Verb RunAs"]
    LM2 -->|"lanStart / lanStop"| Eng2
  end

  subgraph HelperLAN["Havvn.exe --lan-helper — admin"]
    Wintun["Wintun adapter + ring"]
    PipeS["Named pipe server<br/>DACL на SID интерактивного юзера"]
    WD["PID-watchdog за main"]
    Wintun <--> PipeS
  end

  subgraph EngineLAN["room-engine — medium IL"]
    Eng2["room-lan.ts"]
    Mesh2["LanPeer mesh<br/>negotiated datachannel id:0"]
    Router["shared/lan-router.ts<br/>classify, replicate broadcast, budget"]
    Core["shared/lan-session-core.ts<br/>admit / evict / genesis / floor"]
    Eng2 --> Mesh2
    Eng2 --> Router
    Eng2 --> Core
    Eng2 <-->|"length-prefixed raw frames"| PipeS
  end

  Mesh2 <--> Other["Пиры комнаты по WebRTC"]
```

Инварианты (сжато; полная спецификация — `docs/handoff/virtual-lan-plan.md`):

1. Членство в комнате **необходимо, но недостаточно**. В mesh попадает только host-подписанный `lan-admit`.
2. vIP — чистая функция `(sessionId, memberId, gen)`; заявленный адрес сверяется, иначе unicast можно угнать.
3. Одна активная LAN-сессия на установку (бета).
4. sessionId переиспользуется между запусками **только** с персистентным watermark (`session.floor`), иначе старый `lan-admit` можно реплеить.
5. Evict ротирует sessionId (адреса меняются).
6. VPN-детектор исключает диапазон сессии `100.64/10`, а не имя адаптера — иначе leak или мёртвый bind.

---

## 11. Игровые серверы в комнате

Сейчас модуль — Minecraft. Архитектурный инвариант: **модуль возвращает план, ядро исполняет эффекты**. Модуль не качает, не спавнит, не пишет диск.

```mermaid
flowchart TB
  UI2["RoomServerPanel + console / players / backup"] -->|rooms:srv*| IPC2["handlers.ts"]
  IPC2 --> SM2["ServerManager"]

  SM2 --> Mod["GameModule Minecraft<br/>planInstall / planLaunch / parseLine"]
  SM2 --> Fetch["fetcher.ts — hash-pinned download"]
  SM2 --> Sup["supervisor.ts — spawn + health"]
  SM2 --> Mirror["server-mirror.ts — состояние в комнату"]
  SM2 --> Ann["announcer.ts — LAN multicast 224.0.2.60"]
  SM2 --> Sched["server-scheduler.ts"]
  SM2 --> Alert["server-alerts.ts"]

  Fetch --> Disk2["instance root, RelPath only"]
  Sup --> JVM["java + server JAR"]
  Mirror --> RM3["RoomManager → gossip"]
  Ann --> LAN3["Virtual LAN / физический NIC"]
```

Три уровня доверия (`shared/gameserver-types.ts`):

| Тир | Что это | Уровень доверия |
|-----|---------|-----------------|
| A. Modules | Код в бандле | Полный |
| B. Presets | Данные: версия + конфиг, без URL/argv/exe | Безопасны для шаринга |
| C. Content | Моды/миры с манифеста комнаты | Недоверенные; exe — consent на хеш |

Путь из модуля — только `RelPath` без `..`. Ядро резолвит под корень инстанса (`shared/gameserver-core.ts`). Консоль в UI батчится (120 мс / 400 строк), чтобы старт модпака не убил IPC.

Состояние серверов — отдельный `servers.json` (`electron/db/servers-store.ts`).

---

## 12. Поиск и RSS

Индексаторы **не бандлятся**. Пользователь приносит Jackett, Prowlarr/Torznab, свой JSON API или локальный Python-скрипт (`docs/search-plugins/`). Единственный предзасеянный RSS — FOSS Torrents, **выключен**.

```mermaid
flowchart LR
  subgraph SearchFlow["Search"]
    SP["SearchPage"] --> SS["SearchService"]
    SS --> J["Jackett"]
    SS --> T["Torznab / Prowlarr"]
    SS --> C["Custom JSON"]
    SS --> Py["Python plugin + th-plugin manifest"]
    SS --> Dedupe["shared/search-dedupe.ts<br/>одна строка на торрент"]
    Dedupe --> SP
    SP --> Add2["downloads:add paused + category"]
  end

  subgraph RSSFlow["RSS"]
    RP["RSSPage"] --> RS2["RSSService"]
    RS2 --> Poll["Пер-фид таймер<br/>jitter + backoff"]
    Poll --> Parse["shared/feed-parse.ts"]
    Parse --> Rules["shared/rss-rules.ts<br/>include/exclude, size, seeds, age, episode"]
    Rules --> Add3["downloads:add"]
    RP <--> OPML["shared/opml.ts"]
  end
```

Правило RSS матчит слова/regex, размер, сиды, возраст; умный episode-match держит одну копию эпизода. Хватаются только пункты **после** подписки, не бэк-каталог.

---

## 13. Хранение данных

Нет Postgres/Redis/облака. `electron-store` пишет несколько JSON в `userData`, чтобы горячий прогресс закачек не переписывал многомегабайтный блоклист.

```mermaid
flowchart TB
  StoreAPI["db/store.ts — единственный владелец"] --> C["config.json<br/>settings, categories, scheduler,<br/>privacy, window, network profiles"]
  StoreAPI --> D["downloads.json — горячий путь"]
  StoreAPI --> R["rss.json — feeds, items, rules"]
  StoreAPI --> B["blocklists.json — ranges"]
  StoreAPI --> S["search.json — providers"]
  StoreAPI --> RM["rooms.json — rooms, profile,<br/>tombstones, encrypted chat"]
  StoreAPI --> Rep["reputation.json"]
  StoreAPI --> Srv["servers.json"]
  Secrets["db/secrets.ts"] --> OS["OS DPAPI / Keychain"]
```

Torrent-host **не** открывает store: ходит в main через db-bridge (`getSettings`, `createDownload`, `updateDownloadsProgressBatch`, …). Один писатель — меньше гонок и поломанных файлов.

---

## 14. Доменные сущности

Центр контракта — `shared/types.ts` плюс `shared/gameserver-types.ts` и `shared/lan-types.ts`.

```mermaid
classDiagram
  class Download {
    id
    infoHash
    status
    progress
    speeds
    category
    filePriorities
    seedLimits
  }
  class TorrentFile {
    name
    path
    length
    priority
  }
  class Category {
    id name icon color
  }
  class Room {
    roomId name invite folder e2e owner transferChain
  }
  class RoomMember {
    memberId role online have[] relayed
  }
  class RoomFile {
    fileId=infoHash folderId enc revive
  }
  class RoomState {
    members files transfers voice lan sync
  }
  class RoomProfile {
    memberId displayName colors Ed25519
  }
  class RSSFeed
  class RSSRule
  class SearchProvider
  class AppSettings
  class PrivacyConfig
  class SchedulerConfig
  class LanRoomPrefs
  class RoomServerInstance

  Download "1" --> "*" TorrentFile
  Download --> Category
  Room "1" --> "*" RoomMember
  Room "1" --> "*" RoomFile
  Room --> RoomState : live push
  Room --> LanRoomPrefs
  Room --> RoomServerInstance
  RoomProfile --> RoomMember : local identity
  RSSFeed --> RSSRule
  AppSettings --> PrivacyConfig
  AppSettings --> SchedulerConfig
```

---

## 15. Локальные HTTP-поверхности

Это не публичный API продукта. Серверы слушают localhost / LAN по желанию пользователя.

| Сервер | Где | Зачем |
|--------|-----|--------|
| CastServer | torrent-host, динамический порт | HLS, транскод, QR «смотреть на телефоне» |
| WebRemoteServer | main, порт из настроек | Мобильный пульт, token auth, выключен по умолчанию |
| Transmission RPC | sidecar localhost | Управление native-движком |
| webpack-dev-server | только `npm run dev` | HMR renderer |
| Статика | `docs/share/index.html`, `docs/watch/index.html`, `docs/room/` | Браузер друга: принять шару / смотреть LAN / войти в комнату |

Внешние URL, которые пользователь сам настраивает: RSS, Jackett/Torznab, блоклисты, свои WebRTC-трекеры, опциональный TURN.

---

## 16. Фоновые таймеры

Отдельного job-раннера нет — всё in-process.

| Задача | Интервал | Где |
|--------|----------|-----|
| Статы закачек → UI | 750 мс | torrent-host |
| Персист прогресса | 5 с, debounce batch | host → db-bridge |
| Планировщик лимитов | 60 с | `scheduler-engine.ts` |
| RSS poll | пер-фид, дефолт 30 мин + jitter | `rss-service.ts` |
| Probe игрового сервера | 15 с | `server-manager.ts` |
| Расписание сервера | 15 с | `server-scheduler.ts` |
| Tray tooltip | 3 с | `main.ts` |
| UPnP renew | периодически | `port-forwarding.ts` |
| Clipboard magnets | poll | `clipboard-watcher.ts` |
| VPN / disk / network-profile | по событию сети | guards в `utils/` и `services/` |

---

## 17. Приватность и защита периметра

```mermaid
flowchart TB
  Net["Смена сети / VPN drop"] --> Guard["VpnGuard"]
  Guard -->|pause torrents| Host3["torrent-host"]
  Guard -->|suspend rooms| RM4["RoomManager.networkSuspended"]
  Guard -->|не спавнить helper| LM4["LanManager"]
  Guard --> UI3["баннер vpn:dropped"]

  DiskG["DiskGuard — мало места"] --> Host3
  Bind["VPN bind address пропал"] --> UI3

  DoH["DNS-over-HTTPS"] --> Host3
  BL["IPBlocklistService"] --> Host3
  SCH2["SchedulerEngine"] --> Host3
```

Kill-switch ставит `networkSuspended` на комнатах так, чтобы любой lazy re-join шёл через один гейт. Виртуальный LAN дополнительно проверяет VPN и после UAC (промпт может висеть сколько угодно, за это время VPN может отвалиться).

Логи проходят `privacy-logger` (санитизация IP/путей). Шифрование протокола BitTorrent — на стороне Transmission (`encryption: required|preferred|allowed`); в старом WebTorrent этого не было.

---

## 18. Сборка, тесты, релиз

```mermaid
flowchart LR
  Dev["npm run dev"] --> W["webpack serve renderer"]
  Dev --> E["tsc electron + electron ."]

  CI["push/PR → main"] --> T["typecheck"]
  CI --> V["vitest run"]
  CI --> B["npm run build"]

  Tag["git tag v* == package.json version"] --> Rel["release.yml windows-latest"]
  Rel --> FW["fetch-wintun + fetch-transmission"]
  Rel --> Dist["electron-builder --win NSIS + zip"]
  Rel --> GH["Draft GitHub Release + CHANGELOG"]
```

- Тесты: Vitest, без jsdom. Тяжёлая логика покрыта в `shared/*.test.ts` и точечно в electron.
- Протоколы установщика: `magnet:`, `havvn://`. Ассоциация `.torrent`.
- Релиз неподписанный (`CSC_IDENTITY_AUTO_DISCOVERY: false`). SHA-256 и VirusTotal — в notes.
- Vendor-бинари не в git: `node scripts/fetch-wintun.mjs` и `fetch-transmission.mjs`.

---

## 19. Как сценарии проходят через систему

### Добавить торрент и смотреть по LAN

```mermaid
sequenceDiagram
  actor U as Пользователь
  participant UI as DownloadsPage
  participant IPC as handlers
  participant Host as torrent-host
  participant Cast as CastServer
  participant Phone as Браузер на телефоне

  U->>UI: magnet / файл / поиск
  UI->>IPC: downloads:add
  IPC->>Host: rpc addDownload
  Host-->>UI: stats 750ms
  U->>UI: Cast / Watch on LAN
  UI->>IPC: cast:start
  IPC->>Host: castPublish
  Host->>Cast: HLS (+ ffmpeg если нужно)
  Cast-->>Phone: docs/watch + QR URL
```

### Создать комнату, синхронизировать файл, включить LAN и Minecraft

```mermaid
sequenceDiagram
  actor A as Хост
  actor B as Друг
  participant UI as RoomsPage
  participant RM as RoomManager
  participant Eng as room-engine
  participant LAN as LanManager + helper
  participant GS as ServerManager

  A->>UI: создать комнату
  UI->>RM: rooms:create
  RM->>Eng: join local + persist
  A-->>B: invite / havvn://join
  B->>RM: rooms:join после подтверждения
  Eng->>Eng: WebRTC + gossip roster
  A->>UI: добавить файл
  UI->>RM: rooms:addFiles
  Eng->>Eng: WebTorrent sync в shared folder
  A->>UI: Start LAN + pick peers
  RM->>LAN: UAC helper
  LAN-->>Eng: pipe rendezvous
  Eng->>Eng: lan-admit, vIP, Wintun frames
  A->>UI: Create Minecraft server
  UI->>GS: rooms:srv*
  GS->>GS: plan → fetch pinned → spawn JAR
  GS->>Eng: mirror state + LAN announce
  B->>B: клиент видит сервер в «локальной сети»
```

---

## 20. Ключевые файлы — навигатор

| Зачем открыть | Файл |
|---------------|------|
| Старт приложения, tray, lifecycle | `electron/main.ts` |
| Весь IPC | `electron/ipc/handlers.ts` |
| Контракт `window.api` | `electron/preload.ts`, `shared/types.ts` |
| Store и миграции JSON | `electron/db/store.ts` |
| Шов торрент-движка | `electron/torrent/host/manager-proxy.ts`, `torrent-host.ts` |
| Transmission sidecar | `electron/torrent/native/` |
| Комнаты | `electron/sharing/room-manager.ts`, `room-engine.ts` |
| Голос | `electron/sharing/room-voice.ts` |
| LAN data-plane | `electron/sharing/room-lan.ts`, `electron/lan/lan-manager.ts` |
| Чистый LAN-роутер | `shared/lan-router.ts`, `shared/lan-session-core.ts` |
| Игровые серверы | `electron/gameserver/server-manager.ts` |
| UI-оболочка | `renderer/App.tsx` |
| Машина состояний закачки | `shared/state-machine.ts` |

Смежные дизайн-доки: `docs/engine-swap-plan.md`, `docs/native-host-contract.md`, `docs/handoff/virtual-lan-plan.md`, `docs/voice-chat-plan.md`, `docs/rooms-ownership-transfer.md`, `docs/rooms-kick-hardening.md`, `docs/handoff/CONVENTIONS.md`.

---

## 21. Чего в архитектуре намеренно нет

- Облачных аккаунтов, OAuth, центрального API.
- Docker / Kubernetes / отдельного backend-сервиса.
- GraphQL, REST для продукта, общего WebSocket-сервера (вместо этого — WebRTC data channels).
- Prisma / Mongo / Redis.
- React Router (страница — состояние `App.tsx`).
- Глобального Zustand-стора приложения.

Итог в одном предложении: **Havvn — многопроцессный локальный оркестратор**, у которого UI подписан на IPC, файлы живут в JSON, байты файлов идут BitTorrent/WebTorrent, а «онлайн» комнаты — это WebRTC-mesh с опциональным L3-туннелем и игровым процессом внутри, без серверов разработчика.
