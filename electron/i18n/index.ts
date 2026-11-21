/**
 * Minimal main-process i18n.
 *
 * The renderer owns the full UI dictionary (renderer/i18n/*.json — ~900 keys,
 * lazy-loaded per language). That dictionary lives inside the webpack bundle and
 * is out of reach of the main process, which the electron tsconfig compiles
 * separately (renderer/ is excluded). This module therefore carries its own tiny
 * dictionary covering only the strings the OS renders itself and the React layer
 * can never touch: the tray menu, native file dialogs, and system notifications.
 *
 * Language source of truth stays in the renderer (persisted in localStorage).
 * The renderer mirrors it here over the 'app:setLanguage' IPC channel and into
 * the config store, so the first tray/menu build right after launch is already
 * in the correct language — before the renderer window has even loaded.
 *
 * NOTE: db/store is required LAZILY inside init/setMainLanguage (never at the top
 * level). Those run only in the main process; `t()` needs no store. This keeps
 * `import { t } from '../i18n'` side-effect-free, so pulling it in transitively
 * (e.g. utils → vpn-detector → i18n from the torrent-host utilityProcess) does
 * NOT drag in db/store, whose module-load calls app.getPath() and would crash a
 * process that has no Electron `app` (the host is a utilityProcess).
 */
export type MainLang = 'en' | 'ru';

type Dict = Record<string, string>;

