# Проверка совместимости Dependabot — 18 сентября 2026

## Проверка упаковки Windows x64 — 21 сентября 2026

Production-сборка выполнена. В отдельном release/verification-20260921 созданы NSIS-установщик 3.0.6, portable ZIP, blockmap и latest.yml; старые release-артефакты сохранены. Публикация не выполнялась.

**Важное ограничение воспроизводимости:** обычная команда electron-builder остановилась при пересборке bufferutil: загрузка node-gyp завершилась UND_ERR_RES_CONTENT_LENGTH_MISMATCH. Артефакты собраны с CLI-параметром --config.npmRebuild=false, используя уже установленные бинарные модули. Настройка проекта/CI не изменена. Обычная сборка с чистой установкой и пересборкой зависимостей всё ещё требует повторной проверки при рабочей загрузке. Логи: node_modules/.cache/packaging-builder.log и packaging-builder-prebuilt.log.

Что подтверждено:

- ASAR содержит main/preload, torrent-host и production renderer. Присутствуют Transmission со всеми четырьмя необходимыми DLL, Wintun и его лицензия.
- Внутри упакованного Electron / Node 24.20.0 загрузились bufferutil, utf-8-validate, koffi, uiohook-napi, utp-native и node-datachannel. FFmpeg из app.asar.unpacked успешно выполнил -version. Это проверка загрузки модулей, не испытание Wintun-драйвера или глобального keyboard hook.
- scripts/smoke-packaged.cjs запускает именно собранный Havvn.exe, с отдельными временными профилями для native и webtorrent. Для обоих смонтировался React renderer, IPC вернул версию 3.0.6, правильный движок и пустой список загрузок; путь загрузок соответствует временному профилю. require/process не доступны в окне. Оба процесса штатно закрылись через интерфейс. Исходники workspace не подгружаются в проверяемый бинарник. Bootstrap на dev Electron используется только для подготовки профиля.
- В первой версии smoke-теста закрытие страницы уничтожало CDP-соединение раньше ответа и давало ложный таймаут. Скрипт исправлен: завершение проверяется по выходу процесса. Повторный результат ok: true для обоих движков, node_modules/.cache/packaged-smoke.json.
- Portable ZIP прошёл 7-Zip test без ошибок. Встроенный архив NSIS также прошёл тест, но 7-Zip сообщил There are data after the end of archive (397016 байт после найденного 7z payload). Это проверка содержимого, а не выполнения всех шагов инсталлятора.
- SHA-512 и размер установщика совпадают с latest.yml. Подпись Windows: NotSigned; сертификат не предоставлялся. Хэши сохранены в node_modules/.cache/packaging-artifacts.json.

Исправлены два дефекта build/installer.nsh: uninstaller удаляет общий magnet handler только если команда по-прежнему указывает на Havvn в этом INSTDIR; добавлен Havvn.magnet ProgID, на который ссылался Capabilities/URLAssociations. Исправленный NSIS успешно скомпилирован. Поведение регистрации/удаления на реальной Windows отдельно не выполнялось.

Полный цикл установки, обновления поверх старой версии и удаления **не проверен**: он меняет реестр, ярлыки и ассоциации текущей Windows. Для этого нужна одноразовая VM/Windows Sandbox. Также не проверены реальные загрузки в собранном пакете, физический Chromecast, проброс на роутере, запуск/работа Wintun и подпись релиза. Локальные smoke tests эти сценарии не заменяют.

Артефакты:

- Havvn-Setup-3.0.6.exe: 167624813 bytes; SHA-256 8e71ea550e20bda398d1fcca1b31f7f2578a0519b5ed34c562968268c436749a
- Havvn-Setup-3.0.6.exe.blockmap: 175724 bytes; SHA-256 157f2524382106908f56e5f7e0e5e6bc02df31f985731a0c1a74cc77677e751f
- Havvn-3.0.6-win-portable.zip: 227313382 bytes; SHA-256 19507934c4c74e0bc8da51e48340e0fe2511023166611ec00eb761f7728161d8

В ходе проверки временно отказал сервис автоматического согласования из-за лимита использования; после возобновления нужный запуск был заново разрешён и выполнен. Невыполненных проверок из-за этого отказа не осталось.


