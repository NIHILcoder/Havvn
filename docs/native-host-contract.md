# Host-шов: контракт для torrent-host-native (transmission)

> Справочник для фазы портирования (engine-swap-plan.md, шаг 4): что именно
> должна реализовать нативная реализация host'а (`torrent-host-native.ts`),
> чтобы встать за `manager-proxy.ts` вместо webtorrent-host'а, ничего не меняя
> в main/IPC/рендере. Снято с кода 2026-07-07.

## Boot-последовательность
1. Main: `getTorrentManager()` ([manager-proxy.ts:220](../electron/torrent/host/manager-proxy.ts)) →
   `initialize()` → `utilityProcess.fork(torrent-host.js, {stdio:'pipe'})`; на
   `spawn` main шлёт `{kind:'init', env: getHostEnv()}`.
2. `HostEnv` ([env.ts](../electron/torrent/host/env.ts)):
   `{version, isPackaged, tempDir, userDataDir, downloadsDir}` — host обязан
   вызвать `setHostEnv(env)` до любого кода движка.
3. Host по порядку: `setHostEnv` → `wireDbBridge(post)` → создать manager →
   `setCastManager(manager)` → подписать onStats→event'stats',
   onComplete→'complete', onListening→postState → `await manager.initialize()`
   (ошибки глотаются) → `postState()` → `{kind:'ready'}`. Любой throw в init →
   `process.exit(1)` (proxy пере-спаунит и fail-fast'ит pending).
4. ffmpeg: `require('ffmpeg-static')`, при `isPackaged` замена `app.asar` →
   `app.asar.unpacked`; путь уходит в 'state'-событие.

## Протокол сообщений (protocol.ts)
- main→host: `init{env}`; `rpc{id, method, args[]}` (спец-методы:
  `createTorrentFile` → creator; `castPublish/castUnpublish/castTvMedia/castPublishDiskFile`
  → cast-server; остальное — динамический вызов `manager[method](...args)`);
  `db-res{id, ok, result|error}`.
- host→main: `ready`; `rpc-res{id, ok, result | error, code?, name?, downloadId?}`
  (code восстанавливает TorrentError: DUPLICATE / NO_SPACE / NOT_FOUND /
  NOT_ACTIVE / INVALID_INPUT / TIMEOUT / LOAD_ERROR / FILE_NOT_FOUND);
  `db{id, fn, args[]}` (fn ∈ DB_BRIDGE_FNS); `event{event, payload}`:
  - `stats`: `DownloadStats[]` каждые **750 мс**;
  - `complete`: `{id, name}` (main показывает OS-уведомление);
  - `state`: `{ffmpeg, listeningPort, altSpeedEnabled}` — после init, при
    bind'е порта и после setAltSpeed/updateSettings (питает синхронные геттеры
    proxy: getStats/getListeningPort/isAltSpeedEnabled/ffmpegBinary);
  - `create-progress`: прогресс хеширования createTorrentFile.
- Host глотает транзиентные socket-ошибки процесс-уровня (ENOBUFS/EMFILE/
  ECONNRESET/EPIPE), прочее → exit(1).

## Настройки, которые движок читает (AppSettings)
`defaultDownloadDir` (fallback savePath); `maxDownKbps/maxUpKbps` (0=∞);
`altSpeedEnabled/altDownKbps/altUpKbps` (замещают обычные лимиты);
`maxActiveDownloads` (очередь, seeding не считается); `enableDHT`;
`enablePEX/enableLSD` (у webtorrent no-op — **transmission умеет честно**);
`enableUtp`; `maxConnections`/`maxConnectionsGlobal`; `portMin` (=слушающий
порт, 0=OS; `portMax` не используется); `portForwarding` (живёт в MAIN — при
transmission можно отдать демону `port-forwarding-enabled` и выключить свой
UPnP); `adaptiveUpload` (webtorrent-воркэраунд — с transmission не нужен);
`dohEnabled/dohTemplateId/dohCustomTemplates` (патчит dns.lookup в host'е —
с внешним демоном частично теряется); `autoMoveEnabled/autoMovePath`;
`defaultSeedRatioLimit/defaultSeedTimeLimitMinutes` (+ пер-Download оверрайды).
Шифрование MSE/PE: в настройках НЕТ (webtorrent не умел) — transmission даёт
`encryption: required|preferred|allowed`; добавить новую настройку.
Блоклист: НЕ в settings — main шлёт `applyIpBlocklist(ranges)` RPC; с
transmission заменить на его blocklist-механизм (URL+update) или конвертацию.

## DownloadStats (shared/types.ts) — пуш каждые 750 мс
`{id, progress 0..1, downloadedBytes, uploadedBytes, downSpeedBps, upSpeedBps,
etaSeconds|null, peers, seeds, status}`; status ∈ queued|downloading|paused|
completed|seeding|error|removed. Одна запись на КАЖДЫЙ неудалённый Download —
включая паузу/очередь/ошибку (скорости 0, персистентный прогресс).
`downloadedBytes/uploadedBytes` — lifetime (база из БД + сессия). `seeds` =
peers при seeding, иначе 0 (webtorrent-легаси; transmission может дать
`peersSendingToUs` честнее). Персист в БД батчем каждые 5 с
(`updateDownloadsProgressBatch`).

## DB-мост (главный процесс — единственный владелец store)
Host зовёт удалённо ровно 12 функций: getSettings, updateSettings (только из
setAltSpeed), getAllDownloads, getDownloadById, getDownloadsByStatus,
createDownload, deleteDownload, updateDownloadStatus, updateDownloadField,
updateDownloadFields, updateDownloadProgress, updateDownloadsProgressBatch.
Download-запись: см. shared/types.ts:14-51 (Dates ходят ISO-строками).
Нативный host ОБЯЗАН сохранить этот мост и имена fn.

