import type { DownloadUndoError, DownloadUndoResult, DownloadUndoState } from '../../shared/download-removal';

export function createDownloadUndoState(api: {
  read(): Promise<DownloadUndoState>;
  subscribe(changed: () => void): () => void;
  undo(token: string): Promise<DownloadUndoResult>;
}, refreshDownloads: () => Promise<void>) {
  let snapshot = { state: { revision: 0, items: [] } as DownloadUndoState, unavailable: false,
    pending: new Set<string>(), error: null as DownloadUndoError | null };
  const listeners = new Set<() => void>(), pending = new Map<string, Promise<DownloadUndoResult>>();
  let owners = 0, epoch = 0, request = 0, off: (() => void) | undefined;
  const publish = (next: typeof snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
  const refresh = async () => {
    const generation = epoch, ticket = ++request;
    try {
      const state = await api.read();
      if (generation !== epoch || !state || state.revision < snapshot.state.revision) return;
      publish({ ...snapshot, state, unavailable: false });
    } catch { if (generation === epoch && ticket === request) publish({ ...snapshot, unavailable: true }); }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    clearError: () => publish({ ...snapshot, error: null }),
    acquire: () => {
      if (owners++ === 0) { epoch++; off = api.subscribe(() => { void refresh(); }); void refresh(); }
      let disposed = false;
      return () => { if (!disposed) { disposed = true; if (--owners === 0) { epoch++; off?.(); off = undefined; } } };
    },
    undo: (token: string): Promise<DownloadUndoResult> => {
      const current = pending.get(token); if (current) return current;
      publish({ ...snapshot, pending: new Set([...snapshot.pending, token]), error: null });
      const work = Promise.resolve().then(() => api.undo(token)).catch(() => ({ success: false, error: 'engine' } as const)).then(async result => {
        if (result.success) await refreshDownloads().catch(() => {});
        else publish({ ...snapshot, error: result.error });
        return result;
      }).finally(async () => {
        pending.delete(token);
        const busy = new Set(snapshot.pending); busy.delete(token);
        publish({ ...snapshot, pending: busy }); await refresh();
      });
      pending.set(token, work); return work;
    },
  };
}
