import type { OwnedOperation } from '../../shared/operations';

/** Subscribe before reading; a delayed read/error cannot replace a newer owner revision. */
export function createOperationObserver(api: {
  read: () => Promise<OwnedOperation | null>;
  subscribe: (changed: () => void) => () => void;
}) {
  let snapshot: { operation: OwnedOperation | null; unavailable: boolean } = { operation: null, unavailable: false };
  const listeners = new Set<() => void>();
  let owners = 0, epoch = 0, request = 0, off: (() => void) | undefined;
  const publish = (next: typeof snapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
  const refresh = async () => {
    const generation = epoch, ticket = ++request;
    try {
      const operation = await api.read();
      if (generation !== epoch) return;
      if (snapshot.operation && (!operation || operation.revision < snapshot.operation.revision)) return;
      publish({ operation, unavailable: false });
    } catch {
      if (generation === epoch && ticket === request) publish({ ...snapshot, unavailable: true });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    acquire: () => {
      if (owners++ === 0) { epoch++; off = api.subscribe(() => { void refresh(); }); void refresh(); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--owners === 0) { epoch++; off?.(); off = undefined; }
      };
    },
  };
}
