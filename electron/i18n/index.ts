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
  'tray.pauseAll': 'Pause All Downloads',
  'tray.resumeAll': 'Resume All Downloads',
  'tray.altSpeed': 'Alternative speed limits',
  'tray.quit': 'Quit Havvn',

  // Native dialogs
  'dialog.addFilesToRoom': 'Add files to room',
  'dialog.selectFilesForTorrent': 'Select Files for Torrent',
  'dialog.selectFolderForTorrent': 'Select Folder for Torrent',
  'dialog.saveTorrentFile': 'Save Torrent File',
  'dialog.exportSettings': 'Export Settings',
  'dialog.importSettings': 'Import Settings',
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

  // VPN warning message box
  'vpnWarn.title': 'Privacy Warning',
  'vpnWarn.message': 'VPN not detected! Your real IP address may be visible to peers.',
  'vpnWarn.detailIntro': 'Consider using a VPN for better privacy when using BitTorrent.',
  'vpnWarn.yourIp': 'Your public IP: {ip}',
  'vpnWarn.recommended': 'Recommended VPN providers:',
  'vpnWarn.mullvad': '• Mullvad VPN (anonymous, no logs)',
  'vpnWarn.proton': '• ProtonVPN (secure, privacy-focused)',
  'vpnWarn.ivpn': '• IVPN (privacy-first)',
  'vpnWarn.dontShowAgain': "Don't show again",
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
  'tray.pauseAll': 'Приостановить все загрузки',
  'tray.resumeAll': 'Возобновить все загрузки',
  'tray.altSpeed': 'Альтернативные лимиты скорости',
  'tray.quit': 'Выйти из Havvn',

  // Native dialogs
  'dialog.addFilesToRoom': 'Добавить файлы в комнату',
  'dialog.selectFilesForTorrent': 'Выберите файлы для торрента',
  'dialog.selectFolderForTorrent': 'Выберите папку для торрента',
  'dialog.saveTorrentFile': 'Сохранить торрент-файл',
  'dialog.exportSettings': 'Экспорт настроек',
  'dialog.importSettings': 'Импорт настроек',
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

  // VPN warning message box
  'vpnWarn.title': 'Предупреждение о приватности',
  'vpnWarn.message': 'VPN не обнаружен! Ваш реальный IP-адрес может быть виден пирам.',
  'vpnWarn.detailIntro': 'Рекомендуем использовать VPN для большей приватности при работе с BitTorrent.',
  'vpnWarn.yourIp': 'Ваш публичный IP: {ip}',
  'vpnWarn.recommended': 'Рекомендуемые VPN-провайдеры:',
  'vpnWarn.mullvad': '• Mullvad VPN (анонимно, без логов)',
  'vpnWarn.proton': '• ProtonVPN (безопасно, ориентирован на приватность)',
  'vpnWarn.ivpn': '• IVPN (приватность прежде всего)',
  'vpnWarn.dontShowAgain': 'Больше не показывать',
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