const en: Dict = {
  'startup.failed.title': 'Cannot start Havvn',
  'startup.failed.message': 'Havvn could not finish starting',
  'startup.failed.detail': 'Restart Havvn. If the problem persists, open the application logs for details. Your downloads and rooms remain in your profile.',
  'startup.security.title': 'Cannot start Havvn',
  'startup.security.message': 'The system key store is unavailable',
  'startup.security.detail': 'Havvn needs the system key store to protect room keys and passwords. Sign in under your usual OS account and check access to the key store. Windows uses DPAPI, macOS uses Keychain, and Linux needs a working Secret Service (for example, libsecret with GNOME Keyring). Restart Havvn after restoring access.',
  'common.exit': 'Exit',
  "rooms.preflight.reason.ready": "The known prerequisites are satisfied.",
  "rooms.preflight.reason.capability-unknown": "This client has not advertised the required capability.",
  "rooms.preflight.reason.capability-missing": "This build does not advertise support for this action.",
  "rooms.preflight.reason.room-unavailable": "The room is not currently available.",
  "rooms.preflight.reason.removed": "You have been removed from this room.",
  "rooms.preflight.reason.suspended": "Networking is paused by protection.",
  "rooms.preflight.reason.engine-unavailable": "The room engine is not ready.",
  "rooms.preflight.reason.peer-unavailable": "The selected participant is no longer online.",
  "rooms.preflight.reason.owner-unknown": "The room owner has not been established yet.",
  "rooms.preflight.reason.owner-required": "Only the current owner or session host can perform this action.",
  "rooms.preflight.reason.lan-unavailable": "The local LAN driver is not available.",
  "rooms.preflight.reason.lan-busy": "Another room is using the LAN session.",
  "rooms.preflight.reason.lan-invite-required": "There is no current invitation to this LAN session.",
  "rooms.preflight.reason.network-unmeasured": "A connection for this action has not been measured yet.",
  "rooms.preflight.reason.browser-crypto": "The browser does not expose the required cryptography API.",
  "rooms.preflight.reason.browser-webrtc": "The browser does not expose WebRTC.",
  "rooms.preflight.next.continue": "The action will check permissions again before it runs.",
  "rooms.preflight.next.update": "Use a Havvn build with support for this feature.",
  "rooms.preflight.next.reconnect": "Check the connection and retry.",
  "rooms.preflight.next.wait-owner": "Wait for the owner to connect.",
  "rooms.preflight.next.ask-owner": "Ask the room owner or LAN host for access.",
  "rooms.preflight.next.configure-lan": "Open LAN diagnostics and check the driver.",
  "rooms.preflight.next.wait-lan": "Stop LAN in the other room before retrying.",
  "rooms.preflight.next.browser": "Open the room in a browser with WebRTC and Web Crypto over HTTPS.",
  "rooms.preflight.next.try-connection": "You can try connecting; success will be determined during the action.",
  'transfer.blocked': 'Transfer activation is blocked by VPN or disk-space protection. Resolve the warning before resuming.',
  'notify.private.title': 'Havvn',
  'notify.private.body': 'New activity in Havvn.',
  'notify.summary.download-complete': 'Downloads completed',
  'notify.summary.download-error': 'Download problems',
  'notify.summary.room-message': 'Room activity',
  'notify.summary.rss': 'RSS updates',
  'notify.summary.system': 'Havvn events',
  'notify.summary.body': 'Events: {count}. Open Havvn to view them.',
  'notify.downloadError.title': 'Download failed',
  'notify.downloadError.body': '{name}. Open Havvn to view the problem.',
  "dialog.syncFolder": "Choose a folder to synchronize",
  'dialog.syncHistoryExport': 'Export encrypted file history to a new file',
  'dialog.syncTrashExport': 'Save a trash copy as a new file',
  'dialog.syncHistoryImport': 'Open encrypted file history',
  "dialog.exportRoomDiagnostics": "Export room diagnostics",
  "rooms.storage.write-failed": "Room changes could not be saved. Restore system secret storage and disk access, then retry before closing Havvn. The previous disk record is intact.",
  "rooms.storage.title": "Room secrets are locked",
  "rooms.storage.unavailable": "System secret storage is unavailable. Restore access under the original OS account and retry. Room data has been kept.",
  "rooms.storage.decrypt-failed": "Could not unlock room secrets. Restore the original OS account/keychain or an intact backup, then retry. Room data has been kept.",
  "rooms.storage.migration-failed": "Could not protect the saved room. Check system secret storage and disk access, then retry. The original record has been kept.",
  "rooms.storage.unsupported": "This room uses an unsupported storage version. Open it with a compatible Havvn version. Room data has been kept.",

  "search.network.cancelled": "Request cancelled. Retry the search.",
  "search.plugin.pythonMissing": "Python 3 is required for this source. Install it and restart Havvn.",
  "search.plugin.updateRequired": "This plugin does not support shared connections. Update the source plugin or select Legacy connection.",
  "search.network.timeout": "Source timed out. Check its connection or mirror.",
  "search.network.dns": "Could not resolve the site. Check DNS or select a proxy.",
  "search.network.proxy": "Proxy unavailable or requires authentication. Check the connection settings.",
  "search.network.tls": "Secure connection failed. Check the site address and certificate.",
  "search.network.auth": "Session expired or login required. Open Sign in in the source connection settings.",
  "search.network.captcha": "The site requires a browser check for this request. Complete it in Sign in. If you are already signed in, check whether search works inside that window: background requests may still be rejected.",
  "search.network.invalid-response": "The source returned an unrecognized page. Check its mirror and sign-in page; the plugin may need an update.",
  "search.network.forbidden": "Site refused access (403). Access restrictions or a browser check may apply.",
  "search.network.rate-limit": "Too many requests. Wait before retrying.",
  "search.network.server": "Source server failed. Try again later.",
  "search.network.http": "Source returned an HTTP error. Check its address.",
  "search.network.redirect": "Redirect is not allowed. Check the source trusted origins.",
  "search.network.too-large": "Source response exceeds the size limit.",
  "search.network.invalid-url": "Invalid source URL.",
  "search.network.network": "Connection failed; cause unknown. Check source access.",
  // Tray icon
  'tray.tooltip.running': 'Havvn — Running in background',
  'tray.tooltip': 'Havvn',
  'tray.open': 'Open Havvn',
  'tray.openDownloads': 'Open downloads folder',
  'tray.active': 'active',
  'tray.pauseAll': 'Pause All Downloads',
  'tray.resumeAll': 'Resume All Downloads',
  'tray.altSpeed': 'Alternative speed limits',
  'tray.onDone': 'When downloads finish',
  'tray.onDone.none': 'Do nothing',
  'tray.onDone.sleep': 'Sleep',
  'tray.onDone.shutdown': 'Shut down',
  'tray.onDone.quit': 'Quit Havvn',
  'tray.onDone.cancelPending': 'Cancel the pending action',
  'tray.quit': 'Quit Havvn',

  // Native dialogs
  'dialog.addFilesToRoom': 'Add files to room',
  'dialog.selectFilesForTorrent': 'Select Files for Torrent',
  'dialog.selectFolderForTorrent': 'Select Folder for Torrent',
  'dialog.saveTorrentFile': 'Save Torrent File',
  'dialog.exportSettings': 'Export Settings',
  'dialog.importSettings': 'Import Settings',
  'settings.transfer.review': 'Review settings before importing',
  'settings.transfer.scope': 'App settings: {count} fields. Schedule: {schedule}. Privacy: {privacy}.',
  'settings.transfer.included': 'included',
  'settings.transfer.unchanged': 'unchanged',
  'settings.transfer.categories': 'Categories to add: {added}. Categories to update by ID: {updated}.',
  'settings.transfer.categoryDefaults': 'Directory: {path}; seed ratio: {ratio}; seed minutes: {minutes}; start paused: {paused}; sequential: {sequential}',
  'settings.transfer.categoryNotifications': 'Popups: {popups}; sound: {sound}; show content: {content}',
  'settings.transfer.inherit': 'inherit',
  'settings.transfer.yes': 'yes',
  'settings.transfer.no': 'no',
  'settings.transfer.more': 'And {count} more category changes.',
  'settings.transfer.notice': 'Other categories and their download assignments are kept. Equal names with different IDs remain separate. Passwords and remote access tokens are not imported. A recovery copy is kept until the next successful import. Restart Havvn after importing to apply all settings.',
  'settings.transfer.interface': 'Interface sections: {sections}.',
  'settings.transfer.section.settings': 'App settings',
  'settings.transfer.section.categories': 'Categories',
  'settings.transfer.section.scheduler': 'Schedule',
  'settings.transfer.section.privacyConfig': 'Privacy',
  'settings.transfer.section.appearance': 'Themes and appearance',
  'settings.transfer.section.hotkeys': 'Keyboard shortcuts',
  'settings.transfer.section.layout': 'Layout, interface and working profiles',
  'settings.transfer.restore': 'Restore previous settings',
  'settings.transfer.restoreReview': 'Restore selected sections from before the last import?',
  'settings.transfer.restoreNotice': 'Selected sections: {sections}. Later changes in these sections will be replaced. Categories still assigned to downloads or RSS, and categories edited after importing, are kept. Local passwords and access tokens are kept. This recovery copy is consumed after successful restoration. Restart Havvn afterwards.',
  'settings.transfer.cancel': 'Cancel',
  'settings.transfer.apply': 'Import',
  'dialog.exportRoomIdentity': 'Export Room Identity',
  'dialog.importRoomIdentity': 'Import Room Identity',
  'dialog.exportOPML': 'Export Feeds',
  'dialog.importOPML': 'Import Feeds',
  'rss.notifyBody': '{count} new items',
  'dialog.exportTheme': 'Export Theme',
  'dialog.importTheme': 'Import Theme',
  'dialog.lanAllowApp': 'Choose the game executable',
  'dialog.filter.torrent': 'Torrent Files',
  'dialog.filter.json': 'JSON Files',
  'dialog.filter.exe': 'Applications',

  // System notifications
  'notify.downloadComplete.title': 'Download Complete',
  'automation.notification.title': 'Havvn automation',
  'automation.notification.body': 'Rules applied to “{name}”.',
  'notify.downloadComplete.body': '{name} has finished downloading',
  'notify.lowDisk.title': 'Low disk space — torrents paused',
  'notify.lowDisk.bodyOne': 'Only {free} free. Paused 1 torrent. Free up space, then resume manually.',
  'notify.lowDisk.bodyMany': 'Only {free} free. Paused {count} torrents. Free up space, then resume manually.',
  'notify.lowDisk.bodyNone': 'Only {free} free on the download drive.',
  'notify.vpnLost.title': 'Tunnel route unconfirmed — torrents paused',
  'notify.vpnLost.bodyOne': 'Paused 1 torrent to protect your IP. Reconnect your VPN, then resume manually.',
  'notify.vpnLost.bodyMany': 'Paused {count} torrents to protect your IP. Reconnect your VPN, then resume manually.',
  'notify.vpnLost.bodyNone': 'A tunnel route cannot be confirmed. Check your VPN before resuming torrents.',
  'notify.vpnLost.bodyRooms': 'Paused your rooms to protect your IP. They reconnect automatically when the VPN is back.',
  'notify.vpnBindLost.title': 'Tunnel route unconfirmed — rebinding engine',
  'notify.vpnBindLost.body': 'The engine will use loopback fallback if no routed tunnel is found. Check its binding status in Privacy.',
  'notify.vpnRebound.title': 'VPN address changed — engine re-bound',
  'notify.vpnRebound.body': 'The download engine restarted and is bound to {ip}.',
  'notify.onDone.shutdownTitle': 'Downloads finished — shutting down',
  'notify.onDone.shutdownBody': 'The computer will shut down in 60 seconds. Open Havvn to cancel.',
  'notify.onDone.sleepTitle': 'Downloads finished — going to sleep',
  'notify.onDone.sleepBody': 'The computer will go to sleep in 15 seconds. Open Havvn to cancel.',
  'notify.onDone.quitTitle': 'Downloads finished — quitting',
  'notify.onDone.quitBody': 'Havvn will quit in 15 seconds. Open it to cancel.',
  'notify.room.someone': 'Someone',
  'notify.room.sharedFile': 'shared {file}',
  'notify.room.aFile': 'a file',
  'notify.room.fallbackName': 'Room',

  // Shared
  'common.ok': 'OK',

  // Search-provider test (main → renderer, shown as test result)
  'search.providerNotFound': 'Provider not found',
  'search.pageExpired': 'These results have expired. Search again.',
  'search.invalidQuery': 'Enter a query of up to 300 characters.',
  'search.rutracker.queryUnsupported': 'RuTracker cannot search for some characters in this query.',
  'search.providerWorking': 'Provider is working correctly',
  'search.providerNoSearch': 'Reachable, but this indexer reports that search is unavailable',

  // Application menu (the native File/Edit/View/Window bar)
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.help': 'Help',
  'menu.quit': 'Quit',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.reload': 'Reload',
  'menu.toggleDevTools': 'Toggle Developer Tools',
  'menu.resetZoom': 'Actual Size',
  'menu.zoomIn': 'Zoom In',
  'menu.zoomOut': 'Zoom Out',
  'menu.fullscreen': 'Toggle Full Screen',
  'menu.minimize': 'Minimize',
  'menu.close': 'Close',
  'menu.about': 'About Havvn',
  'menu.version': 'Version {v}',
};

