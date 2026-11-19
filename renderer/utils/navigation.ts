import { useSyncExternalStore } from 'react';
import { NAVIGATION_KEY } from '../../shared/navigation';
import { createNavigationState } from '../state/navigation-state';

export const navigation = createNavigationState(() => localStorage);
let owners = 0;
const onStorage = (event: StorageEvent) => { if (event.key === NAVIGATION_KEY || event.key === null) navigation.refresh(); };
const subscribe = (listener: () => void) => {
  const off = navigation.subscribe(listener);
  if (++owners === 1) {
    window.addEventListener('storage', onStorage);
    window.addEventListener('havvn:settings-transfer', navigation.refresh);
    navigation.refresh();
  }
  return () => {
    off();
    if (--owners === 0) {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('havvn:settings-transfer', navigation.refresh);
    }
  };
};
export const useNavigation = () => useSyncExternalStore(subscribe, navigation.getSnapshot, navigation.getSnapshot);
