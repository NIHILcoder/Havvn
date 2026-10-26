import { useEffect, useSyncExternalStore } from 'react';
import { createDownloadUndoState } from './download-undo-state';
import { downloadsModel } from './downloads';

export const downloadUndo = createDownloadUndoState({
  read: () => window.api.getDownloadUndo(),
  subscribe: callback => window.api.onDownloadUndoChanged(callback),
  undo: token => window.api.undoDownloadRemoval(token),
}, () => downloadsModel.refresh());
export function useDownloadUndo() {
  const state = useSyncExternalStore(downloadUndo.subscribe, downloadUndo.getSnapshot, downloadUndo.getSnapshot);
  useEffect(() => downloadUndo.acquire(), []);
  return state;
}
