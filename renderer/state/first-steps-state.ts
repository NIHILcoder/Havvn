import { emptyFirstSteps, readFirstSteps, FIRST_STEPS_KEY, type FirstStepRoute, type FirstStepsState } from '../../shared/first-steps';
import type { RoomState } from '../../shared/types';
import type { RoomServerInstance } from '../../shared/gameserver-types';

type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export function createFirstStepsState(storage: () => StoragePort) {
  let snapshot: { data: FirstStepsState; storageError: boolean } | undefined;
  const listeners = new Set<() => void>();
  function getSnapshot() {
    if (!snapshot) {
      try {
        const port = storage();
        snapshot = { data: readFirstSteps(port.getItem(FIRST_STEPS_KEY), port.getItem('onboarded') === '1'), storageError: false };
      } catch { snapshot = { data: emptyFirstSteps(), storageError: true }; }
    }
    return snapshot;
  }
  function update(change: (data: FirstStepsState) => void) {
    const data: FirstStepsState = JSON.parse(JSON.stringify(getSnapshot().data));
    change(data);
    if (JSON.stringify(data) === JSON.stringify(getSnapshot().data) && !getSnapshot().storageError) return;
    let storageError = false;
    try { storage().setItem(FIRST_STEPS_KEY, JSON.stringify(data)); }
    catch { storageError = true; }
    // Tutorial persistence must never reject a successful download/share/play.
    snapshot = { data, storageError };
    listeners.forEach(listener => listener());
  }
  function progress(route: FirstStepRoute, target: string, done: boolean) {
    if (getSnapshot().data.active !== route || !/^[a-zA-Z0-9_-]{1,128}$/.test(target)) return;
    update(data => {
      const row = data.routes[route];
      row.target = target; row.prepared = true; row.done ||= done;
    });
  }
  return {
    getSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    markSeen: () => update(data => { data.seen = true; }),
    begin: (route: FirstStepRoute) => update(data => { data.seen = true; data.active = route; }),
    downloadAdded: (id: string) => progress('download', id, false),
    observeDownload: (row: { id: string; downloadedBytes: number; progress: number }) => {
      const data = getSnapshot().data;
      if (data.active === 'download' && data.routes.download.target === row.id && (row.downloadedBytes > 0 || row.progress >= 1)) progress('download', row.id, true);
    },
    mediaReady: (id: string) => progress('watch', id, false),
    mediaPlaying: (id: string) => progress('watch', id, true),
    roomReady: (id: string) => {
      const active = getSnapshot().data.active;
      if (active === 'share' || active === 'play') progress(active, id, false);
    },
    filePublished: (id: string, files: readonly { addedBy: string }[], selfId?: string) => {
      if (selfId && files.some(file => file.addedBy === selfId)) progress('share', id, true);
    },
    observeRoom: (room: Pick<RoomState, 'roomId' | 'kicked' | 'lan'>) => {
      if (room.kicked) return;
      const active = getSnapshot().data.active;
      if (active === 'share' || active === 'play') progress(active, room.roomId, false);
      if (room.lan?.available && room.lan.active && room.lan.selfVip && !room.lan.suspended && !room.lan.blocked) progress('play', room.roomId, true);
    },
    observeServers: (id: string, instances: readonly Pick<RoomServerInstance, 'isHost' | 'status'>[]) => {
      if (instances.some(instance => instance.isHost && instance.status === 'running')) progress('play', id, true);
    },
  };
}

/** Failed reads never establish a fresh install. Legacy users retain their dismissal. */
export async function offerFirstSteps(store: ReturnType<typeof createFirstStepsState>, load: () => Promise<{ downloads: readonly unknown[]; rooms: readonly unknown[] }>) {
  const snapshot = store.getSnapshot();
  if (snapshot.storageError || snapshot.data.seen) return false;
  try {
    const { downloads, rooms } = await load();
    if (!Array.isArray(downloads) || !Array.isArray(rooms) || store.getSnapshot().data.seen) return false;
    store.markSeen();
    return downloads.length === 0 && rooms.length === 0;
  } catch { return false; }
}
