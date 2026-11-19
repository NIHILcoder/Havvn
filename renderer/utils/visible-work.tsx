import React, { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { useHostWindow } from './hostWindow';

// A dock tab stays mounted for media/voice state, while its read-only UI can rest.
// This context affects only callers of useVisibleWork, never transport timers.
const WorkVisible = createContext(true);
export const VisibleWorkProvider: React.FC<{ active: boolean; children: React.ReactNode; independent?: boolean }> = ({ active, children, independent = false }) => {
  const parent = useContext(WorkVisible);
  // An explicitly opened workspace/modal owns its visibility even if its launch
  // panel is later hidden. Its own host document still gates useVisibleWork.
  return <WorkVisible.Provider value={(independent || parent) && active}>{children}</WorkVisible.Provider>;
};

export function useDocumentVisible(element?: Element | null): boolean {
  const host = useHostWindow();
  const doc = element?.ownerDocument ?? host.document;
  const subscribe = useCallback((changed: () => void) => {
    doc?.addEventListener('visibilitychange', changed);
    return () => doc?.removeEventListener('visibilitychange', changed);
  }, [doc]);
  const snapshot = useCallback(() => !doc || doc.visibilityState !== 'hidden', [doc]);
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

export function useVisibleWork(): boolean {
  const documentVisible = useDocumentVisible();
  return useContext(WorkVisible) && documentVisible;
}
