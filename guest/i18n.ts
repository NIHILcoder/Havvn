export type GuestLang = 'en' | 'ru';

const en = {
  title: 'Havvn // Room',
  tagline: 'Peer-to-peer in your browser. No install, no cloud.',
  name: 'Your name',
  namePh: 'How they will see you',
  invite: 'Invite',
  invitePh: 'swift-amber-otter-comet-4821',
  join: 'Join room',
  joining: 'Deriving keys…',
  connecting: 'Connecting…',
  connected: 'Connected',
  peers: '{n} peers',
  alone: 'No one else here yet — the host must keep Havvn open.',
  leave: 'Leave',
  you: 'You',
  guest: 'Guest',
  owner: 'Owner',
  people: 'People',
  chat: 'Chat',
  watch: 'Watch',
  voice: 'Voice',
  voiceJoin: 'Join voice',
  voiceLeave: 'Leave voice',
  mute: 'Mute',
  unmute: 'Unmute',
  deafen: 'Deafen',
  undeafen: 'Undeafen',
  voiceNeedMic: 'Microphone permission is required for voice.',
  voiceFail: 'Could not start voice.',
  chatPh: 'Message the room',
  send: 'Send',
  typing: 'typing…',
  emptyChat: 'No messages yet. Say hello.',
  files: 'Watch',
  noFiles: 'Nothing to watch yet.',
  e2eFile: 'Encrypted — open in the Havvn app.',
  cantPlay: 'This format needs the desktop app.',
  togetherOff: 'Watch together',
  togetherOn: 'In sync',
  watching: 'Watching',
  kicked: 'You were removed from this room.',
  kickedHint: 'The invite no longer works. Ask for a new one.',
  badInvite: 'That invite does not look like a Havvn room code.',
  cryptoFail: 'This browser cannot do the room crypto (Ed25519). Try Chrome, Edge or Firefox.',
  webrtcFail: 'This browser cannot do WebRTC. Try Chrome, Edge or Firefox on desktop.',
  webtorrentFail: 'This browser cannot play shared files (WebTorrent / WebRTC). Chat and voice still work.',
  needHost: 'The host must keep Havvn open. If nothing happens, ask them to re-open the room.',
  e2eBanner: 'This room encrypts its files. Chat and voice work here; playback of those files needs the app.',
  lang: 'Language',
  reply: 'Reply',
  copy: 'Copy',
  copied: 'Copied',
  today: 'Today',
  yesterday: 'Yesterday',
  offline: 'Offline',
  direct: 'Direct',
  relayed: 'Via another member',
};

const ru: typeof en = {
  title: 'Havvn // Комната',
  tagline: 'Пирингом в браузере. Без установки и без облака.',
  name: 'Ваше имя',
  namePh: 'Как вас увидят',
  invite: 'Приглашение',
  invitePh: 'swift-amber-otter-comet-4821',
  join: 'Войти в комнату',
  joining: 'Считаем ключи…',
  connecting: 'Подключение…',
  connected: 'В сети',
  peers: '{n} пиров',
  alone: 'Пока никого — хост должен держать Havvn открытым.',
  leave: 'Выйти',
  you: 'Вы',
  guest: 'Гость',
  owner: 'Владелец',
  people: 'Люди',
  chat: 'Чат',
  watch: 'Просмотр',
  voice: 'Голос',
  voiceJoin: 'Войти в голос',
  voiceLeave: 'Выйти из голоса',
  mute: 'Микрофон выкл',
  unmute: 'Микрофон вкл',
  deafen: 'Не слышать',
  undeafen: 'Слышать',
  voiceNeedMic: 'Для голоса нужно разрешение на микрофон.',
  voiceFail: 'Не удалось запустить голос.',
  chatPh: 'Сообщение в комнату',
  send: 'Отправить',
  typing: 'печатает…',
  emptyChat: 'Сообщений ещё нет. Напишите первым.',
  files: 'Просмотр',
  noFiles: 'Пока нечего смотреть.',
  e2eFile: 'Зашифровано — откройте в приложении Havvn.',
  cantPlay: 'Этот формат играет только в приложении.',
  togetherOff: 'Смотреть вместе',
  togetherOn: 'В синхроне',
  watching: 'Смотрят',
  kicked: 'Вас убрали из этой комнаты.',
  kickedHint: 'Старое приглашение больше не действует. Попросите новое.',
  badInvite: 'Это не похоже на код комнаты Havvn.',
  cryptoFail: 'Браузер не умеет крипту комнаты (Ed25519). Попробуйте Chrome, Edge или Firefox.',
  webrtcFail: 'Браузер не умеет WebRTC. Попробуйте Chrome, Edge или Firefox на компьютере.',
  webtorrentFail: 'Браузер не умеет играть общие файлы (WebTorrent / WebRTC). Чат и голос всё равно работают.',
  needHost: 'Хост должен держать Havvn открытым. Если тишина — попросите открыть комнату снова.',
  e2eBanner: 'Комната шифрует файлы. Чат и голос здесь работают; воспроизведение этих файлов — в приложении.',
  lang: 'Язык',
  reply: 'Ответ',
  copy: 'Копировать',
  copied: 'Скопировано',
  today: 'Сегодня',
  yesterday: 'Вчера',
  offline: 'Не в сети',
  direct: 'Напрямую',
  relayed: 'Через участника',
};

export type GuestKey = keyof typeof en;

const DICTS: Record<GuestLang, Record<GuestKey, string>> = { en, ru };

export function detectLang(): GuestLang {
  try {
    const saved = localStorage.getItem('havvn.guest.lang');
    if (saved === 'ru' || saved === 'en') return saved;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function persistLang(lang: GuestLang): void {
  try { localStorage.setItem('havvn.guest.lang', lang); } catch { /* ignore */ }
}

export function t(lang: GuestLang, key: GuestKey, vars?: Record<string, string | number>): string {
  let s = DICTS[lang][key] || DICTS.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
  }
  return s;
}
