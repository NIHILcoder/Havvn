# TorrentHunt — план смены движка закачки (Engine Swap / "2.0")

> **СТАТУС (2026-07-07): спайк ПРОЙДЕН — GO по transmission-daemon.**
> Результаты и вердикт: [§ Результаты спайка](#результаты-спайка-2026-07-07).
> Контракт host-шва для портирования: [native-host-contract.md](native-host-contract.md).
> Ребрендинг в **Havvn** выполнен в этой же сессии (userData-миграция, инсталлятор,
> peer-id `-HV`, UI/доки; appId и GitHub-URL сохранены намеренно — непрерывность
> апдейтов и старых share-ссылок).

> Решение принято 2026-07-06 после A/B-теста: на идентичной раздаче (ELDEN RING,
> 68 ГБ, 185 сидов) и канале qBittorrent (libtorrent) держит **стабильные
> ~10 MB/s**, TorrentHunt (webtorrent 1.9.7) — скачет 4–11 с провалами до 2.
> Включение DHT + µTP закрыло ~90% разрыва (вышел на 9–10 стабильно), но
> остаточные провалы = потолок webtorrent (JS-хеширование, слабый piece-picking,
> µTP LEDBAT-backoff). Вывод: для «rock-solid» закачки нужен нативный движок.

## Цель
Заменить движок **ЗАКАЧКИ** (webtorrent в host-процессе, `electron/torrent/manager.ts`)
на нативный BitTorrent-движок как **sidecar-процесс, управляемый по RPC**.
webtorrent оставить **ТОЛЬКО** для WebRTC (комнаты, share-ссылки, remote-cast).

Payoff: qBit-класс закачки — ровная скорость, endgame, protocol-шифрование
(больше достижимых пиров), настоящий piece-picking, **настоящие per-torrent
лимиты** (вернём вырезанную фичу), нормальный µTP/DHT без флаки utp-native.

> **Ребрендинг** идёт в паре с 2.0 (уходим от «TorrentHunt» — пиратская оптика).
> Идеи названия: [rebranding-ideas.md](rebranding-ideas.md). Делать ПОСЛЕ/ВМЕСТЕ
> с движком, не раньше (ребренд на нестабильном движке = помада на трещине).

## Хорошая новость: шов уже готов
Движок живёт в utilityProcess за `electron/torrent/host/manager-proxy.ts` —
типизированный интерфейс (addDownload/pause/resume/removeDownload/getStats/…).
Рендер + IPC + proxy **не знают** про webtorrent. Значит: меняем реализацию
ЗА host'ом (новый `torrent-host-native` за тем же proxy-контрактом), рендер и
IPC не трогаем.

## Плохая новость: это НЕ drop-in
`manager.ts` = ~3600 строк и делает не только «качать». Много фич завязано на
webtorrent-объекты (`torrent.files`, `_selections`, `torrent.wires`,
`torrent.discovery.tracker._trackers`, `torrent._peers`, `torrent.received`).

### Ремапится на RPC чисто
add / pause / resume / remove / recheck; stats (progress / speed / peers / bytes /
ratio); выбор файлов + приоритеты; per-torrent лимиты скорости; трекеры
(add / remove / статус); список пиров.

### Требует переделки / есть риск потери
- **Instant-play стриминг** (`getStreamUrl` + `prioritizeStreamHead`) — глубоко на
  webtorrent (`torrent.files[i].createReadStream`, `select(start,end,priority)` на
  голову файла). Это ПОДПИСНАЯ фича TorrentHunt.
  - rqbit имеет встроенный HTTP-стриминг-эндпоинт → можно переиспользовать.
  - transmission НЕ стримит → приоритет первых кусков файла по RPC + читать
    растущий файл с диска самим. Реально, но работа.
- **Cast / transcode** (`cast-server.ts`) — читает on-disk `diskPath`, почти
  движок-агностично; нужно лишь чтобы движок отдавал путь файла на диске. OK.
- **Swarm-карта** (`getSwarmGeo`) — нужны IP пиров от движка (transmission отдаёт
  per-peer address; rqbit — проверить в спайке).
- **Peers-вкладка** (connType/client/скорости/прогресс) — transmission `torrent-get`
  peers даёт address/clientName/isUTP/isEncrypted/rateToClient/progress. Покрыто.
- **DoH** (`host/doh-lookup.ts` патчит `dns.lookup` внутри webtorrent-процесса) —
  с внешним движком: либо конфиг DNS/proxy движка (если умеет), либо фича
  теряется/переделывается. Скорее всего частичная потеря.
- **IP-блоклист** — сейчас фильтрует webtorrent-wires в host'е. transmission имеет
  свой blocklist (RPC-настраиваемый); rqbit — проверить. Иначе фильтровать иначе.
- **UPnP порт-форвардинг** — форвардить порт движка (или transmission сам умеет
  NAT-PMP/UPnP → можно отдать ему).

### УДАЛЯЕТСЯ / упрощается (чистый плюс)
- Весь `_selections`-хакинг + сага паузы/ложного-завершения → у движка НАСТОЯЩАЯ
  пауза. Уходит `haltTorrent`, `resumeInPlace`, done-backstop.
- Connection budgeting + slow-start + адаптивный upload-троттл (сотни строк
  воркэраундов «торренты убивают инет/роутер») → нативный движок сам нормально
  рулит соединениями; задаём глобальный лимит + лимиты по RPC.
- Ковыряние приватных полей webtorrent (~32 места) → уходит.
- Целый класс обёрточных багов (аудит-28, pause false-complete) → неактуален.

**Нетто:** свап трогает бóльшую часть manager.ts, но результат — manager ПРОЩЕ и
надёжнее.

## Что остаётся на webtorrent
`room-engine.ts` (комнаты, WebRTC), `share-seeder.ts` / `remote-cast-engine.ts`
(share, WebRTC), опционально `creator.ts` (создание .torrent). webtorrent
остаётся в зависимостях, но НЕ для закачки. Два движка в разных процессах — норм.

## Выбор движка

| | rqbit (Rust) | transmission-daemon (C) | qbittorrent-nox |
|---|---|---|---|
| Лицензия | **Apache-2.0** — бандли свободно | GPLv2 — обязательства | GPL |
| Зрелость | моложе | **очень зрелый / стабильный** | эталон (libtorrent) |
| Бинарь | один статический | небольшой | тяжёлый |
| API | JSON HTTP + **встроенный стриминг** | comprehensive JSON-RPC | WebUI API |
| µTP/DHT/шифр | проверить в спайке | **всё есть, проверено** | всё есть |
| Риск | покрытие API под наши фичи | streaming надо переделать | оверкилл бандлить |

**Рекомендация (для снижения риска):** manager нуждается в ШИРОКОМ API движка
(file-priority, per-peer для swarm-карты, tracker CRUD, лимиты, blocklist).
- **transmission** — гарантированно покрывает всё это зрелым RPC → ниже риск
  «а этого API нет». Цена: GPL (решается — sidecar через RPC = «агрегация», не
  линковка; бандлим бинарь + даём ссылку на исходники) + стриминг переделать.
- **rqbit** — чистая лицензия + один бинарь + модерн + встроенный стриминг
  (плюс для нашей подписной фичи), НО покрытие остального API — под вопросом.

### РЕШЕНО (2026-07-06): начинаем с **transmission-daemon**
Самый эффективный/низкорисковый для нас, потому что:
1. Гарантированно чинит ядро — зрелый µTP + protocol-шифрование + нормальный
   piece-picking (у rqbit это под вопросом; без них свап бессмысленен).
2. RPC покрывает ВСЁ наше без «а этого API нет»: файлы+приоритеты, per-peer
   (address/isUTP/isEncrypted/rate/progress), трекеры add/remove+статус, настоящие
   per-torrent лимиты, blocklist, шифрование, своё UPnP/NAT-PMP.
3. Маленький кроссплатформенный бинарь + десятилетия надёжности.

Цена: (а) стриминга нет из коробки → переделать (high-priority первым кускам по
RPC + отдавать растущий файл с диска своим HTTP-сервером); (б) GPL → sidecar через
RPC = агрегация, бандлим бинарь + ссылка на исходники.

**rqbit = план Б** (Apache-лицензия + встроенный стриминг), но взять его можно
ТОЛЬКО если спайк докажет крепкий µTP+шифрование И покрытие API. Иначе риск не
вытянуть само ядро. qbittorrent-nox отклонён: тяжёлый бинарь, оверкилл.

## Стратегия (без big-bang)
Инкрементально, за тем же proxy-контрактом:
1. **Спайк (1–3 дня):** забандлить движок, спаунить sidecar из host'а, дёргать RPC.
   Реализовать МИНИМУМ: add magnet/.torrent, progress/speed/peers, pause/resume/remove.
2. **A/B тот же ELDEN RING** → даёт ли движок qBit-ровные ~10 MB/s? (должен —
   libtorrent/rqbit-класс). Инвентаризировать API-покрытие must-have фич.
3. Go/no-go по движку.
4. Портировать по одной фиче: выбор файлов/приоритеты → стриминг → cast → трекеры
   → peers/swarm → блоклист → порт-форвард. webtorrent-host держать как fallback
   (флаг/настройка) до паритета ядра.
5. Релиз когда ядро твёрдое; продвинутое (swarm-geo detail, DoH) может отстать
   или быть осознанно урезано.

## Риски / чем платим
- Регрессии в стриминге-во-время-закачки, swarm-карте, DoH — переделка/деградация,
  часть фич может отвалиться.
- Бандлинг натив-бинаря по платформам (сейчас Windows; Mac/Linux если расширять)
  + подпись exe (Windows) + супервизия sidecar (спаун/краш/рестарт/порт).
- manager — большой рерайт, высокий regression-риск возле streaming/cast.
- GPL-обязательства (если transmission/qbit).
- Инсталлятор потяжелеет (два движка).

## Первый шаг новой сессии
**Спайк движка** (начать с rqbit ИЛИ transmission — см. выбор выше):
1. Забандлить бинарь движка (`extraResources` в electron-builder), спаунить его
   из host-процесса как sidecar на локальном порту.
2. Через RPC/HTTP добавить магнет/.torrent ELDEN RING, запустить закачку, снять
   stats (progress/speed/peers).
3. **Замерить:** выходит ли на qBit-ровные ~10 MB/s на том же торренте/канале.
4. **Инвентаризировать API:** есть ли file-priority, per-peer список (address/
   utp/enc/rate/progress), tracker add/remove, per-torrent speed limit, blocklist.
5. Итог спайка = go/no-go на движок + карта, что из фич ремапится, что переделывать.

## Результаты спайка (2026-07-07)

**Вердикт: GO.** transmission-daemon 4.1.3 подтверждён как движок 2.0; rqbit
(план Б) не понадобился.

### Что собрано
- `vendor/transmission/win32-x64/` — портативный набор из 5 файлов
  (daemon 2.3 МБ + libcurl/libcrypto/libssl/zlib, всего ~9.6 МБ). Восстановление:
  `node scripts/fetch-transmission.mjs` (пин 4.1.3 + SHA-256; 4.1.3 обязателен —
  фиксы CVE в CORS-nonce и peer-коде). GPL-заметка: `vendor/transmission/README.md`.
- `electron/torrent/native/transmission-rpc.ts` — типизированный RPC-клиент
  (409/X-Transmission-Session-Id, Basic auth; юнит-тесты рядом).
- `electron/torrent/native/transmission-sidecar.ts` — супервизор: пишет
  settings.json (RPC только на 127.0.0.1, случайные креды на каждый запуск,
  µTP+DHT+PEX+LSD+шифрование preferred), свободные порты, ожидание готовности,
  чистый стоп через `session-close`. Без Electron-импортов.
- `npm run spike:engine -- <magnet|url|file.torrent>` — харнесс: замер скорости,
  pause/resume, инвентаризация API (`.spike/inventory.json`).

### Замер (Ubuntu 24.04.4 ISO 6.66 ГБ, DHT-only — трекеры Ubuntu не отвечали)
| Прогон | Условия | Результат |
|---|---|---|
| 1 | холодный DHT | бутстрап ~2 мин с 0 пиров, потом 5.4→6.7 MB/s на 17 пирах (все 17 µTP, все 17 encrypted) |
| 2 | тёплый DHT, лимит 50 пиров (дефолт) | first traffic 20 c; steady **avg 7.12 / med 7.23 / p90 8.48 / max 8.92 MB/s**, p10 5.58 |
| 3 | лимиты как в приложении (100/300) | 81 пир; steady **avg 7.56 / med 7.95 / p90 8.65 / max 9.05 MB/s** |

Кривая ровная, провалов webtorrent-типа (до 2 MB/s) нет; p10 ≥ 5 MB/s.
Демон готов к RPC за ~330 мс от спауна. pause → status=stopped мгновенно;
resume → трафик восстанавливается (первый прогон дал ложный FAIL — резюм в
мёртвый swarm; методика исправлена: контролы гоняются только на живом swarm).
**Остаётся финальная сверка A/B на том же ELDEN RING тем же каналом** (стр. 2
плана): `npm run spike:engine -- "<magnet ELDEN RING>"` рядом с qBittorrent.

### API-инвентаризация вживую (4.1.3, rpc 6.0.1, old-dialect имена работают)
Все must-have пробы ✓ (set → read-back → restore): per-torrent лимиты скорости,
**sequential_download** (плюс `sequential_download_from_piece` в спеке 4.1 — путь
для стриминг-головы вместо `_selections`-хакинга), приоритеты файлов,
трекеры через `trackerList` (read-modify-write; trackerAdd/Remove deprecated),
alt-speed (нативный «turtle»), blocklist (url+enabled+update), seed ratio/idle
лимиты. Поля присутствуют: files/fileStats/priorities/wanted, peers
(address/clientName/isUTP/isEncrypted/rateToClient/rateToPeer/progress/flagStr),
trackerStats, pieces/pieceCount/pieceSize, **availability** (карта доступности
кусков — лучше webtorrent), labels, group. Полный дамп: `.spike/inventory.json`.

Ключевые оговорки для портирования (из спеки + прогона):
- Целиться на **hashString**, не на числовой id (id нестабилен между рестартами).
- Нет поля «connected seeds» — аппроксимировать `peersSendingToUs` (текущий UI
  так и живёт); нет статуса 'error' — синтезировать из `error != 0`.
- Per-torrent лимиты в **кБ/с целых**; `utp-enabled` в 4.1 deprecated в пользу
  `preferred_transports` (settings.json-ключ пока работает).
- .torrent-байты назад по RPC не отдаются (есть `torrent_file` путь на диске
  демона + `magnetLink`).

## Полезные ссылки/факты для новой сессии
- Шов: `electron/torrent/host/manager-proxy.ts` (интерфейс), `torrent-host.ts`
  (текущая webtorrent-реализация). Новую делать рядом: `torrent-host-native.ts`.
- Что оставить на webtorrent: `electron/sharing/*` (WebRTC).
- Стриминг-код для переделки: `getStreamUrl` / `prioritizeStreamHead` /
  `ensureTranscodeServer` в manager.ts + `cast-server.ts`.
- electron-builder: бинарь движка через `build.extraResources`, при упаковке —
  подпись (у проекта signtool уже настроен).
