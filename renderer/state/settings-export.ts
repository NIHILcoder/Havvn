import { useEffect, useSyncExternalStore } from 'react';
import { createOperationObserver } from './operation-observer';

const model = createOperationObserver({
  read: () => window.api.getSettingsExportOperation(),
  subscribe: listener => window.api.onSettingsExportOperation(listener),
});
export function useSettingsExportOperation() {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => model.acquire(), []);
  return state;
}
