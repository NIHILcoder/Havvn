import { describeUserError, unwrapUserError, USER_ERRORS, type ErrorLanguage } from '../../shared/user-errors';

type Dictionary = Readonly<Record<string, string>>;
const dictionaries: Partial<Record<ErrorLanguage, Dictionary>> = {};
const reverse: Partial<Record<ErrorLanguage, Map<string, string>>> = {};
const templates: Partial<Record<ErrorLanguage, Array<{ key: string; pattern: RegExp; names: string[] }>>> = {};
const listeners = new Set<() => void>();
let revision = 0;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Called by the existing lazy locale loader; no eager imports of UI dictionaries. */
export function registerErrorTranslations(language: ErrorLanguage, dictionary: Dictionary): void {
  if (dictionaries[language] === dictionary) return;
  dictionaries[language] = dictionary;
  reverse[language] = new Map(); templates[language] = [];
  for (const [key, value] of Object.entries(dictionary)) {
    if (!reverse[language]?.has(value)) reverse[language]?.set(value, key);
    if (!/\{\w+\}/.test(value) || /\{(?:error|reason|details?|message)\}/i.test(value)) continue;
    const names: string[] = [];
    const pattern = value.split(/(\{\w+\})/).map(part => {
      if (!/^\{\w+\}$/.test(part)) return escape(part);
      names.push(part.slice(1, -1)); return '([\\s\\S]+?)';
    }).join('');
    if (names.length <= 3) templates[language]?.push({ key, pattern: new RegExp('^' + pattern + '$'), names });
  }
  revision++; listeners.forEach(listener => listener());
}

export function errorLanguage(): ErrorLanguage {
  try { const saved = localStorage.getItem('language'); if (saved === 'ru' || saved === 'en') return saved; } catch { /* no storage */ }
  try { if (document.documentElement.lang.toLowerCase().startsWith('ru')) return 'ru'; } catch { /* no DOM */ }
  return 'en';
}

function knownMessage(message: string, language: ErrorLanguage): string | null {
  if (message.length > 2048) return null;
  for (const pair of Object.values(USER_ERRORS)) if (pair[0] === message || pair[1] === message) return pair[language === 'ru' ? 0 : 1];
  if (/^(?:unknown error|error|undefined|null|\[object Object\]|неизвестная ошибка|ошибка)\.?$/i.test(message)) return null;
  for (const source of [language, language === 'ru' ? 'en' : 'ru'] as const) {
    const key = reverse[source]?.get(message) ?? (dictionaries[source]?.[message] ? message : undefined);
    if (key && dictionaries[language]?.[key]) return dictionaries[language]?.[key] ?? null;
    for (const item of templates[source] ?? []) {
      const match = item.pattern.exec(message), translated = dictionaries[language]?.[item.key];
      if (!match || !translated) continue;
      return item.names.reduce((text, name, index) => text.replaceAll('{' + name + '}', match[index + 1]), translated);
    }
  }
  return null;
}

/** Queued dialogs hold already translated titles/buttons as well as error text. */
export function localizeKnownText(text: string, language: ErrorLanguage = errorLanguage()): string {
  for (const source of [language, language === 'ru' ? 'en' : 'ru'] as const) {
    const key = reverse[source]?.get(text);
    if (key && dictionaries[language]?.[key]) return dictionaries[language]?.[key] ?? text;
  }
  return knownMessage(text, language) ?? text;
}

/** Presentation only: never use this result to branch, compare errors or store state. */
export function readableError(error: unknown, language: ErrorLanguage = errorLanguage(), depth = 0): string {
  const text = unwrapUserError(error);
  const known = knownMessage(text, language);
  if (known) return known;
  // Preserve a translated action heading in existing "Could not add: <error>"
  // messages while translating the cause independently of its IPC wrapper.
  if (depth < 3) {
    const separator = text.indexOf(': ');
    if (separator > 0 && separator < 180) {
      const heading = text.slice(0, separator), prefix = knownMessage(heading, language);
      const titleKey = reverse[language]?.get(heading) ?? reverse[language === 'ru' ? 'en' : 'ru']?.get(heading);
      const translatedTitle = prefix ?? (titleKey ? dictionaries[language]?.[titleKey] : undefined);
      if (translatedTitle) return translatedTitle + ': ' + readableError(text.slice(separator + 2), language, depth + 1);
    }
  }
  return describeUserError(error, language);
}

export function errorPresentationSnapshot(): string { return errorLanguage() + ':' + revision; }
export function subscribeErrorPresentation(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== 'undefined') { window.addEventListener('storage', listener); window.addEventListener('havvn:device-local', listener); }
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') { window.removeEventListener('storage', listener); window.removeEventListener('havvn:device-local', listener); }
  };
}