const ru: Dict = {
  'startup.failed.title': 'Не удалось запустить Havvn',
  'startup.failed.message': 'Havvn не смог завершить запуск',
  'startup.failed.detail': 'Перезапустите Havvn. Если ошибка повторится, откройте журнал приложения для подробностей. Загрузки и комнаты сохраняются в вашем профиле.',
  'startup.security.title': 'Не удалось запустить Havvn',
  'startup.security.message': 'Системное хранилище ключей недоступно',
  'startup.security.detail': 'Havvn требуется системное хранилище ключей для защиты ключей комнат и паролей. Войдите под своей обычной учётной записью ОС и проверьте доступ к этому хранилищу. В Windows используется DPAPI, в macOS — «Связка ключей», в Linux нужен работающий Secret Service (например, libsecret с GNOME Keyring). После восстановления доступа перезапустите Havvn.',
  'common.exit': 'Выйти',
  "rooms.preflight.reason.ready": "Известные условия выполнены.",
  "rooms.preflight.reason.capability-unknown": "Клиент не сообщил о нужной возможности.",
  "rooms.preflight.reason.capability-missing": "Эта сборка не заявляет поддержку действия.",
  "rooms.preflight.reason.room-unavailable": "Комната сейчас недоступна.",
  "rooms.preflight.reason.removed": "Вы исключены из комнаты.",
  "rooms.preflight.reason.suspended": "Сетевая защита приостановила соединения.",
  "rooms.preflight.reason.engine-unavailable": "Движок комнаты ещё не готов.",
  "rooms.preflight.reason.peer-unavailable": "Выбранный участник больше не в сети.",
  "rooms.preflight.reason.owner-unknown": "Владелец комнаты ещё не определён.",
  "rooms.preflight.reason.owner-required": "Действие доступно только текущему владельцу комнаты или ведущему LAN.",
  "rooms.preflight.reason.lan-unavailable": "Локальный драйвер LAN недоступен.",
  "rooms.preflight.reason.lan-busy": "LAN уже используется в другой комнате.",
  "rooms.preflight.reason.lan-invite-required": "Нет действующего приглашения в эту LAN-сессию.",
  "rooms.preflight.reason.network-unmeasured": "Соединение для этого действия ещё не измерено.",
  "rooms.preflight.reason.browser-crypto": "Браузер не предоставляет нужный API шифрования.",
  "rooms.preflight.reason.browser-webrtc": "Браузер не предоставляет WebRTC.",
  "rooms.preflight.next.continue": "Перед выполнением права будут проверены повторно.",
  "rooms.preflight.next.update": "Используйте сборку Havvn с поддержкой этой возможности.",
  "rooms.preflight.next.reconnect": "Проверьте соединение и повторите попытку.",
  "rooms.preflight.next.wait-owner": "Дождитесь подключения владельца.",
  "rooms.preflight.next.ask-owner": "Запросите доступ у владельца комнаты или ведущего LAN.",
  "rooms.preflight.next.configure-lan": "Откройте диагностику LAN и проверьте драйвер.",
  "rooms.preflight.next.wait-lan": "Остановите LAN в другой комнате и повторите попытку.",
  "rooms.preflight.next.browser": "Откройте комнату в браузере с WebRTC и Web Crypto через HTTPS.",
  "rooms.preflight.next.try-connection": "Можно попробовать подключиться; результат определится во время действия.",
  'transfer.blocked': 'Запуск передачи заблокирован защитой VPN или свободного места. Устраните причину предупреждения перед возобновлением.',
  'notify.private.title': 'Havvn',
  'notify.private.body': 'Новое событие в Havvn.',
  'notify.summary.download-complete': 'Загрузки завершены',
  'notify.summary.download-error': 'Проблемы загрузок',
  'notify.summary.room-message': 'События комнаты',
  'notify.summary.rss': 'Обновления RSS',
  'notify.summary.system': 'События Havvn',
  'notify.summary.body': 'Событий: {count}. Откройте Havvn для просмотра.',
  'notify.downloadError.title': 'Ошибка загрузки',
  'notify.downloadError.body': '{name}. Откройте Havvn для просмотра проблемы.',
  "dialog.syncFolder": "Выберите папку для синхронизации",
  'dialog.syncHistoryExport': 'Сохранить зашифрованную историю в новый файл',
  'dialog.syncTrashExport': 'Сохранить копию из корзины в новый файл',
  'dialog.syncHistoryImport': 'Открыть зашифрованную историю файлов',
  "dialog.exportRoomDiagnostics": "Экспорт диагностики комнаты",
  "rooms.storage.write-failed": "Не удалось сохранить изменения комнаты. Восстанови доступ к системному хранилищу секретов и диску, затем повтори до закрытия Havvn. Предыдущая запись на диске сохранена.",
  "rooms.storage.title": "Секреты комнаты недоступны",
  "rooms.storage.unavailable": "Системное хранилище секретов недоступно. Восстанови доступ в исходной учётной записи ОС и повтори. Данные комнаты сохранены.",
  "rooms.storage.decrypt-failed": "Не удалось расшифровать секреты комнаты. Восстанови исходную учётную запись ОС, хранилище ключей или целую резервную копию и повтори. Данные комнаты сохранены.",
  "rooms.storage.migration-failed": "Не удалось защитить сохранённую комнату. Проверь системное хранилище секретов и доступ к диску, затем повтори. Исходная запись сохранена.",
  "rooms.storage.unsupported": "Формат хранения этой комнаты не поддерживается. Открой её совместимой версией Havvn. Данные комнаты сохранены.",

  "search.network.cancelled": "Запрос отменён. Повтори поиск.",
  "search.plugin.pythonMissing": "Для этого источника нужен Python 3. Установи его и перезапусти Havvn.",
  "search.plugin.updateRequired": "Этот плагин не поддерживает общее подключение. Обнови плагин источника или выбери «Прежнее подключение».",
  "search.network.timeout": "Источник не ответил вовремя. Проверь подключение или зеркало.",
  "search.network.dns": "Не удалось определить адрес сайта. Проверь DNS или выбери прокси.",
  "search.network.proxy": "Прокси недоступен или требует авторизации. Проверь настройки подключения.",
  "search.network.tls": "Ошибка защищённого соединения. Проверь адрес и сертификат сайта.",
  "search.network.auth": "Сессия истекла или требуется вход. Нажми «Войти на сайт» в подключении источника.",
  "search.network.captcha": "Сайт требует проверку браузера для этого запроса. Пройди её в окне входа. Если ты уже вошёл, проверь поиск внутри этого окна: сайт может отдельно отклонять фоновые запросы.",
  "search.network.invalid-response": "Источник вернул неизвестную страницу. Проверь зеркало и страницу входа; возможно, плагин нужно обновить.",
  "search.network.forbidden": "Сайт отказал в доступе (403). Возможны ограничения доступа или проверка браузера.",
  "search.network.rate-limit": "Слишком много запросов. Подожди перед повтором.",
  "search.network.server": "Ошибка на стороне источника. Повтори позже.",
  "search.network.http": "Источник вернул ошибку HTTP. Проверь его адрес.",
  "search.network.redirect": "Переход на другой адрес не разрешён. Проверь доверенные адреса источника.",
  "search.network.too-large": "Ответ источника превышает допустимый размер.",
  "search.network.invalid-url": "Некорректный адрес источника.",
  "search.network.network": "Ошибка подключения. Причину определить не удалось. Проверь доступ к источнику.",
  // Tray icon
  'tray.tooltip.running': 'Havvn — работает в фоне',
  'tray.tooltip': 'Havvn',
  'tray.open': 'Открыть Havvn',
  'tray.openDownloads': 'Открыть папку загрузок',
  'tray.active': 'активных',
  'tray.pauseAll': 'Приостановить все загрузки',
  'tray.resumeAll': 'Возобновить все загрузки',
  'tray.altSpeed': 'Альтернативные лимиты скорости',
  'tray.onDone': 'Когда загрузки завершатся',
  'tray.onDone.none': 'Ничего не делать',
  'tray.onDone.sleep': 'Спящий режим',
  'tray.onDone.shutdown': 'Выключить компьютер',
  'tray.onDone.quit': 'Выйти из Havvn',
  'tray.onDone.cancelPending': 'Отменить запланированное действие',
  'tray.quit': 'Выйти из Havvn',

  // Native dialogs
  'dialog.addFilesToRoom': 'Добавить файлы в комнату',
  'dialog.selectFilesForTorrent': 'Выберите файлы для торрента',
  'dialog.selectFolderForTorrent': 'Выберите папку для торрента',
  'dialog.saveTorrentFile': 'Сохранить торрент-файл',
  'dialog.exportSettings': 'Экспорт настроек',
  'dialog.importSettings': 'Импорт настроек',
  'settings.transfer.review': 'Проверьте настройки перед импортом',
  'settings.transfer.scope': 'Настройки приложения: {count} полей. Расписание: {schedule}. Приватность: {privacy}.',
  'settings.transfer.included': 'включено в импорт',
  'settings.transfer.unchanged': 'без изменений',
  'settings.transfer.categories': 'Добавится категорий: {added}. Обновится по ID: {updated}.',
  'settings.transfer.categoryDefaults': 'Каталог: {path}; коэффициент раздачи: {ratio}; минуты раздачи: {minutes}; старт на паузе: {paused}; последовательно: {sequential}',
  'settings.transfer.categoryNotifications': 'Окна: {popups}; звук: {sound}; показывать содержимое: {content}',
  'settings.transfer.inherit': 'наследовать',
  'settings.transfer.yes': 'да',
  'settings.transfer.no': 'нет',
  'settings.transfer.more': 'И ещё изменений категорий: {count}.',
  'settings.transfer.notice': 'Остальные категории и их связи с загрузками сохранятся. Одинаковые имена с разными ID останутся отдельными категориями. Пароли и токены удалённого доступа не импортируются. Копия для восстановления хранится до следующего успешного импорта. После импорта перезапустите Havvn для применения всех настроек.',
  'settings.transfer.interface': 'Разделы интерфейса: {sections}.',
  'settings.transfer.section.settings': 'Настройки приложения',
  'settings.transfer.section.categories': 'Категории',
  'settings.transfer.section.scheduler': 'Расписание',
  'settings.transfer.section.privacyConfig': 'Приватность',
  'settings.transfer.section.appearance': 'Темы и оформление',
  'settings.transfer.section.hotkeys': 'Горячие клавиши',
  'settings.transfer.section.layout': 'Панели, интерфейс и рабочие профили',
  'settings.transfer.restore': 'Восстановить прежние настройки',
  'settings.transfer.restoreReview': 'Вернуть выбранные разделы к состоянию до последнего импорта?',
  'settings.transfer.restoreNotice': 'Выбраны разделы: {sections}. Более поздние изменения в этих разделах будут заменены. Категории, назначенные загрузкам или RSS, и категории, отредактированные после импорта, сохранятся. Локальные пароли и токены доступа сохранятся. После успешного восстановления эта резервная копия будет использована. Затем перезапустите Havvn.',
  'settings.transfer.cancel': 'Отмена',
  'settings.transfer.apply': 'Импортировать',
  'dialog.exportRoomIdentity': 'Экспорт identity комнат',
  'dialog.importRoomIdentity': 'Импорт identity комнат',
  'dialog.exportOPML': 'Экспорт лент',
  'dialog.importOPML': 'Импорт лент',
  'rss.notifyBody': 'Новых элементов: {count}',
  'dialog.exportTheme': 'Экспорт темы',
  'dialog.importTheme': 'Импорт темы',
  'dialog.lanAllowApp': 'Выберите исполняемый файл игры',
  'dialog.filter.torrent': 'Торрент-файлы',
  'dialog.filter.json': 'Файлы JSON',
  'dialog.filter.exe': 'Приложения',

  // System notifications
  'notify.downloadComplete.title': 'Загрузка завершена',
  'automation.notification.title': 'Автоматизация Havvn',
  'automation.notification.body': 'Правила применены к «{name}».',
  'notify.downloadComplete.body': '«{name}» — загрузка завершена',
  'notify.lowDisk.title': 'Мало места на диске — торренты приостановлены',
  'notify.lowDisk.bodyOne': 'Свободно только {free}. Приостановлен 1 торрент. Освободите место и возобновите вручную.',
  'notify.lowDisk.bodyMany': 'Свободно только {free}. Приостановлено торрентов: {count}. Освободите место и возобновите вручную.',
  'notify.lowDisk.bodyNone': 'На диске для загрузок свободно только {free}.',
  'notify.vpnLost.title': 'Маршрут через туннель не подтверждён — торренты приостановлены',
  'notify.vpnLost.bodyOne': 'Приостановлен 1 торрент для защиты вашего IP. Переподключите VPN и возобновите вручную.',
  'notify.vpnLost.bodyMany': 'Приостановлено торрентов: {count} для защиты вашего IP. Переподключите VPN и возобновите вручную.',
  'notify.vpnLost.bodyNone': 'Маршрут через туннель не подтверждён. Проверьте VPN перед возобновлением торрентов.',
  'notify.vpnLost.bodyRooms': 'Комнаты приостановлены, чтобы защитить ваш IP. Они переподключатся автоматически, когда VPN вернётся.',
  'notify.vpnBindLost.title': 'Маршрут туннеля не подтверждён — обновляем привязку движка',
  'notify.vpnBindLost.body': 'Если маршрут туннеля не найден, движок использует loopback. Проверьте статус привязки в настройках приватности.',
  'notify.vpnRebound.title': 'Адрес VPN изменился — движок перепривязан',
  'notify.vpnRebound.body': 'Движок загрузок перезапущен и привязан к {ip}.',
  'notify.onDone.shutdownTitle': 'Загрузки завершены — выключение',
  'notify.onDone.shutdownBody': 'Компьютер выключится через 60 секунд. Откройте Havvn, чтобы отменить.',
  'notify.onDone.sleepTitle': 'Загрузки завершены — спящий режим',
  'notify.onDone.sleepBody': 'Компьютер уснёт через 15 секунд. Откройте Havvn, чтобы отменить.',
  'notify.onDone.quitTitle': 'Загрузки завершены — выход',
  'notify.onDone.quitBody': 'Havvn закроется через 15 секунд. Откройте окно, чтобы отменить.',
  'notify.room.someone': 'Кто-то',
  'notify.room.sharedFile': 'поделился(-ась) {file}',
  'notify.room.aFile': 'файлом',
  'notify.room.fallbackName': 'Комната',

  // Shared
  'common.ok': 'OK',

  // Search-provider test (main → renderer, shown as test result)
  'search.providerNotFound': 'Провайдер не найден',
  'search.pageExpired': 'Результаты устарели. Выполни поиск заново.',
  'search.invalidQuery': 'Введи запрос длиной до 300 символов.',
  'search.rutracker.queryUnsupported': 'RuTracker не поддерживает некоторые символы в этом запросе.',
  'search.providerWorking': 'Провайдер работает корректно',
  'search.providerNoSearch': 'Доступен, но индексер сообщает, что поиск недоступен',

  // Application menu (the native File/Edit/View/Window bar)
  'menu.file': 'Файл',
  'menu.edit': 'Правка',
  'menu.view': 'Вид',
  'menu.window': 'Окно',
  'menu.help': 'Справка',
  'menu.quit': 'Выход',
  'menu.undo': 'Отменить',
  'menu.redo': 'Повторить',
  'menu.cut': 'Вырезать',
  'menu.copy': 'Копировать',
  'menu.paste': 'Вставить',
  'menu.selectAll': 'Выделить всё',
  'menu.reload': 'Перезагрузить',
  'menu.toggleDevTools': 'Инструменты разработчика',
  'menu.resetZoom': 'Реальный размер',
  'menu.zoomIn': 'Увеличить',
  'menu.zoomOut': 'Уменьшить',
  'menu.fullscreen': 'Во весь экран',
  'menu.minimize': 'Свернуть',
  'menu.close': 'Закрыть',
  'menu.about': 'О программе Havvn',
  'menu.version': 'Версия {v}',
};

