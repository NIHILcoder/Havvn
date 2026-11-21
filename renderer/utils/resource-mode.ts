import { useSyncExternalStore } from 'react';
import { createResourceModeState } from '../state/resource-mode-state';
export const resourceMode = createResourceModeState(() => window.api.resourceMode);
export const useResourceMode = () => useSyncExternalStore(resourceMode.subscribe, resourceMode.getSnapshot, resourceMode.getSnapshot);
export const useResourceEconomy = (): boolean => useSyncExternalStore(resourceMode.subscribe,
  () => resourceMode.getSnapshot().snapshot.economy, () => false);
