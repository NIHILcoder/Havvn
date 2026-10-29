import React, { createContext, useContext, useState, useEffect } from 'react';
import { registerErrorTranslations } from './error-messages';

type Language = 'en' | 'ru';
type Dict = Record<string, string>;

// Derive the key union from en.json's type via a type-level dynamic import — this
// is a pure type query (no runtime import), so en.json is NOT pulled into the
// main bundle; it ships only as the lazy chunk loaded below.
type TranslationKey = keyof typeof import('../i18n/en.json');

// Dynamic imports make webpack split each language into its own async chunk, so
// the ~600-string dictionaries stay OUT of the main bundle and load on demand.
const loaders: Record<Language, () => Promise<Dict>> = {
  en: () => import('../i18n/en.json').then(m => { const dict = (m.default ?? m) as Dict; registerErrorTranslations('en', dict); return dict; }),
  ru: () => import('../i18n/ru.json').then(m => { const dict = (m.default ?? m) as Dict; registerErrorTranslations('ru', dict); return dict; }),
};

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('language');
    return saved === 'ru' || saved === 'en' ? saved : 'en';
  });
  // English is always loaded as the fallback for any key missing in the active
  // language; `active` holds the currently-selected language's dictionary.
  const [enFallback, setEnFallback] = useState<Dict | null>(null);
  const [active, setActive] = useState<Dict | null>(null);

  useEffect(() => {
    let alive = true;
    loaders.en().then(d => { if (alive) setEnFallback(d); }).catch(() => { /* keys stay as fallback */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    // Don't blank the screen on language switch — keep the previous dictionary
    // until the new one resolves (a few ms for a local chunk).
    loaders[language]().then(d => { if (alive) setActive(d); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [language]);

  // Mirror the language to the main process so the tray menu, native dialogs,
  // and OS notifications (which React can't reach) localize too. Fires on mount
  // for the persisted language, and again on every switch. Guarded for contexts
  // without the preload bridge (e.g. tests).
  useEffect(() => {
    try {
      (window as unknown as { api?: { setLanguage?: (l: string) => void } }).api?.setLanguage?.(language);
    } catch { /* no preload bridge — ignore */ }
    // Reflect the locale on <html lang> so :lang(ru) can give Russian a single
    // display face (Exo 2), and for screen-reader pronunciation.
    try { if (typeof document !== 'undefined') document.documentElement.lang = language; } catch { /* no DOM */ }
  }, [language]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('language', lang);
    window.dispatchEvent(new Event('havvn:device-local'));
  };
  useEffect(() => {
    const sync = (e: StorageEvent) => { if (e.key === 'language' || e.key === null) { const value = localStorage.getItem('language'); setLanguageState(value === 'ru' ? 'ru' : 'en'); } };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);

  const t = (key: TranslationKey): string => {
    const k = key as string;
    return active?.[k] ?? enFallback?.[k] ?? k;
  };

  // Block only on the very first load until the active dictionary is ready —
  // it's a local chunk, so this resolves near-instantly.
  if (!active) return null;

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useTranslation = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
};
