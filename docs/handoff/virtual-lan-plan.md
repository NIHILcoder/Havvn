# Havvn Virtual LAN — план реализации

> Hamachi-подобный виртуальный LAN для игр внутри комнат. Транспорт поверх существующего
> WebRTC-mesh, Windows-first (Wintun), нулевые серверы/аккаунты, E2E-комнаты как есть.
> Основано на разведке 16 агентов + критик + 8 дочиток (run wf_b294ae48-4ea, 2026-07-24).

## 0. Зафиксированные решения (из вопросов пользователю + разведки)

| # | Решение | Уточнение по итогам разведки |
|---|---------|------------------------------|
| 1 | Полное автообнаружение (broadcast/mDNS/SSDP форвардинг) | Это и есть продукт: L3-TUN сам по себе LAN-дискавери НЕ даёт (Tailscale — доказанный провал; ZeroTier форвардит broadcast специально). Классификатор+репликация — killer-часть. |
| 2 | UAC при каждом включении | Форсирует **отдельный elevated-helper** — ни main, ни utilityProcess, ни скрытое окно не держат админ-токен. |
| 3 | Явная LAN-сессия (выбор пиров) | Несовместимо с голосовыми `MediaPeer` (они живут только в голосе). Нужен **свой mesh** по паттерну голоса. |
| 4 | Переиспользовать mesh | = переиспользовать **паттерн + плоскость сигналинга**, НЕ голосовые PC-объекты. Клон `MediaPeer` под dedicated data-channel. |
| 5 | Wintun, IP из 100.64/10, MTU ~1280 | **MTU = 1280 фикс** (>1192 фрагментит SCTP на 2 пакета, ×2 потери). 1360 убрать, оставить как advanced-тюнинг. |

## 0.1 ГЛАВНЫЙ ИНВАРИАНТ (правки адверсариал-ревью, перекрывают формулировки ниже)

Ревью (32 агента, run wf_bac54d60-476) подтвердило: архитектура верна, ни одно решение §0 не ошибочно. Но **«клонировать голос» безопасно для ТРАНСПОРТА (сигналинг, perfect-negotiation, реконнект) и НЕБЕЗОПАСНО для АВТОРИЗАЦИИ**. Голос открыт всем участникам комнаты by design; LAN — host-gated. Поэтому:

> **Членство в roster — необходимо, но НЕ достаточно. Каждый подписанный LAN-тип должен доказывать ПРАВО (entitlement), а не только членство в комнате.**

