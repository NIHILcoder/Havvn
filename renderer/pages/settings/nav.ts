/**
 * Settings navigation model — the new information architecture.
 *
 * The old monolith crammed everything into General/Downloads/Network/Advanced/…
 * with the Network tab alone carrying seven feature areas. Here the low-level
 * network settings live in "connection", the sharing/remote features in
 * "sharing", DoH moves under "privacy", and the old "advanced" tab is dissolved
 * into "connection". Group + item labels resolve through i18n in SettingsNav.
 */
import { IconName } from '../../components';

export interface SettingsNavItem {
  /** Also the i18n label key suffix: settings.<id>. */
  id: string;
  icon: IconName;
  group: string;
  /** Extra EN+RU search terms — never shown, only used to filter the nav. */
  keywords: string;
}

/** Group display order; each key resolves to settings.group.<key>. */
export const SETTINGS_GROUPS: string[] = ['core', 'privacy', 'seeding', 'appearance', 'system'];

export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', icon: 'settings', group: 'core', keywords: 'engine движок autostart автозапуск update обновления tray трей startup запуск' },
  { id: 'downloads', icon: 'download', group: 'core', keywords: 'folder папка directory каталог watch слежение авто-перемещение disk диск guard активных' },
  { id: 'connection', icon: 'activity', group: 'core', keywords: 'speed скорость limit лимит peers пиры connections подключения port порт dht utp upnp turbo турбо' },
  { id: 'privacy', icon: 'shield', group: 'privacy', keywords: 'vpn kill-switch логи logs doh dns encrypt шифрование anonymous приватность killswitch' },
  { id: 'sharing', icon: 'globe', group: 'privacy', keywords: 'web remote qr turn relay релей профили profiles share общий доступ mobile мобильный' },
  { id: 'seeding', icon: 'share-2', group: 'seeding', keywords: 'seed раздача ratio рейтинг time время limit лимит' },
  { id: 'scheduler', icon: 'calendar', group: 'seeding', keywords: 'schedule расписание планировщик bandwidth график' },
  { id: 'interface', icon: 'sun', group: 'appearance', keywords: 'theme тема language язык appearance вид интерфейс' },
  { id: 'hotkeys', icon: 'keyboard', group: 'appearance', keywords: 'hotkey hotkeys горячие клавиши shortcut shortcuts сочетания keyboard клавиатура keys бинды keybinding' },
  { id: 'notifications', icon: 'bell', group: 'appearance', keywords: 'notification уведомление sound звук alert' },
  { id: 'system', icon: 'power', group: 'system', keywords: 'cache кэш default client клиент export экспорт import импорт backup обновления' },
  { id: 'about', icon: 'info', group: 'system', keywords: 'version версия about о программе github license лицензия' },
];