const dicts: Record<MainLang, Dict> = { en, ru };

// Cached so tray rebuilds and notification bursts don't hit electron-store each
// call; kept in sync by initMainI18n() at startup and setMainLanguage() on change.
let current: MainLang = 'en';

/** Read the persisted UI language once at startup (before the tray is built). */
export function initMainI18n(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { getUiLanguage } = require('../db/store') as typeof import('../db/store.js');
    current = getUiLanguage();
  } catch {
    current = 'en';
  }
}

/** Mirror the renderer's language choice (from the 'app:setLanguage' IPC). */
export function setMainLanguage(lang: unknown): void {
  if (lang !== 'en' && lang !== 'ru') return;
  current = lang;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { setUiLanguage } = require('../db/store') as typeof import('../db/store.js');
    setUiLanguage(lang);
  } catch {
    /* best-effort — the in-memory value still updates */
  }
}

export function getMainLanguage(): MainLang {
  return current;
}

/**
 * Translate a main-process key. Falls back to English, then the raw key.
 * `vars` fills `{name}`-style placeholders (no pluralization — callers pick the
 * singular/plural key themselves, e.g. notify.lowDisk.bodyOne vs .bodyMany).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dicts[current][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{' + k + '}').join(String(v));
    }
  }
  return s;
}