Восемь обязательных правок (детали вплетены в §2-§8 ниже):
1. **Admission-гейт внутри `ensurePeer`** — НЕ копировать self-service roster голоса. `admittedSet` наполняется ТОЛЬКО host-подписанным `lan-admit`; `ensurePeer` отказывает строить `LanPeer` для не-admitted; `lan-signal` от не-admitted дропается до `ensurePeer`. Иначе любой держатель room-key само-рострится → форсит канал → «не-участник физически не имеет PC» становится ложью, DTLS-only не спасает (атакующий — легитимный держатель ключа).
2. **`lan-admit` — rekey-стабильная авторитетность.** Это durable host-signed grant, НЕ транзиентный сигналинг → bind к `room.topic` его роняет на kick (топик ротируется). Класс — как `e2eCfg`/`tombSig` (re-mintable), НЕ как transferChain. Фикс: **ре-минтить живые `lan-admit` внутри `applyLocalRekey`** (как e2eCfg/tombSigs, room-engine.ts:2864-2900) + переанонс на hello. ИЛИ доменировать `lan-admit` над `sessionId` (rekey-стабильный якорь).
3. **Over-the-shoulder UAC — helper под ДРУГИМ SID/профилем.** `Start-Process -Verb RunAs` у стандартного юзера просит ОТДЕЛЬНЫЙ админ-аккаунт → (a) helper DACL'ит pipe на админ-SID → engine (medium-IL) получает ACCESS_DENIED; (b) `getPath('userData')` → %APPDATA% АДМИНА → handshake-файл не там. Фича молча мертва на managed/школьных/shared-PC. Фикс: **main захватывает SID интерактивного юзера + передаёт его и АБСОЛЮТНЫЙ путь handshake-файла в helper через argv**; helper DACL'ит pipe на этот явный SID и читает rendezvous по этому пути. Убрать `-lan-helper` userData-редирект (кросс-юзер бессмыслен, electron-store helper'у не нужен).
4. **Data-channel `negotiated:true, id:0` на ОБЕИХ сторонах.** Симметричный `createDataChannel` по умолчанию `negotiated:false` (in-band DCEP) → у каждой стороны СВОЙ канал, чужой приходит через `pc.ondatachannel`, который план не вешает → входящий трафик дропается. `{negotiated:true, id:0, ordered:false, maxRetransmits:0}` = один out-of-band duplex-канал, без DCEP, без ondatachannel; perfect-negotiation по-прежнему рулит только SDP/SCTP m-line.
5. **Идентичность адаптера/firewall/sweep — per-session (и per-instance).** Физический слой сейчас синглтон: ОДИН адаптер `Havvn LAN`, ОДИН /16, ОДИН sweep-по-фикс-имени → вторая сессия чёрно-дырит, а sweep сносит живую сессию-A. Ломает и собственный §9 TH_INSTANCE-тест (Windows запрещает дублирующиеся alias). **Решение для беты: глобальный инвариант «одна активная LAN-сессия», Start в других комнатах — greyed-out** (честный beta-scope); имя адаптера/InterfaceAlias/scope sweep'а — скоупить per-session-id (как pipe-token уже скоуплен). N-адаптеров + session-tag на каждом кадре — Phase 2+.
6. **Верифицировать КАЖДУЮ vIP-заявку против детерминированной деривации.** Подпись `lan-state` доказывает «член сказал», не «имеет право». vIP = чистая функция `(sessionId, memberId, gen)` → на каждом `lan-state` пересчитать `expected = deriveVip(...)`, reject если `claimed !== expected`. Иначе злоумышленник анонсит `lan-state{memberId:M, vip:V_victim}` → весь unicast жертве уходит M (перехват). Правило конфликта у ПРИЁМНИКА (не только back-off заявителя): владелец спорного vIP = тот, чей `(memberId,gen)` его деривит, tie-break младший memberId, одинаково на всех приёмниках → таблица сходится независимо от порядка флуда.
7. **Пиннить аутентифицированный session-genesis.** `by === session.hostId` бессмысленно, пока hostId не запиннен (в отличие от `room.ownerId` с invite-pin+transferChain). Отдельное подписанное **genesis-сообщение** (hostId = memberId создателя, подпись над `sessionId`, `verifySignedBy`, first-writer-wins per sessionId, reject поздний genesis с другим host). Каждый `lan-admit` верифицируется против запиннутого hostId — та же TOFU-дисциплина, что у владельца комнаты.
8. **VPN-исключение по ДИАПАЗОНУ АДРЕСОВ, не name+LUID.** `os.networkInterfaces()` даёт только `{family,address,internal}` по friendly-name — **LUID там НЕТ** (FFI не используется) → LUID-половина невыполнима, остаётся хрупкий матч по имени (юзер переименует → `selectVpnIPv4` вернёт мёртвый 100.64 → transmission биндится в никуда; обратно — реальный VPN упал, адаптер считается VPN → real-IP leak). Фикс: исключать по **диапазону** (session /16 внутри 100.64/10, лучше именно /16 сессии чем весь /10 — не проглотить реальный CGNAT-ISP) в `selectVpnIPv4` (vpn-bind.ts:53-63), `checkVPNInterfaces` (vpn-detector.ts:129-146), `getLocalIP` (:190). Добавить `cast-server.ts` `lanAddress()` (85-96) + вызовы web-remote.ts:45/91 — иначе cast/QR-URL рекламит недостижимый vIP.

**Ключевые should-fix (вплетены ниже):** метрику-1 заменить на per-destination on-link маршруты (иначе перехват собственного LSD transmission); Phase 0 спайк — планка «sustained RX/TX под нагрузкой» + бюджет добавленной p99-латентности (2 process-hop + JS event-loop hop на пакет); честный UX для symmetric-NAT пар (точка `connectionState` + терминальное состояние «direct failed — добавь TURN»); control-канал — через тот же named pipe (нет TCP-порта → нет TOCTOU на время UAC); startup orphan-sweep (крэш обоих процессов оставляет metric/firewall); роутинг vIP→memberId с резолвом канала В МОМЕНТ отправки (никогда не кэшировать RTCDataChannel/LanPeer — не стабильны через reap); host-подписанный `lan-evict` + семантика ухода хоста.

## 0.2 Стабильные vIP: переиспользование sessionId + watermark (добавлено позже)

Дополняет §0.1, ничего в нём не отменяя. Читать вместе с п.1 и п.7.

Комната **переиспользует свой sessionId между запусками** — от него деривятся и
подсеть, и vIP каждого участника (`sessionSubnet`/`deriveVip`), так что свежий id
каждый вечер означал новые адреса каждый вечер. Но id — ещё и граница
безопасности: гейт по sessionId в `applyAdmit` работает только потому, что флоры
анти-реплея в новом ядре пустые. Переиспользование с пустыми флорами = любой
участник комнаты переброадкастит прошлонедельный `lan-admit` и вводит в сессию
того, кого сегодня не звали.

**Инвариант.** Переиспользовать sessionId разрешено ТОЛЬКО вместе с персистентным
watermark'ом (`LanRoomPrefs.session.floor`, `LanSessionCore` floorSeed):

1. Watermark — максимальный `at` среди применённых `lan-admit`/`lan-evict`. Одного
   скаляра хватает, потому что оба типа применяются лишь при `by === hostId`, а
   ключ флора — target: все значения из ОДНИХ часов, хостовых.
2. Засевается **только** admit/evict. `lan-state`/`lan-reach` несут часы своего
   отправителя — засев их хостовым числом отверг бы легитимного участника с
   отстающими часами. Оба транзиентны и ничего не выдают.
3. Хост засевает своим watermark'ом ещё и `nextAt()`, поэтому его сегодняшние
   гранты перекрывают флор у всех пиров даже если его часы ушли назад.
4. Watermark нужен и **пассивному** ядру джойнера (движок строит его прямо из
   госсипа до Accept) — отсюда `lanSession`/`lanFloor` в payload'е `join`, а не
   только в `lanStart`.
5. Чужую сессию watermark не перезаписывает (даунгрейд-атака); усвоение —
   только в пустой слот. Смена сессии — всегда явное действие (Start/Accept).
6. **Evict ротирует sessionId**, а не полагается на watermark: `evicted` —
   sticky-множество в памяти, и переиспользование id понизило бы «терминально для
   сессии» до «терминально до перезапуска». Цена — адреса меняются после удаления
   участника.

## 1. Архитектура процессов (итог)

```
┌─ main (asInvoker) ───────────────────────────────────────────┐
│  LanManager (electron/sharing/lan-manager.ts)                │
│   • спавнит helper через Start-Process -Verb RunAs (1 UAC)   │
│   • lifecycle/teardown/orphan-sweep, НЕ на пути пакетов      │
│   • room-cmd 'lanStart'/'lanStop' → engine-окно             │
└──────────────┬───────────────────────────────┬──────────────┘
   спавн (RunAs)│                    room-cmd IPC│
┌──────────────▼───────────┐      ┌─────────────▼──────────────┐
│ havvn-lan-helper (admin)  │      │ room-engine window (renderer)│
│  Havvn.exe --lan-helper   │      │  LanSession (room-lan.ts)   │
│  • Wintun adapter+ring    │◄────►│   • LanPeer mesh (клон       │
│  • IP/route/MTU/metric/fw │ ACL'd│     MediaPeer): RTCPeerConn +│
│  • ТРИВИАЛЕН: ring↔pipe,   │ named│     createDataChannel('lan',│
│    zero parsing           │ pipe │     {ordered:false,          │
│  • PID-watchdog за main    │ raw  │      maxRetransmits:0})      │
└───────────────────────────┘frames│   • РОУТИНГ-МОЗГ: classify,  │
                                    │     routing table, broadcast│
                                    │     replicate, budget, drop │
                                    │   • lan-signal/lan-state     │
                                    │     signed gossip            │
                                    └─────────────────────────────┘
```

**Ключевой принцип разделения (без спагетти + безопасность):**
- **helper тривиален** — только Wintun ring ↔ ACL'd named pipe, length-prefixed сырые кадры, НОЛЬ протокольной логики. Минимальная attack surface для процесса под админом.
- **engine-окно — роутинг-мозг** — вся логика (классификация пакета, таблица маршрутов vIP→peer, репликация broadcast, budget/drop, self-origin drop). Живёт там, где data-channel'ы. Чистая логика вынесена в `shared/` под юнит-тесты.
- **main — только оркестрация** — спавн helper, UAC-момент, teardown. Никогда не на пути пакета.

### 1.1 Мост helper↔engine: named pipe, НЕ loopback UDP

Разведка выявила конфликт: loopback UDP нельзя ACL'ить → любой локальный процесс, узнав порт, инжектит сырые IP-пакеты в туннель под админом. **Решение: named pipe** (`\\.\pipe\havvn-lan-<token>`), DACL только на текущего пользователя.
- helper (elevated) = pipe-сервер, ставит security descriptor на текущего юзера.
- engine-окно = клиент (`net.connect`, доступен — preload `sandbox:false` = полный Node; подтверждено, хотя `net`/`dgram` в engine-окне сегодня не используются — это новая, но выполнимая плумбинг).
- Первые байты = token-handshake (belt-and-suspenders поверх ACL).
- Кадры: `[uint16 len][raw IP packet]`. Никакого JSON на пути пакета, никакого per-packet log().
- main НЕ на пути пакета (per-packet structured-clone IPC через main — явно отвергнут: джанк + оверхед).

## 2. Транспорт: LanSession mesh

Новый файл `electron/sharing/room-lan.ts`, клон `VoiceSession`/`MediaPeer` (room-voice.ts:237-320, 612+) МИНУС всё медиа:

- `LanPeer` = один `RTCPeerConnection({iceServers: room.iceServers})` + `pc.createDataChannel('lan', {negotiated:true, id:0, ordered:false, maxRetransmits:0})` **на обеих сторонах** (§0.1 п.4 — НЕ дефолтный in-band канал). Перфект-негошиэйшн как в голосе (polite = `selfId > memberId`, glare-split) рулит только SDP/SCTP m-line; `pendingIce` буфер (cap 64) — сигналинг приходит расстроенным флудом.
- `LanSession.peers = Map<memberId, LanPeer>`, `dropPeer`/`onPeerFailed` — паттерн голоса. **НО `ensurePeer`/`onPeerState`/`onSignal` — НЕ копия голоса (§0.1 п.1): admission-гейт.** `admittedSet` из host-подписанного `lan-admit`; `ensurePeer` отказывает не-admitted; `lan-signal` от не-admitted дропается ДО `ensurePeer`. Тест: rostered-but-unadmitted не может форсить `LanPeer`/канал.
- `LanAdapter` (как `VoiceAdapter`): `selfId, iceServers, sendSignal→signed 'lan-signal', announce→signed 'lan-state', onChange→pushState, sendPacket, onPacket`.
- Кап **MAX_LAN_PEERS = 8** (мировая mesh-масштабируемость; зеркалить в renderer как `VOICE_MESH_LIMIT` на RoomsPage.tsx:41).
- `binaryType='arraybuffer'`; `onmessage` → роутер (§4). Бэкпрешер: политика **DROP** (не queue) при `bufferedAmount > ~64-256KiB` (не reliable-with-lag; для игр дроп семантически верен). Прецедент бинарного send+backpressure: remote-cast-engine.ts `streamTo` (16KB chunks, HIGH_WATER 8MB).

**Не трогать gossip-wires** (`room.wires`, simple-peer, один reliable/ordered канал от bittorrent-tracker) — они пересоздаются на rekey; LAN нужен свой per-peer PC.

## 3. Протокол: новые подписанные gossip-типы

Расширить `Msg` union (room-engine.ts:103-204), `RELAYABLE` (74), `clampGossip` (~1709), switch (~1873), канонизаторы (~1281):

| Тип | Аналог | Назначение |
|-----|--------|-----------|
| `lan-genesis` | пиннинг ownerId | **НОВЫЙ (§0.1 п.7):** hostId = memberId создателя, подпись над `sessionId`. First-writer-wins per sessionId; поздний genesis с другим host — reject. Даёт запиннутый корень доверия для `lan-admit`. |
| `lan-state` | `voice-state` | Присутствие + заявка vIP (memberId, sessionId, vip, gen, at, pub, sig). Broadcast по комнате (дискаверимость). **vIP на приёме верифицировать против `deriveVip(sessionId,memberId,gen)`, §0.1 п.6.** JOIN требует явного admission. |
| `lan-signal` | `voice-signal` | Таргетированный offer/answer/ice для LanPeer PC (`to`, kind, data, pub, sig). Транзиентный → bind `room.topic` ок. |
| `lan-admit` | `e2eCfg` (re-mintable!) | host-подписанный допуск memberId (`by === session.hostId`, верифицируется против запиннутого genesis). **Durable → ре-минтить в `applyLocalRekey`, §0.1 п.2.** |
| `lan-evict` | `lan-admit` инверсия | **НОВЫЙ (should-fix):** host-подписанное выселение из сессии (`by === hostId`) → освобождает vIP/route у всех. Плюс семантика ухода хоста (сессия кончается / детерминированная преемственность). |

**Инварианты (адверсариал по комнатам это HIGH-ищет):**
- Каждый — свой domain-tagged канонизатор `lanXxxCanonical(topic, m) = Buffer(JSON([type, topic, ...fields]))`, подпись `signBytes`, проверка `verifySignedBy` (даёт memberId↔pubkey + TOFU бесплатно).
- **Свой** anti-replay floor per-type (монотонный `at`, FIFO-cap 512). НИКОГДА не шарить floor между типами (задокументированный HIGH из памяти).
- **Никогда** не расширять существующий канонизатор полем — ломает подпись у старых пиров (урок `deafened`).
- Клампить ВСЕ новые поля в `clampGossip` (in-place → relayed-копия тоже bounded; это анти-DoS, не гигиена).
- Поле отправителя = `memberId` (ban-gate матчит только его).
- Bind `room.topic`, читается в момент вызова → **переживает rekey** (дочитка 4 подтвердила: топик ротируется на kick, но голос выживает без переподписи — сигналинг транзиентный, presence переанонсится на hello). Хук: `room.lan?.reannounce()` рядом с `room.voice.reannounce()` (room-engine.ts:1925).

## 4. Адресация + роутинг + broadcast (killer-часть)

Чистая логика → `shared/lan-ip.ts`, `shared/lan-packet.ts`, `shared/lan-router.ts` (+ sibling `.test.ts`), инвариант shared/ = ноль импортов electron.

**vIP-деривация:** сессия получает /16 внутри 100.64/10 (детерминированно `HMAC(roomKey, 'th-lan-subnet:v1'|sessionId)` → `100.<64..127>.0.0/16`). Host-часть (16 бит) = `sha256(sessionId|memberId)` low16, reserved 0/65535 исключить. Коллизии ~0.1% на 8 пиров.
- **Новый HMAC-label** от room key (`'th-lan:v1'`) — НЕ трогать замороженные SALT/topicHash.
- **Арбитраж коллизий (приёмник, не только заявитель):** владелец спорного vIP = тот, чей `(memberId,gen)` его деривит; tie-break младший memberId; **одинаково на каждом приёмнике** → таблица сходится независимо от порядка флуда. Проигравший бампит `gen` и передеривит, переанонс через `lan-state`. Авторитет — **сессия**, не комната (минченные identity могут грайндить коллизии).
- OnLinkPrefixLength = 16, broadcast = subnet | 0.0.255.255.
- **Per-session scoping (§0.1 п.5):** субнет/адаптер/firewall-alias/sweep-scope — по `sessionId`. Бета: инвариант «одна активная LAN-сессия» (LanManager, Start в других комнатах greyed-out).

**Роутер (engine-окно, из pipe-RX кадра):**
1. Парс dst (валидация: IPv4 sanity, src == назначенный vIP отправителя, len ≤ MTU) — `shared/lan-packet.ts`, стиль profile.ts (хостильные заголовки без декода).
2. Unicast → таблица `vIP→memberId` (из верифицированных `lan-state`) → `peers.get(memberId)?.channel()` **в момент отправки** (§0.1 should-fix: НИКОГДА не кэшировать RTCDataChannel/LanPeer — не стабильны через `onPeerFailed`-reap; stale-open ссылка молча чёрно-дырит). Тест реконнекта: трафик к vIP возобновляется после failed→rebuilt.
3. Broadcast/multicast (`255.255.255.255`, subnet-broadcast, `224.0.0.251:5353` mDNS, `239.255.255.250:1900` SSDP, escape-hatch `224.0.0.0/4`) → **реплика всем пирам сессии**.
4. **self-origin drop** (реплицированный broadcast нашего же пакета не должен вернуться в TUN — как seenGids/dropSelfWire).
5. **Per-peer token-bucket** (pps + bytes/s), дроп при пустом bucket или высоком bufferedAmount. НОВЫЙ механизм (в коде нет inbound rate-limiter). Плумбинг конфигурации — по паттерну `setLimits` (handlers.ts:678 → RoomManager → room-cmd → engine), но лимитер свой.

## 5. Elevated helper (Windows plumbing)

Файлы: `electron/lan/helper-main.ts` (entry elevated-процесса), `electron/lan/helper-supervisor.ts` (main-сторона, по шаблону transmission-sidecar.ts).

**Запуск (дочитка 1 — verified):** перезапуск `Havvn.exe --lan-helper` через `Start-Process -Verb RunAs`. Патч из 3 точек:
- `electron/app-instance.ts` (top, до электрон-store side-effects): `export const isLanHelper = argv.includes('--lan-helper')`; при true — редирект userData (`-lan-helper` суффикс, как TH_INSTANCE) + SKIP `migrateLegacyProfile()`.
- `main.ts:130` — bypass `requestSingleInstanceLock()` для isLanHelper (иначе helper само-убьётся на `app.quit()`); guard second-instance handler (134) и protocol registration (165-174).
- `main.ts:1081` — `app.whenReady().then(isLanHelper ? runLanHelper : initializeApp)`.
- Работает для NSIS И portable-zip (zip = обычный win-unpacked, `process.execPath` стабилен). Кавычить путь (пробелы/кириллица), в dev передавать app-path доп. argv.

**Всё в ОДНОМ elevated-вызове = 1 UAC:** create adapter → IP+on-link route (`CreateUnicastIpAddressEntry`/`New-NetIPAddress`) → MTU 1280 (`Set-NetIPInterface -NlMtuBytes`) → **per-destination on-link маршруты для форвардимых групп** (`255.255.255.255/32`, `224.0.0.251`, `239.255.255.250`) с обычной метрикой — **НЕ blanket InterfaceMetric 1** (should-fix: метрика-1 делает адаптер lowest для ВСЕГО unbound broadcast/multicast → перехватывает собственный LSD transmission, LSD default-ON, native-manager.ts:190; документировать LSD-взаимодействие в §7) → firewall → запуск pump. UAC cancel = exit 1223.

**Firewall (решение — рекомендация):** адаптер поднимается «Unidentified» = Public (блокирует входящий игровой трафик). **Public + scoped allow-rules** (`New-NetFirewallRule -InterfaceAlias 'Havvn LAN' -RemoteAddress 100.64.0.0/10`) — держит адаптер вне реальных зон юзера, открывает только виртуальный трафик. Реверт на session end. *(Альтернатива Private = проще, но шире экспозиция; выбираю Public+rules как безопаснее.)*

**Имя адаптера = `Havvn LAN-<sessionId>`** — security-релевантно: НЕ должно содержать `vpn/tun/tap/wg/ppp+digit/ipsec/l2tp` (см. §7); scope per-session (§0.1 п.5). VPN-исключение всё равно по диапазону адресов, не по имени (§0.1 п.8).

**Хендшейк (дочитка 3 + §0.1 п.3, RunAs-совместимый):** RunAs НЕ наследует stdio/env, НЕ даёт kill сверху-вниз, И запускается под ДРУГИМ SID при over-the-shoulder UAC. Значит:
- **main захватывает SID интерактивного юзера + АБСОЛЮТНЫЙ путь handshake-файла + свой PID → передаёт helper через argv** (не полагаться на `getPath('userData')` helper'а — это профиль админа). Секрет-token лежит в файле по этому абсолютному пути. Убрать `-lan-helper` userData-редирект.
- Порты/token/pipe: helper DACL'ит named pipe на **переданный SID интерактивного юзера** (не на свой). Token в 0o600 файле (паттерн `writeSettings`), НЕ в argv.
- **Control-канал — через тот же named pipe**, НЕ отдельный TCP-порт (should-fix: `getFreePorts` bind→close→rebind gap теперь растягивается на весь UAC-промпт = TOCTOU; pipe уже выбран как транспорт данных → нет порта → нет гонки).
- Readiness: polling control-канала по pipe (паттерн `waitForRpc`, 250ms/20s) + pid-file liveness (нет child.exitCode).
- Shutdown: control-verb + **helper-side PID-watchdog за main** (`OpenProcess(SYNCHRONIZE)` по переданному PID из handshake-файла, exit при сигнале; НЕ `process.kill(pid,0)`-polling) — `child.kill()`/taskkill сверху НЕ работают (Access Denied medium→high IL).
- **Идемпотентный orphan-sweep — на enable И на app-startup** (should-fix: крэш ОБОИХ процессов оставляет metric/firewall/адаптер): detect leftover по имени-префиксу `Havvn LAN-*` + firewall-правила по префиксу. Non-elevated детект на старте → отложенное/промпт-элевейтед удаление (снос требует админа). Fail-fast: `runLanHelper` ассертит High-IL (чистая ошибка vs half-init).

## 6. Крипто-слой (решение — рекомендация)

Новый data-channel несёт **только DTLS** (room-gossip AES-GCM — per-message ручной, голосовое медиа — DTLS-SRTP only). **Рекомендация: DTLS-only для беты**, членство гейтится подписанным admission (`lan-admit`).
- Криптографически корректно: сигналинг Ed25519-подписан → DTLS-фингерпринты аутентифицированы; не-участник сессии физически не имеет LanPeer PC. Room-key слой не добавил бы защиты сверх этого.
- Прецедент: голосовое медиа уже DTLS-only.
- *Опция на потом (Phase 2, если маркетинг E2E-комнат потребует):* бинарный per-packet AES-GCM с новым HMAC-label от room key. Не в бете.

## 7. Интеграция с kill-switch / lifecycle (критично — фатальная петля)

**Исключение адаптера из VPN-детекта (дочитка 2 + §0.1 п.8 — mandatory, по ДИАПАЗОНУ):**
- Исключать по **диапазону адресов**, НЕ name+LUID: `os.networkInterfaces()` даёт только `{family,address,internal}` по имени — LUID недоступен без FFI (не используется), а матч по имени хрупок (юзер переименует). Исключать по session /16 внутри 100.64/10 (именно /16 сессии, не весь /10 — не проглотить реальный CGNAT-ISP).
- `shared/vpn-bind.ts` `selectVpnIPv4` (53-63) — пропускать адрес в исключённом диапазоне. Обновить vpn-bind.test.ts.
- `electron/utils/vpn-detector.ts` `checkVPNInterfaces` (129-146) — СЕЙЧАС итерит `VPN_IFACE_PATTERNS` напрямую (структурный gap) → добавить проверку диапазона; `getLocalIP` (190) — тоже (косметика).
- **`cast-server.ts` `lanAddress()` (85-96) + вызовы web-remote.ts:45/91** — тот же фильтр диапазона (иначе cast/QR-URL рекламит недостижимый vIP). План раньше этот touchpoint пропускал.
- НЕ добавлять CGNAT/100.64-эвристику в `checkVPNRoutes` без исключения; НЕ регистрировать DNS на адаптере в 10./172.16-31./192.168.
- Без этого: включение LAN → «VPN активен» (одна перевёрнутая индикатора при базовом vpnDNS=1 от домашнего роутера) → `suspendNetworking()` → mesh умирает → LAN-сессия умирает. Обратная маскировка: реальный VPN упал, адаптер считается VPN → kill-switch не срабатывает → real-IP leak.

**Teardown-хуки (дочитка 7 — все пути):**
- Нормальный quit: НЕТ will-quit; единственный хук — `cleanup()` (main.ts:1119, за shutdownGlobalPtt 1126, до RoomManager.destroy 1173). Бюджет 5s — LAN-шаг ≤1-2s.
- Крэш engine-окна: `render-process-gone` (room-manager.ts:363, рядом с cache.clear) → terminate session + revert helper.
- VPN suspend: `suspendNetworking` (room-manager.ts:1122, после networkSuspended=true). `resumeNetworking` НЕ авто-рестартит (членство явное). LAN-start проверяет `networkSuspended` (как reactivate).
- `RoomManager.destroy()` (1163) — вторая сеть под нормальный quit.
- applyLocalRekey (~2855): (a) `room.lan?.onMemberGone(kickedId)` — закрыть канал, освободить vIP/route, стоп-форвардинг (иначе адрес сквоттится / black-hole); (b) **ре-минтить живые `lan-admit` под новым топиком** (§0.1 п.2, как e2eCfg/tombSigs на 2864-2900) — иначе допущенные игроки молча дропаются у late-joiner/reconnect. Транзиентное (`lan-signal`/`lan-state`) переживает само (переанонс на hello). Интеграц-тест: admissions переживают `applyLocalRekey`.

## 8. UI + i18n

**RoomState.lan (дочитка 8 — verified wholesale):** добавить поле в `RoomState` (shared/types.ts) + `buildState()` (room-engine.ts:635) → долетает до renderer автоматически (`room-update` → cache → `rooms:update` без merge; RoomState НЕ персистится → stale-сессия не выживает рестарт). **НО** списочные бейджи (RoomsPage.tsx:176-178, RoomManager.list 615) строятся по-полю — `lan` в RoomSummary добавить явно в обоих местах. Отдельный `lan:update` канал НЕ нужен (electron-build map ошибся).

**Компоненты (renderer/pages/RoomsPage.tsx):**
- `RoomLanPanel` (сиблинг `RoomVoicePanel` :2008) в `.room-col-rail` между голосом и людьми: заголовок + BETA-пилюля + шестерёнка; action-row (Start/Stop); per-peer тайлы (`.room-voice-person`) со статус-точкой (`.room-voice-quality`, `--radius-full`) + mono-строка vIP + copy-IP. Popover — один раз под рядом (`.room-voice-pop`, рейл overflow:hidden).
- `LanPeerPicker` modal (клон `ScreenSourcePicker`, ScreenShare.tsx:26): `Modal size=lg` портал в body (escape container-query), чекбокс-список room.members, footer с elevation-notice (как withAudio opt-in) + confirm через `useConfirm`.
- LAN-чип в `.room-detail-badges` (:1828) — точка входа при свёрнутом рейле (не опция!).

**Тема:** только токены из `shared/theme.ts` TOKEN_NAMES; никаких хардкод border-radius (`--radius-*` от `--radius-scale`, 0 дефолт); `--radius-full` только для точек; mono-readout из hud.css для vIP.

**i18n (двухсловарь):** ключи `rooms.lan.*` в en.json И ru.json одним коммитом (typecheck ловит только en; ru молча фолбэчит). Main-dict (electron/i18n) только если OS-поверхности (native elevation-failed dialog, tray). Никогда не редактировать исходники через PowerShell (BOM-less UTF-8 мохибейк — память).

## 9. Тесты (дочитка testing-ci)

- **Pure-logic (shared/, vitest автоподхват):** `lan-ip.test.ts` (vIP-деривация, 100.64/10 математика, коллизии/арбитраж — стиль ip-range.test.ts), `lan-packet.test.ts` (парс IPv4/UDP заголовков, хостильные байты — стиль profile.ts анти-пиксель-бомба), `lan-router.test.ts` (broadcast-классификация, self-origin drop, routing-lookup, budget).
- **State machine:** `room-lan.test.ts` через инжектнутый fake `LanAdapter` (как room-voice.test.ts — replay-reject, roster-cap; НЕ вызывать join → без RTCPeerConnection).
- **Интеграция:** `makeEngine/FakePeer` харнесс (копия room-liveness.test.ts): 2-3 реальных engine-инстанса (vi.resetModules + vi.doMock('electron') + dynamic import), проверять lan-state/lan-signal/lan-admit конвергенцию, декриптуя кадры реальным room-crypto.
- **Spike:** `electron/lan/spike-harness.ts` + `npm run spike:lan` (standalone Node CLI, как spike:engine) — создать адаптер (UAC), assign 100.64, loop ring→classifier→ring, verdict.
- **Manual:** расширить docs/testing-rooms.md двухинстансовым чеклистом (TH_INSTANCE: peer2 в сессии, детерминированные 100.64.x.y, ping через туннель, UDP-broadcast инструмент видит второй инстанс).
- **CI:** БЕЗ изменений (windows-latest уже; DLL ленивый; ни один vitest не трогает драйвер). Драйвер-смок — только advisory job за env-флагом, никогда в required-гейтах.

## 10. Упаковка (дочитка electron-build)

- Зависимость **koffi** (FFI, живой; ffi-napi мёртв) → `build.asarUnpack` (как uiohook-napi); грузить защитно try/catch (паттерн global-ptt.ts `getModule()`) → «LAN unavailable» вместо краша.
- **wintun.dll** через `build.extraResources` `{from:'vendor/wintun/win32-x64', to:'wintun'}` — НИКОГДА в asar (LoadLibraryEx нужен реальный путь). Резолв двухветочный (env.ts:48-52): packaged `process.resourcesPath/wintun/wintun.dll`, dev `app.getAppPath()/vendor/...`.
- `scripts/fetch-wintun.mjs` (клон fetch-transmission.mjs).
- **Лицензия — GREEN (verified):** prebuilt signed wintun.dll под WireGuard «Prebuilt Binaries License» (НЕ GPL), §3.d разрешает редистрибуцию «alongside software using it only via wintun.h API» — закрытое бесплатное приложение подходит. Условия: (1) DLL байт-в-байт без модификации — исключить из code-signing pass и из asar; (2) сохранить notices, добавить PBL-текст в third-party licenses; (3) без промо-использования имён WireGuard/Wintun.
- `requestedExecutionLevel` остаётся `asInvoker` (UAC даёт RunAs, не манифест).
- release.yml: бампить package.json version + CHANGELOG.md перед тегом (хард-фейл иначе).

## 11. Фазировка

**Phase 0 — Spike (де-риск, ~дни).** Отдельный модуль `electron/lan/helper-wintun.ts` (koffi↔Wintun — в репо НОЛЬ FFI-прецедента, поверхность немаленькая: adapter lifecycle, StartSession, allocate/send/receive/release ring, blocking receive-handle, struct/pointer marshalling, wraparound, error-mapping; бюджетить в днях, не строкой-зависимостью). Планка спайка — НЕ «ping loopback», а **sustained RX/TX pump под нагрузкой** + **измерить добавленную p99-латентность** сквозь helper→pipe→JS-event-loop→DataChannel (2 process-hop + event-loop hop на пакет vs один нативный процесс у ZeroTier; `backgroundThrottling:false` не убирает GC/loop-jitter). Целевой порог added-p99 задать ДО коммита «роутинг-мозг в renderer»; заранее держать фолбэк (перенести classify/route в helper). Снимает ДВА главных риска (драйвер+элевация) + третий (латентность split'а). VM/вторая машина.

**Phase 1 — MVP beta (Windows, играбельно).** helper + named-pipe мост; LanSession mesh + lan-канал; протокол lan-state/lan-signal/lan-admit; детерминированный vIP + арбитраж; broadcast/mDNS/SSDP форвардинг + self-origin drop; Public+scoped firewall; metric 1; VPN-исключение; ВСЕ teardown-хуки + orphan-sweep + PID-watchdog; RoomLanPanel + picker + чип; i18n; per-peer budget; shared/ юнит + интеграция + spike. DTLS-only.

**Phase 2 — Hardening.** per-peer link-quality точки (getStats, паттерн M19); firewall-troubleshooter + «разрешить эту игру» в один клик; диагностика связности; **peer-relay** для непробитых пар (сейчас нет линка, как у голоса); подписанный `havvn-lan-helper.exe` (чистый UAC-неймінг вместо generic powershell); опциональный per-packet AES-GCM для E2E-комнат.

**Phase 3 — Polish/expand.** per-title пресеты; escape-hatch 224.0.0.0/4 в UI; macOS (utun)/Linux (tun); персист последних peer-picks; метрики на тайлах.

## 12. Открытые продуктовые развилки (мои рекомендации, можно оспорить)

1. **Firewall:** Public+scoped-rules (рекоменд., безопаснее) vs Private (проще). → Public+rules.
2. **Крипто:** DTLS-only+signed-admission (рекоменд. для беты) vs per-packet AES-GCM. → DTLS-only, AES-GCM в Phase 2.
3. **Presence:** broadcast по комнате + explicit admission (рекоменд., дискаверимо+безопасно) vs полностью скрытая сессия. → broadcast presence, join по admission.
4. **Helper-упаковка:** relaunch `--lan-helper` (рекоменд., verified, ноль новых бинарей) vs отдельный exe. → relaunch в бете, подписанный exe в Phase 2 для UAC-UX.
5. **MTU:** 1280 фикс (рекоменд.) — 1360 из исходного решения убран (SCTP-фрагментация).
6. **Конкурентные сессии (§0.1 п.5):** бета — одна активная LAN-сессия глобально, Start в других комнатах greyed-out. N-адаптеров + session-tag кадров — Phase 2+.
7. **Symmetric-NAT UX:** бета честно — точка `connectionState` (без getStats) + терминальное состояние «direct failed — добавь TURN, relay позже», НЕ молчаливый таймаут. «Играбельно» с оговоркой на symmetric-NAT хвост до Phase 2 data-relay.

## 13. Главные риски (из ресёрча)

- Elevated-helper под админом = attack surface → держать тривиальным (только length-prefixed кадры, ноль логики), ACL'd pipe.
- SCTP-фрагментация >1192B + ~5% потерь в первые секунды после open (slow-start) → MTU 1280 + полагаться на natural retry игр.
- bufferedAmount растёт даже при maxRetransmits:0 → обязателен drop-порог (иначе «unreliable» деградирует в reliable-with-lag).
- Broadcast egress: Windows шлёт 255.255.255.255 в один интерфейс → metric 1 обязателен, реверт на end; крэш helper оставляет orphan metric/firewall → idempotent sweep.
- Антивирусы: торрент-приложение ставит сетевой адаптер → подписанный wintun.dll + (в идеале) подписанный инсталлер снижают, но закладывать в ожидания.
- Покрытие игр: L3 покроет broadcast/mDNS-дискавери (большинство). IPX/DirectPlay-L2 древности — вне; честно очертить + direct-IP fallback.
