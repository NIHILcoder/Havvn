import { DEFAULT_SCREEN_SHARE, validateScreenShareSettings, type ScreenShareSettings } from '../../shared/screen-share';
import { useCallback, useState, type SetStateAction } from 'react';
import { SCREEN_SHARE_PRESETS, type ScreenSharePreset } from '../../shared/screen-share';

export const SCREEN_SHARE_PREFS_KEY = 'screenSharePrefs';

export function loadScreenSharePrefs(): ScreenShareSettings {
  try { return validateScreenShareSettings(JSON.parse(localStorage.getItem(SCREEN_SHARE_PREFS_KEY) || '{}')); }
  catch { return { ...DEFAULT_SCREEN_SHARE }; }
}

/** Quality is remembered; system audio remains a fresh opt-in for each share. */
export function saveScreenSharePrefs(settings: ScreenShareSettings, manual?: ScreenShareSettings): void {
  try { localStorage.setItem(SCREEN_SHARE_PREFS_KEY, JSON.stringify({ ...validateScreenShareSettings(settings), ...(manual ? { manual: validateScreenShareSettings(manual) } : {}) })); }
  catch { /* Storage can be unavailable; sharing still works with this selection. */ }
}
export function loadManualScreenSharePrefs(fallback: ScreenShareSettings): ScreenShareSettings {
  try { const value = JSON.parse(localStorage.getItem(SCREEN_SHARE_PREFS_KEY) || '{}'); return value.manual ? validateScreenShareSettings(value.manual) : { ...fallback }; }
  catch { return { ...fallback }; }
}
export function useScreenShareSelection(initial: () => ScreenShareSettings) {
  const [value, setValue] = useState(() => { const settings = initial(); return { settings, manual: loadManualScreenSharePrefs(settings) }; });
  const setSettings = useCallback((update: SetStateAction<ScreenShareSettings>) => setValue(current => {
    const settings = typeof update === 'function' ? update(current.settings) : update;
    return { settings, manual: settings };
  }), []);
  const choosePreset = useCallback((id: ScreenSharePreset | 'manual') => setValue(current => ({ ...current, settings: id === 'manual' ? current.manual : { ...SCREEN_SHARE_PRESETS[id] } })), []);
  return { ...value, setSettings, choosePreset };
}
