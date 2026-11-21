import { resolveResourceMode, validResourceSnapshot, type ResourceModeSnapshot } from '../../shared/resource-mode';

export function createResourceModeState(api: () => {
  get: () => Promise<ResourceModeSnapshot>;
  onChanged: (listener: (snapshot: ResourceModeSnapshot) => void) => () => void;
} | undefined) {
  let state = { snapshot: resolveResourceMode('normal', 'unknown'), status: 'loading' as 'loading' | 'ready' | 'unavailable' };
  const listeners = new Set<() => void>();
  let owners = 0, off: (() => void) | undefined, generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: typeof state) => { state = next; for (const listener of listeners) listener(); };
  const receive = (snapshot: unknown) => {
    if (!validResourceSnapshot(snapshot)) return;
    if (snapshot.revision < state.snapshot.revision) return;
    if (snapshot.revision === state.snapshot.revision && state.status === 'ready') return;
    clearTimeout(retry); retry = undefined;
    publish({ snapshot: { ...snapshot }, status: 'ready' });
  };
  const refresh = async () => {
    const revision = generation;
    try {
      const bridge = api();
      if (!bridge || typeof bridge.get !== 'function') throw Error('Resource bridge unavailable');
      const next = await bridge.get();
      if (revision !== generation) return;
      if (!validResourceSnapshot(next)) throw Error('Invalid resource snapshot');
      receive(next);
    } catch {
      if (revision === generation) {
        if (state.status !== 'unavailable') publish({ ...state, status: 'unavailable' });
        if (owners && !retry) retry = setTimeout(() => { retry = undefined; void refresh(); }, 5000);
      }
    }
  };
  const retain = () => {
    if (owners++ === 0) { generation++; const bridge = api(); if (typeof bridge?.onChanged === 'function') off = bridge.onChanged(receive); void refresh(); }
    let released = false;
    return () => { if (released) return; released = true; if (--owners === 0) { generation++; off?.(); off = undefined; clearTimeout(retry); retry = undefined; } };
  };
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, receive, refresh, retain };
}