## Инструменты и dev-запуск — 21 сентября 2026

- @types/node обновлён до 24.13.6, соответствующего основной версии Node внутри Electron 44. Ветка Dependabot с типами Node 26 не переносилась: типы должны описывать используемый runtime. Typecheck проходит без исправлений бинарных socket handlers. В chromium-webrtc удалено ручное приведение registerHooks: API теперь проверяется штатными типами.
- concurrently обновлён до 10.0.5. Его требование Node >=22 выполняется текущей средой и CI на Node 24.
- softprops/action-gh-release обновлён до v3; параметры draft, generate_release_notes и files сверены с [официальным action.yml](https://raw.githubusercontent.com/softprops/action-gh-release/v3/action.yml). Удалена устаревшая подсказка о CHANGELOG.md. YAML разобран локально; создание релиза на GitHub не запускалось.
- Dev-сервер привязан к localhost, лишний Access-Control-Allow-Origin: * удалён. Интерфейс и HMR используют тот же origin, доступ из LAN для обычной разработки не требуется.
- TypeScript 7 по-прежнему отложен: свежий npm view @typescript-eslint/parser@latest peerDependencies подтверждает ограничение TypeScript >=4.8.4 <6.1.0. Обход peer dependencies не применялся.

Добавлен scripts/smoke-development.cjs: после npm run build:electron он запускает настоящий npm run dev:renderer и Electron с настоящими main/preload/renderer через concurrently. Electron использует тестовый bootstrap с временным профилем, отключёнными DHT/LSD/UPnP и пустыми RSS/downloads. Это эквивалентная проверка компонентов dev-запуска, а не буквальный запуск npm run dev с пользовательским профилем. Конструктор окна и React работают; получен rendererReady, DOM смонтирован, getDownloads вернул [] через настоящий torrent-host. После проверки дочерние процессы остановлены. Отчёт: node_modules/.cache/development-smoke.json.

Первый холодный запуск исчерпал 120 секунд общего времени вместе с компиляцией. Лимит только smoke-скрипта увеличен до 240 секунд; HTTP ожидание компиляции больше не обрывается каждые 3 секунды. Повторный запуск прошёл (webpack компилировался около 15 секунд). Это не изменение таймаутов приложения и не измерение гарантированного времени запуска.

Итоговый полный прогон: **2018/2018 тестов проходят** (node_modules/.cache/tooling-tests.json). Typecheck и сборка Electron проходят. Свежий audit после обновлений: **0 известных уязвимостей** (node_modules/.cache/tooling-audit.json). Полноценная упаковка/установщик, реальные внешние сетевые сценарии и GitHub CI остаются непроверенными. Все изменения локальные, без push.


## Удаление последней уязвимой цепочки ip — 21 сентября 2026

Override ip 2.0.1 заменён на npm alias **npm:@webpod/ip@0.6.1**. Закреплён конкретный релиз, а не плавающий latest. Подмена не скрывает старый код: package-lock содержит новый пакет с его собственными resolved/integrity; старая node_modules/ip удалена. По сравнению с предыдущим lockfile изменились только эти записи. npm ls подтверждает замену в обоих потребителях — bittorrent-tracker и node-ssdp.

Основание выбора: [документация пакета @webpod/ip](https://www.npmjs.com/package/@webpod/ip). Проверены установленный код, CJS API и ESM-потребитель; заявленная совместимость не принималась без тестов. В текущих потребителях найдены вызовы address() и toString(), но не isPublic(): прежний audit отражал наличие уязвимой библиотеки, а не доказанную достижимость SSRF в этих двух местах.

Добавлены 36 проверок: private/loopback/link-local IPv4/IPv6, IPv4-mapped IPv6, отклонение неоднозначных octal/hex-форм, обычные публичные адреса, бинарное/числовое преобразование IPv4. Настоящий ESM-парсер UDP announce трекера проверен с явным IP и с IP отправителя. Настоящий SSDP Client формирует location с заменой библиотеки; discovery не запускается.

**npm audit: 0 известных уязвимостей** (node_modules/.cache/ip-migration-audit.json). Полный прогон: **2018/2018 тестов проходят** (node_modules/.cache/ip-migration-tests.json). Typecheck, сборка Electron и обе локальные интеграционные проверки WebTorrent/Chromium WebRTC проходят. Это результат текущей базы npm, а не утверждение об абсолютной безопасности приложения или fork.

Следующие этапы: согласовать Node types/concurrently/TypeScript с инструментами, обновить release action, проверить упаковку и физические сетевые сценарии, опубликовать изменения и проверить CI/Dependency Graph. Существующие ограничения UPnP, проверки URL/DNS и ручного тестирования не отменены нулевым audit. Изменения локальные, PR не объединены, push не выполнялся.


## Замена старого UPnP и XML-парсера — 21 сентября 2026

Прямой nat-upnp 1.1.1 и его @types удалены. Используется UPnP-подмодуль закреплённого @silentbot1/nat-api 0.4.9, уже присутствовавшего в дереве WebTorrent 3. Вызовы переведены на Promise API с динамическим ESM import; добавлены точные декларации используемого API. NAT-PMP fallback и обновление аренды по-прежнему контролирует приложение. Постоянные UPnP-аренды не включены. Старое дерево request, qs, tough-cookie и form-data 2.x удалено, временный override form-data больше не нужен.

Операции start/stop/продления сериализованы: stop во время создания mapping дожидается результата, удаляет правило и не оставляет таймер продления. Повторный start того же порта сохраняет один таймер; нецелые и выходящие за 1–65535 порты отклоняются с очисткой прежнего состояния.

Дополнительно устаревший xml2js в chromecast-api обновлён до 0.6.2 через ограниченный override. Основание: [GHSA-776f-qx25-q3cc](https://github.com/advisories/GHSA-776f-qx25-q3cc). Проверяется форма XML-описания устройства с теми же callback/options, что использует Chromecast, и отсутствие подмены прототипа через __proto__.

UPnP интеграционный тест использует настоящий клиент библиотеки и HTTP/SOAP/XML-код на loopback-эмуляторе роутера; только SSDP discovery заменён контролируемым объектом, конструктор с multicast-сокетами не вызывается. Проверяются TCP mapping с арендой 3600 секунд, external IP, unmapping, отказ роутера и запрет повторного использования уничтоженного клиента. Старые тесты multipart удалены вместе с единственным потребителем request. Полный итоговый прогон: **1982/1982 теста проходят** (node_modules/.cache/upnp-migration-tests.json). Typecheck, сборка Electron, локальная передача WebTorrent и запуск torrent-host/Chromium WebRTC проходят. npm ls не обнаружил некорректных прямых зависимостей.

Свежий аудит: **6 high, 0 moderate, 0 critical** вместо 12 находок до этапа. Все оставшиеся записи связаны с ip: сам пакет, bittorrent-tracker, torrent-discovery, webtorrent, node-ssdp и chromecast-api. Это шесть записей дерева, а не шесть независимо найденных проблем. Требуется отдельная замена ip/его потребителей; npm audit fix --force не применялся.

Ограничения: физический роутер, SSDP discovery в реальной сети, Chromecast и NAT-PMP с реальным шлюзом не проверялись. Таймаут ожидания SOAP не отменяет уже отправленный запрос; отказ удаления правила роутером остаётся best-effort с конечным временем аренды. Выбор шлюза NAT-PMP пока сохраняет прежнюю эвристику .1 и требует отдельной доработки. Изменения локальные, без push.


## Устранение critical в зависимостях — 21 сентября 2026

Добавлен override protobufjs на прямую зависимость проекта ($protobufjs): castv2 теперь действительно использует 8.8.0 вместо отдельной 6.11.6. Для form-data override ограничен версиями <2.5.6: request использует исправленную 2.5.6, а ветка 4.x сборочных инструментов не понижается. Lockfile пересчитан; install scripts не запускались. Для удаления устаревшего разрешения npm также выполнен dedupe.

Основания: [changelog protobufjs](https://github.com/protobufjs/protobuf.js/blob/master/CHANGELOG.md), [исправление multipart-инъекции form-data](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx). Это меры для известных находок аудита, а не доказательство отсутствия всех уязвимостей.

Добавлены проверки установленного castv2: точное бинарное представление сообщения, бинарный payload, вложенные сообщения аутентификации и отказ при обрезанном payload. Добавлены регрессионные проверки form-data из дерева request: экранирование имён полей/файлов и независимость boundary от Math.random. Физическое устройство Chromecast не использовалось. Полный прогон: **1977/1977 тестов проходят** (node_modules/.cache/security-20260921-tests.json). Typecheck, сборка Electron и обе интеграционные проверки WebTorrent/Chromium WebRTC проходят; npm ls не обнаружил некорректных зависимостей. Изменения локальные, без коммитов и push.

Свежий npm audit: **12 находок — 5 moderate, 7 high, 0 critical** (node_modules/.cache/security-20260921-audit.json). До изменений было 16, включая 3 critical. request остаётся уязвимым по другим причинам; nat-upnp и его старое HTTP/XML-дерево требуют дальнейшей замены. TypeScript 7, concurrently, Node types, release action и упаковка остаются отдельными незавершёнными пунктами.


## Миграция WebTorrent 3 — 20 сентября 2026

WebTorrent обновлён до **3.0.21**, типы — до 3.0.0. Глобальные overrides старых create-torrent/parse-torrent удалены: WebTorrent получает собственные совместимые зависимости. Прямой parse-torrent 9.1.5 сохранён для существующих синхронных CJS-потребителей. bittorrent-tracker теперь явная зависимость.

- Electron компилируется с NodeNext; динамические импорты сохраняются и используют корректные относительные .js-пути. Менеджер, создание торрентов, комнаты, раздача и remote cast загружают ESM асинхронно.
- torrent-host отправляет ready только после успешной инициализации. Ошибки загрузки движка больше не скрываются.
- Комнаты учитывают асинхронный get() и ещё не получившие infoHash торренты, предотвращая повторные add(). Отмена join и приостановка сети во время загрузки модулей не позволяют поздно восстановить соединение.
- Скрытые preload-окна используют contextIsolation: true для Node ESM loader ([документация Electron](https://www.electronjs.org/docs/latest/tutorial/esm)). Узкий Node resolve hook направляет webrtc-polyfill в его browser entry внутри renderer, сохраняя Chromium WebRTC. Utility process использует Node backend. node-datachannel включён в asarUnpack; его бинарный модуль собран отдельно.
- Автоматический NAT-PMP/UPnP WebTorrent отключён; управление пробросом портов остаётся за приложением.
- Вместо удалённого torrent.createServer() введён HTTP-сервер с прежними индексными URL, GET/HEAD, byte ranges и проверками Host/Origin. Он не выдаёт CORS-разрешения. Это защита loopback streaming, не токен-аутентификация локальных клиентов.
- Тесты паузы используют production helper очистки selections. Проверка частичной загрузки теперь требует отсутствия ложного done: WebTorrent 3 исправляет старое поведение. Проверка реальной остановки/возобновления потока сохранена. Helpers IPC в тестах комнат ожидают ответ по reqId вместо безусловных 25 timer ticks, которые приводили к таймаутам при нагрузке.

Повторяемые интеграционные проверки после npm run build:electron:

- node scripts/smoke-webtorrent.mjs — два настоящих локальных пира, seed/download, целостность файла, пауза/возобновление, Range и отклонение чужого Origin.
- node scripts/smoke-webtorrent-electron.cjs — временный профиль Electron, запуск utility torrent-host, RPC getDownloads, загрузка движка комнат и обмен данными двух Chromium WebRTC-пиров. Результат: node_modules/.cache/wt3-electron.json.

Обе проверки прошли. Typecheck и сборка Electron проходят; production-сборка также проверена в ходе миграции. Финальный полный прогон: **1972/1972 тестов проходят** (node_modules/.cache/wt3-final-tests.json).

Аудит установленного дерева: **16 уязвимостей (4 moderate, 9 high, 3 critical)** против 18 до миграции. Critical остаются в protobufjs под castv2 и form-data/request. Следующий этап безопасности — устранить эти цепочки с проверкой совместимости; принудительный npm audit fix не применялся.

Ограничения: установщик, полноценные пользовательские сценарии, внешние трекеры/пиры, Chromecast, NAT и голосовые звонки не проверены. Локальные smoke tests не заменяют эти проверки. Изменения не опубликованы. Разделы ниже описывают предыдущие этапы и исходное состояние.

## Миграция Electron 44

Electron обновлён до 44.3.0 в manifest и lockfile; официальный runtime установлен отдельно после npm install с отключёнными lifecycle scripts.

- `clipboard-watcher` ожидает Promise от `clipboard.readText()`. Счётчик поколений отменяет результаты остановленных/перезапущенных наблюдателей; параллельные чтения в одном цикле не запускаются. Три новых теста проверяют начальное чтение, дедупликацию, остановку во время чтения и запрет перекрытия опросов.
- Вместо удалённых `openAsHidden`/`wasOpenedAsHidden` автозапуск передаёт `--havvn-start-hidden`, который обрабатывается при создании окна. Реальная регистрация автозапуска и вход в Windows не проверялись.
- Из очистки хранилищ удалён неподдерживаемый `websql`; остальные перечисленные хранилища сохранены.
- Typecheck и полная сборка проходят. Тестовое скрытое окно с временным профилем запущено на Electron 44.3.0 / Node 24.20.0. `koffi`, `uiohook-napi`, `utp-native` загружаются; renderer с sandbox/contextIsolation и отключённым nodeIntegration загрузился, `process`/`require` в странице недоступны.
- Первый runtime-запуск внутри инструментальной песочницы завершился ошибкой GPU/ERR_FAILED; тот же тест вне её ограничений успешно завершился без отключения sandbox Electron.

Это runtime smoke test, не проверка полного приложения: не запускались глобальный keyboard hook, реальный uTP-трафик и пользовательские сценарии Havvn. Установщик, фактический автозапуск, Chromecast и WebTorrent 3 остаются отдельными этапами. Логи runtime: `node_modules/.cache/electron44-smoke.json`.

Финальный полный прогон: **1970/1970 тестов проходят** (`node_modules/.cache/electron44-tests-final.json`). Первоначально два теста E2E-комнат исчерпали 5-секундный лимит; в helper команд `room-e2e-adopt.test.ts` безусловное ожидание 25 timer ticks заменено ожиданием ответа с соответствующим reqId. Утверждения о поведении и общий timeout не менялись. Изменения не опубликованы.

## Совместное обновление зависимостей

В основной рабочий каталог применена группа из ранее проверенных PR #12, #15, #17, #21; лишний `@types/uuid` удалён. Обновлены одновременно:

- Runtime: `@fontsource/inter` 5.3.0, `@tanstack/react-virtual` 3.14.13, `chromecast-api` 0.4.2, `hls.js` 1.7.3, `dotenv` 17.4.2.
- Инструменты: `@types/d3-geo` 3.1.1, `electron-builder` 26.15.3, `html-webpack-plugin` 5.6.8, `ts-loader` 9.6.2, `webpack` 5.111.0, `css-loader` 7.1.5, `webpack-cli` 7.2.3.

`package-lock.json` пересчитан npm 11.16.0 на Node 24.18.1. Установка выполнена с `--ignore-scripts`, без принудительного разрешения конфликтов. `npm ls --depth=0` не обнаружил некорректных зависимостей. Electron остаётся 42.9.1, WebTorrent — 1.9.7, TypeScript — 5.9.3.

Совместные проверки: typecheck и полная production-сборка проходят; webpack-dev-server компилирует приложение и возвращает HTML с HTTP 200 на loopback. Проверены загрузка модуля Chromecast и сохранение приоритета существующих переменных окружения в dotenv. Реальный Chromecast/HLS, запуск Electron и установщик требуют отдельной проверки. В webpack остаются предупреждения о размере bundles; HLS chunk вырос примерно с 383 до 574 KiB.

Два полных прогона выявили нестабильность `room-watch-stream`: 1966/1967, один тест завершался около лимита 5 секунд; отдельно файл проходил (3/3). В helper `cmd` заменены 25 безусловных timer ticks на ожидание ответа с конкретным reqId. Общий timeout и проверки поведения не ослаблены; после правки три теста файла проходят примерно за 4.5 секунды суммарно вместо 10.7. CLI electron-builder также запускается и сообщает версию 26.15.3; это не проверка упаковки.

Актуальный npm audit исходного и обновлённого lockfile показывает одинаковые 18 уязвимых пакетов: 4 moderate, 11 high, 3 critical. Эта группа обновлений не устраняет уязвимые цепочки WebTorrent/Chromecast/UPnP. Сравнение выполнено по одной актуальной базе, а не со старым числом из переписки. Audit job теперь должен оставаться красным до устранения high/critical.

Финальный полный прогон после исправления ожидания: **1967/1967, без падений**. Локальные JSON-отчёты: `node_modules/.cache/dependency-group-tests-final.json` и `node_modules/.cache/dependency-group-audit.json`. Итоговые версии manifest/lockfile/установленных прямых зависимостей сверены автоматически.

Изменения локальные, PR не объединялись и push не выполнялся. Следующий этап — отдельная миграция Electron с runtime-проверкой, затем WebTorrent и устранение оставшихся уязвимых цепочек. TypeScript 7 по-прежнему блокируется несовместимыми peer dependencies.

## Выполненная доработка после проверки

Первый этап реализован локально, без коммитов, push и слияния PR:

- Общий модуль `shared/room-kdf.ts` определяет KDF одновременно для Node и браузера. Исторические приглашения из четырёх слов и четырёх цифр сохраняют 150000 итераций; новый формат использует 600000. Добавлены проверки ключа, rendezvous и расшифровки в обе стороны для обычных и E2E-комнат. Salt и домен подписей не менялись.
- Это восстанавливает исторический протокол. Промежуточная сборка, применявшая 600000 к старым приглашениям, несовместима с ним: участникам таких комнат требуется согласованное обновление. Автоматическое подключение к двум адресам трекера не реализовано. Созданные новым генератором приглашения сохраняют Node-ключ; браузер теперь использует тот же ключ.
- Устаревшие тесты переписаны под реальные exports validation/security. Исправлены проверка traversal до нормализации и принятие порта с посторонним суффиксом. Дополнительно запрещены null bytes в download path, компоненты пути в имени файла и локальные/link-local IPv6/IPv4 адреса в tracker URL. Проверка URL остаётся синтаксической: DNS rebinding и перенаправления требуют защиты на уровне сетевых запросов.
- CI использует Node 24. Обновлены checkout, upload-artifact, CodeQL, dependency-review; повторные npm audit/CodeQL удалены из второго workflow. npm audit теперь блокирует job при high/critical, а JSON загружается даже после ошибки.
- Release workflow больше не обращается к отсутствующему CHANGELOG.md: GitHub формирует release notes для черновика. Устаревшая команда `husky install` заменена на `husky`.
- Полный прогон: **1967/1967 тестов проходят**. `npm run typecheck` и `npm run build` проходят; YAML workflows успешно разбирается. Пересобран отслеживаемый `docs/room/guest.js`. Остались предупреждения webpack о размере основных bundles. Проверка в GitHub Actions требует публикации изменений.

Остаются: включение Dependency Graph в настройках GitHub, проверка CI на сервере, проверка упаковки и запуска приложения, Snyk/секреты и отдельные миграции зависимостей. PR Dependabot не объединялись. Ниже сохранены исходные результаты проверки до исправлений.

База: `main` / `a18d7dc2a7c77c56dd63abb395ffcfa24f284803`.
Проверены 15 открытых PR (#7–#21). Ветки не объединялись и не публиковались.

## Методика и ограничения

Для каждого npm PR подготовлена отдельная копия исходников main с package.json и package-lock.json соответствующей ветки. Выполнены `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck` и 81 тест из четырёх наборов: security, rate-limiter, port-forwarding, selections. Если установка не проходила, следующие проверки пропускались. Для обновлений сборочных инструментов дополнительно проверялась сборка renderer. Среда: Windows, Node 24.18.1, npm 11.16.0.

Полные тесты main сравнивались с группой обновлений #12. Проверены опубликованные результаты GitHub Actions и официальные манифесты обновляемых actions. Проверки каждой ветки независимы: совместная установка всех кандидатов не проверялась.

Lifecycle scripts в изолированных установках отключены. Запуск Electron, нативные модули, установщик, реальное скачивание торрентов, Chromecast и публикация релиза не проверены. Прохождение перечисленных проверок не означает отсутствие уязвимостей или полную совместимость во время работы приложения.

## Блокирующие изменения

- [#13 — @types/node 26](https://github.com/NIHILcoder/Havvn/pull/13): установка и 81 тест проходят, typecheck падает. В `electron/gameserver/modules/minecraft/slp.ts:132` и `electron/lan/pipe-spike.ts:34,57` аргумент `string | NonSharedBuffer` передаётся туда, где ожидаются байты. Сначала уточнить обработку входных данных и согласовать версию типов с Node внутри Electron.
- [#14 — WebTorrent 3](https://github.com/NIHILcoder/Havvn/pull/14): установка и 81 тест проходят, typecheck падает в `electron/torrent/manager.ts:153,1904,3729`. Замены версии недостаточно: требуется отдельная миграция загрузки ESM из CommonJS torrent-host, API и типов, а также проверка совместимости overrides `create-torrent`/`parse-torrent`. Успешные вспомогательные тесты не проверяют запуск нового движка.
- [#16 — Electron 44](https://github.com/NIHILcoder/Havvn/pull/16): установка и 81 тест проходят, typecheck падает с шестью ошибками. `clipboard.readText()` возвращает Promise, поэтому `.trim()` в `clipboard-watcher.ts:65,86` больше не подходит. Удалены `openAsHidden`, `wasOpenedAsHidden`, значение `websql` в списке очищаемых хранилищ. Нужно адаптировать обработчики, согласовать Node для установки и проверить нативные модули на новом Electron.
- [#18 — concurrently 10](https://github.com/NIHILcoder/Havvn/pull/18): установка, typecheck, 81 тест и запуск двух простых дочерних команд проходят на Node 24. Однако пакет требует Node >=22, а workflows проекта используют Node 18/20. Сначала согласовать поддерживаемую версию Node и проверить `npm run dev`.
- [#20 — TypeScript 7](https://github.com/NIHILcoder/Havvn/pull/20): `npm ci` падает с ERESOLVE. `@typescript-eslint/eslint-plugin@8.70.0` требует TypeScript `>=4.8.4 <6.1.0`. В CI также падает установка. Не обходить конфликт через `--force`/`--legacy-peer-deps`: сначала подобрать совместимый набор инструментов, затем мигрировать конфигурацию, включая `moduleResolution: node`, и проверить ts-loader.

## Кандидаты после исправления базовых проверок

- [#12 — группа девяти обновлений](https://github.com/NIHILcoder/Havvn/pull/12): установка, typecheck, 81 тест, renderer и guest сборки проходят. Полный прогон: 1955 тестов, 1923 успешных, 32 падения — те же тесты, что на main. Проверенная группа не добавила падений. Нужны ручные проверки Chromecast/HLS/виртуального списка и сборка установщика, поскольку меняются также chromecast-api и electron-builder. Название `security-updates` само по себе не доказывает, что все изменения исправляют уязвимости.
- [#15 — dotenv 17](https://github.com/NIHILcoder/Havvn/pull/15): установка, typecheck и 81 тест проходят. Отдельная проверка запуска с реальным окружением остаётся перед выпуском.
- [#17 — css-loader 7](https://github.com/NIHILcoder/Havvn/pull/17): установка, typecheck, 81 тест и production-сборка renderer проходят. Визуальная проверка интерфейса не выполнялась.
- [#19 — @types/uuid 11](https://github.com/NIHILcoder/Havvn/pull/19): установка, typecheck и 81 тест проходят. Это deprecated stub: установленный uuid уже содержит собственные типы. Предпочтительнее удалить лишний @types/uuid отдельным изменением и повторить typecheck.
- [#21 — webpack-cli 7](https://github.com/NIHILcoder/Havvn/pull/21): установка, typecheck, 81 тест и production-сборка renderer проходят на текущем webpack 5.104.1. Требуется Node >=20.9.0; существующий security-scan на Node 18 необходимо обновить. Запуск webpack-dev-server отдельно не проверялся.

## GitHub Actions

- [#7 — upload-artifact 7](https://github.com/NIHILcoder/Havvn/pull/7): используемые inputs поддерживаются; загрузка отчёта в Security Audit прошла на ветке PR. Обновление также заменяет оставшийся upload-artifact@v3. Нужно отдельно обеспечить загрузку audit-отчёта при ненулевом коде npm audit.
- [#8 — CodeQL 4](https://github.com/NIHILcoder/Havvn/pull/8): инициализация и анализ успешно отработали в двух security workflows. Эти workflows дублируют часть работы.
- [#9 — dependency-review-action 5](https://github.com/NIHILcoder/Havvn/pull/9): манифест совместим с используемой конфигурацией, но шаг не проходит: GitHub сообщает, что Dependency Review недоступен без включённого Dependency Graph. Настройку репозитория необходимо исправить и повторить CI; успешная работа действия пока не подтверждена.
- [#10 — action-gh-release 3](https://github.com/NIHILcoder/Havvn/pull/10): используемые inputs и `contents: write` соответствуют манифесту. Действие запускается по тегу, поэтому публикация не тестировалась. Сначала устранить существующее обращение release workflow к отсутствующему CHANGELOG.md.
- [#11 — checkout 7](https://github.com/NIHILcoder/Havvn/pull/11): checkout и typecheck в CI проходят. Последующее падение тестов само по себе не свидетельствует о регрессии checkout.

Проверенные actions используют собственный Node 24; это не обновляет Node проекта, задаваемый setup-node. Проект использует GitHub-hosted runners. Официальные манифесты: [checkout](https://github.com/actions/checkout/blob/v7/action.yml), [upload-artifact](https://github.com/actions/upload-artifact/blob/v7/action.yml), [dependency-review](https://github.com/actions/dependency-review-action/blob/v5/action.yml), [CodeQL](https://github.com/github/codeql-action/blob/v4/init/action.yml), [gh-release](https://github.com/softprops/action-gh-release/blob/v3/action.yml).

## Ошибки main, не вызванные этими PR

1. Полная сборка main проходит, но полный набор тестов уже имеет 32 падения. Тридцать относятся к устаревшему API в `electron/utils/validation.test.ts`.
2. Два теста `shared/room-web-crypto.test.ts` выявляют несовместимость браузерной и Node-криптографии комнат. В `shared/room-web-crypto.ts:14` используется 150000 итераций PBKDF2, в `electron/sharing/room-crypto.ts:79` — 600000. Не совпадают производные значения и межплатформенная расшифровка. Исправлять согласованно с протоколом и миграцией существующих комнат, а не только менять ожидания тестов.
3. `.github/workflows/release.yml` вызывает `scripts/changelog-section.js`, но CHANGELOG.md отсутствует. Это блокер подготовки release notes независимо от версии gh-release.
4. В security workflows смешаны Node 18/20, встречаются старые actions, дублирование проверок и `continue-on-error`. Зелёный Security Audit не равнозначен нулю уязвимостей.

## Порядок дальнейших действий

1. Исправить совместимость криптографии комнат и восстановить актуальные проверки validation; получить зелёный main.
2. Привести CI к согласованной поддерживаемой версии Node, устранить дублирование security workflows, включить Dependency Graph, восстановить подготовку release notes.
3. Обновлять прошедшие проверки зависимости небольшими группами с повторной проверкой итогового lockfile. Выполнить ручной запуск и проверку упаковки перед релизом.
4. Миграции Electron 44, WebTorrent 3 и TypeScript 7 вести отдельно с профильными runtime-проверками. Не объединять их автоматически вместе с остальными Dependabot PR.

Логи и результаты изолированных прогонов сохранены в `%TEMP%\havvn-dependabot-review-20260918`. Исходники приложения и файлы зависимостей основного рабочего каталога в ходе проверки не менялись.
