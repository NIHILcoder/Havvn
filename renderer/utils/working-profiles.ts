import { useSyncExternalStore } from 'react';
import { createWorkingProfilesState } from '../state/working-profiles-state';
import { PANELS_KEY, WORKING_PROFILES_KEY } from '../../shared/working-profile-schema';
import { revertToBase, bootApplyActiveTheme } from './theme-library';
import { clearQuickThemeOverrides, restoreThemePrefs } from './theme-prefs';
import { refreshAppearanceFromStorage } from './appearance';

export const WORKING_PROFILE_EVENT = 'havvn:working-profile';
export const workingProfiles = createWorkingProfilesState(() => localStorage, () => crypto.randomUUID());
let owners = 0;
const onStorage = (event: StorageEvent) => { if (event.key === null || [PANELS_KEY, WORKING_PROFILES_KEY].includes(event.key)) workingProfiles.refresh(); };
function subscribe(listener: () => void) {
  const off = workingProfiles.subscribe(listener);
  if (++owners === 1) {
    window.addEventListener('storage', onStorage);
    window.addEventListener('havvn:settings-transfer', workingProfiles.refresh);
    workingProfiles.refresh();
  }
  return () => {
    off();
    if (--owners === 0) {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('havvn:settings-transfer', workingProfiles.refresh);
    }
  };
}
export const useWorkingProfiles = () => useSyncExternalStore(subscribe, workingProfiles.getSnapshot, workingProfiles.getSnapshot);
/** Paint committed preferences without rewriting them or firing any room/voice action. */
export function refreshWorkingProfileUi() {
  clearQuickThemeOverrides(); revertToBase(); bootApplyActiveTheme(); restoreThemePrefs(); refreshAppearanceFromStorage();
  const root = document.documentElement;
  if (localStorage.getItem('density') === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  if (localStorage.getItem('reduceMotion') === '1') root.dataset.reduceMotion = 'true'; else delete root.dataset.reduceMotion;
  window.dispatchEvent(new Event('havvn:settings-transfer'));
  window.dispatchEvent(new Event(WORKING_PROFILE_EVENT));
}
