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
  'dialog.exportRoomIdentity': 'Export Room Identity',
  'dialog.importRoomIdentity': 'Import Room Identity',
  'dialog.exportTheme': 'Export Theme',
  'dialog.importTheme': 'Import Theme',
  'dialog.filter.torrent': 'Torrent Files',
  'dialog.filter.json': 'JSON Files',

  // System notifications
  'notify.downloadComplete.title': 'Download Complete',
  'notify.downloadComplete.body': '{name} has finished downloading',
  'notify.lowDisk.title': 'Low disk space — torrents paused',
  'notify.lowDisk.bodyOne': 'Only {free} free. Paused 1 torrent. Free up space, then resume manually.',
  'notify.lowDisk.bodyMany': 'Only {free} free. Paused {count} torrents. Free up space, then resume manually.',
  'notify.lowDisk.bodyNone': 'Only {free} free on the download drive.',
  'notify.vpnLost.title': 'VPN connection lost — torrents paused',
  'notify.vpnLost.bodyOne': 'Paused 1 torrent to protect your IP. Reconnect your VPN, then resume manually.',
  'notify.vpnLost.bodyMany': 'Paused {count} torrents to protect your IP. Reconnect your VPN, then resume manually.',
  'notify.vpnLost.bodyNone': 'Your VPN appears to be down. Reconnect it before resuming torrents.',
  'notify.vpnLost.bodyRooms': 'Paused your rooms to protect your IP. They reconnect automatically when the VPN is back.',
  'notify.vpnBindLost.title': 'VPN lost — engine is bound to the VPN',
  'notify.vpnBindLost.body': 'Peer traffic is blocked at the socket level until the VPN returns.',
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
  'search.providerWorking': 'Provider is working correctly',

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
  'dialog.exportRoomIdentity': 'Экспорт identity комнат',
  'dialog.importRoomIdentity': 'Импорт identity комнат',
  'dialog.exportTheme': 'Экспорт темы',
  'dialog.importTheme': 'Импорт темы',
  'dialog.filter.torrent': 'Торрент-файлы',
  'dialog.filter.json': 'Файлы JSON',

  // System notifications
  'notify.downloadComplete.title': 'Загрузка завершена',
  'notify.downloadComplete.body': '«{name}» — загрузка завершена',
  'notify.lowDisk.title': 'Мало места на диске — торренты приостановлены',
  'notify.lowDisk.bodyOne': 'Свободно только {free}. Приостановлен 1 торрент. Освободите место и возобновите вручную.',
  'notify.lowDisk.bodyMany': 'Свободно только {free}. Приостановлено торрентов: {count}. Освободите место и возобновите вручную.',
  'notify.lowDisk.bodyNone': 'На диске для загрузок свободно только {free}.',
  'notify.vpnLost.title': 'VPN-соединение потеряно — торренты приостановлены',
  'notify.vpnLost.bodyOne': 'Приостановлен 1 торрент для защиты вашего IP. Переподключите VPN и возобновите вручную.',
  'notify.vpnLost.bodyMany': 'Приостановлено торрентов: {count} для защиты вашего IP. Переподключите VPN и возобновите вручную.',
  'notify.vpnLost.bodyNone': 'Похоже, ваш VPN отключён. Переподключите его перед возобновлением торрентов.',
  'notify.vpnLost.bodyRooms': 'Комнаты приостановлены, чтобы защитить ваш IP. Они переподключатся автоматически, когда VPN вернётся.',
  'notify.vpnBindLost.title': 'VPN потерян — движок привязан к VPN',
  'notify.vpnBindLost.body': 'Трафик пиров заблокирован на уровне сокетов, пока VPN не восстановится.',
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
  'search.providerWorking': 'Провайдер работает корректно',

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getUiLanguage } = require('../db/store') as typeof import('../db/store');
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { setUiLanguage } = require('../db/store') as typeof import('../db/store');
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