## Стриминг и cast (переделка под диск)
Сегодня: `getStreamUrl(id, fileIndex)` → webtorrent-сервер на 127.0.0.1 с
Range-чтением из торрента; `prioritizeStreamHead` = select первых ~16 МБ
(prio 10) + critical первые ~3 куска + sequential; всё откатывается в
`stopStream`. Transcode: общий http-сервер, ffmpeg из torrent-stream → fMP4.
Cast-server уже движок-агностичен: читает только `info.diskPath` обычным fs
(`getCastFileInfo` = `path.join(download.savePath, file.path||file.name)`,
fallback `seedPaths[0]`; `complete` должен быть честным — /direct отдаёт байты).
С transmission: файлы всегда на диске (sparse) →
1) свой Range-HTTP-сервер над растущим файлом; голову обеспечивает
   `sequential_download(+_from_piece)` + `files[].beginPiece/endPiece` (4.1);
   для не-головы — ждать докачки диапазона (или 416/буферизация);
2) transcode-роут читает с диска (как cast /stream) — проще текущего pipe;
3) `stopStream` — вернуть sequential=false и снять приоритеты.

## Минимум для boot'а приложения (spike-host)
Обязаны РАБОТАТЬ: init/ready + db-мост; периодические 'stats';
`getDownloads()` (можно просто `db.getAllDownloads()`); `applyIpBlocklist`
(хоть no-op); `destroy`; `updateSettings` (не бросать); 'state'-событие
(port 0 ок). Для «качается и видно»: `addDownload`, `pauseDownload/
resumeDownload/removeDownload`, `getFiles`, `getPeers`/`getTrackers` (можно []).
Могут бросать 'not implemented' (только по явному клику юзера): addSeed,
add/removeTracker, getSwarmGeo, стриминг/cast/сабтитры, getTorrentInfo,
recheck/retry/stopSeeding, pauseAllActive/resumeAllPaused, setFilePriority,
seed-лимиты, setSequentialDownload, setAltSpeed, getNetworkHealth,
createTorrentFile. NB: `castPublishDiskFile` зовут ещё и комнаты
(room-manager.ts:383).

## transmission-специфика (см. также engine-swap-plan.md § Результаты спайка)
Ключ торрента — hashString (int id нестабилен между рестартами демона);
'error'-статус синтезировать из `error != 0`; seeds ≈ `peersSendingToUs`;
лимиты в кБ/с; трекеры править через `trackerList` (add/remove deprecated);
`session-close` для чистого стопа; sidecar-модули уже готовы:
`electron/torrent/native/transmission-{rpc,sidecar}.ts`.

addSeed («start seeding»): у демона нет «seed вот эти пути» — контент ищется
строго как `download-dir/<имя из metainfo>`. Поэтому: add ПАУЗНУТЫМ с
download-dir=родитель источника → при кастомном имени торрента корень
переименовывается в имя на диске (`torrent-rename-path`; данных по старому
пути нет, так что это чистая правка внутреннего маппинга — infoHash и
розданный .torrent/magnet не меняются, rename живёт в resume демона) →
verify → start. Ре-адды (addToDaemon при seedPaths) повторяют
паузу→remap→verify. Несколько НЕЗАВИСИМЫХ источников замапить нельзя —
addSeed кидает INVALID_INPUT (webtorrent-движок это умеет).

## Актуальная очередь и опрос native (2026-10-10)

`maxActiveDownloads` применяется через очередь Transmission: обычные добавления,
возобновления и повторы используют `torrent-start`, `DownloadWait` отображается
как `queued`. Сидирование не занимает слот; простаивающая загрузка занимает,
поэтому `queue-stalled-enabled` выключен. Добавление всегда сначала остановлено:
это исключает обход очереди при получении metadata нового магнета. При старте
приложения `--paused` даёт менеджеру восстановить сохранённые статусы до передачи
данных. При уменьшении лимита лишние фоновые загрузки возвращаются в очередь;
при выборе сначала остаются загрузки с высоким приоритетом.

Просмотр использует `torrent-start-now` и сохраняет свой слот, в том числе пока
URL потока создаётся. Остальные загрузки уступают место просмотру. Если одновременно
просматривается больше торрентов, чем заданный лимит, просмотр временно превышает
лимит. `stopStream` снимает исключение и восстанавливает приоритеты файлов.

Опрос скоростей и прогресса запланирован каждые 750 мс. Пока предыдущий запрос,
переход состояния или запись батча не завершились, следующий тик пропускается.
Ответ после остановки менеджера отбрасывается. Полные списки пиров запрашиваются
раз в 5 секунд (с округлением до следующего тика); между запросами хранится только
число подключённых сидов. `getPeers` и карта swarm продолжают получать свежие данные
по запросу. Сохранение intent учитывает задержку между ответом RPC и фактической
сменой состояния, чтобы опрос не отменял паузу или возобновление.

Проверка на настоящем bundled daemon, во временном профиле, с изолированной БД
и отключёнными DHT/PEX/LSD и публичными трекерами:

```sh
npm run build:electron
node scripts/smoke-native-queue.cjs
```

Сценарии: добавление файлов и магнета, пауза и продвижение очереди, Resume All,
Retry, изменение лимита 1 → 2 → 1, приоритет просмотра и восстановление после
перезапуска. Меньшее потребление ОЗУ ожидается от ограниченного числа активных
передач и меньших RPC payload; точную экономию RSS нужно измерять на рабочей нагрузке.