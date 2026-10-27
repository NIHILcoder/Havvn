import { createStore } from 'zustand/vanilla';
import type { Download, DownloadStats, IpcApi } from '../../shared/types';

export interface DownloadCounts {
  all: number; downloading: number; completed: number; paused: number; error: number; seeding: number;
}
export interface DownloadTotals {
  active: number; downSpeed: number; upSpeed: number; peers: number; downloaded: number; uploaded: number;
}
export interface DownloadState {
  downloads: Download[];
  byId: Map<string, Download>;
  statsById: Map<string, DownloadStats>;
  counts: DownloadCounts;
  totals: DownloadTotals;
  loaded: boolean;
  availability: 'loading' | 'ready' | 'unavailable';
}
type Api = Pick<IpcApi, 'getDownloads' | 'onDownloadStats'>;

// IPC creates new objects even when a record has not changed. Keep references
// stable for selectors, including Dates and the small persisted option arrays.
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
const emptyCounts: DownloadCounts = { all: 0, downloading: 0, completed: 0, paused: 0, error: 0, seeding: 0 };
const emptyTotals: DownloadTotals = { active: 0, downSpeed: 0, upSpeed: 0, peers: 0, downloaded: 0, uploaded: 0 };
function sameStats(a: DownloadStats, b: DownloadStats): boolean {
  return a.id === b.id && a.progress === b.progress && a.downloadedBytes === b.downloadedBytes
    && a.uploadedBytes === b.uploadedBytes && a.downSpeedBps === b.downSpeedBps && a.upSpeedBps === b.upSpeedBps
    && a.etaSeconds === b.etaSeconds && a.peers === b.peers && a.seeds === b.seeds && a.status === b.status
    && same(a.operation, b.operation);
}

export function createDownloadState(api: () => Api) {
  const store = createStore<DownloadState>(() => ({ downloads: [], byId: new Map(), statsById: new Map(),
    counts: emptyCounts, totals: emptyTotals, loaded: false, availability: 'loading' }));
  let statsRevision = 0, mutationRevision = 0;
  let pending: Promise<void> | null = null;
  let owners = 0, off: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let lastUnknownRefresh = -Infinity;
  let statsInterval = 0;
  let documentVisible = true, countersVisible = true;
  let mainCountersVisible = true, visibleCounterOwners = 0;
  let lastStatsPublication = -Infinity;
  let delayedStats: DownloadStats[] | null = null;
  let statsTimer: ReturnType<typeof setTimeout> | undefined;

  function publish(downloads: Download[], statsById: Map<string, DownloadStats>, loaded: boolean) {
    const prev = store.getState();
    if (downloads === prev.downloads && statsById === prev.statsById && loaded === prev.loaded) return;
    const byId = downloads === prev.downloads ? prev.byId : new Map(downloads.map(d => [d.id, d]));
    const counts = { ...emptyCounts, all: downloads.length }, totals = { ...emptyTotals };
    for (const d of downloads) {
      if (d.status === 'downloading' || d.status === 'queued') counts.downloading++;
      if (d.status === 'completed' || d.status === 'seeding') counts.completed++;
      if (d.status === 'seeding') counts.seeding++;
      if (d.status === 'paused') counts.paused++;
      if (d.status === 'error') counts.error++;
      const s = statsById.get(d.id);
      totals.downloaded += s?.downloadedBytes ?? d.downloadedBytes;
      totals.uploaded += s?.uploadedBytes ?? d.uploadedBytes;
    }
    for (const s of statsById.values()) {
      if (s.status === 'downloading') totals.active++;
      totals.downSpeed += s.downSpeedBps; totals.upSpeed += s.upSpeedBps; totals.peers += s.peers;
    }
    store.setState({ downloads, byId, statsById, loaded,
      counts: same(counts, prev.counts) ? prev.counts : counts,
      totals: same(totals, prev.totals) ? prev.totals : totals });
  }

  function applyStats(snapshot: DownloadStats[]) {
    const prev = store.getState(), next = new Map<string, DownloadStats>();
    let changed = false, statusChanged = false, unknown = false;
    for (const s of snapshot) {
      if (s.status === 'removed') { if (prev.byId.has(s.id)) unknown = true; continue; }
      if (prev.loaded && !prev.byId.has(s.id)) { unknown = true; continue; }
      const old = prev.statsById.get(s.id);
      const stable = old && sameStats(old, s) ? old : s;
      next.set(s.id, stable); if (stable !== old) changed = true;
    }
    changed ||= next.size !== prev.statsById.size;
    let downloads = prev.downloads;
    for (let i = 0; i < prev.downloads.length; i++) {
      const d = prev.downloads[i];
      const s = next.get(d.id);
      if (s && (s.status !== d.status || (s.progress >= 1) !== (d.progress >= 1))) {
        if (!statusChanged) downloads = prev.downloads.slice();
        statusChanged = true; downloads[i] = { ...d, status: s.status, progress: s.progress };
      }
    }
    if (changed || statusChanged) {
      lastStatsPublication = Date.now();
      publish(statusChanged ? downloads : prev.downloads, changed ? next : prev.statsById, prev.loaded);
    }
    if (unknown && Date.now() - lastUnknownRefresh >= 5000) {
      lastUnknownRefresh = Date.now();
      void refresh().catch(error => console.error('Failed to refresh new downloads:', error));
    }
  }

  function flushStats(): void {
    clearTimeout(statsTimer); statsTimer = undefined;
    if (!countersVisible) return;
    const snapshot = delayedStats; delayedStats = null;
    if (snapshot) applyStats(snapshot);
  }
  function urgentStats(snapshot: DownloadStats[]): boolean {
    const prev = store.getState();
    if (!prev.loaded) return true;
    let count = 0;
    for (const s of snapshot) {
      if (s.status === 'removed') {
        if (prev.statsById.has(s.id) || (prev.byId.has(s.id) && Date.now() - lastUnknownRefresh >= 5000)) return true;
        continue;
      }
      // An engine can announce an id before its metadata is available. Discover
      // it at the bounded cadence, rather than making every hidden tick urgent.
      if (!prev.byId.has(s.id)) { if (Date.now() - lastUnknownRefresh >= 5000) return true; continue; }
      count++;
      const old = prev.statsById.get(s.id);
      if (!old || old.status !== s.status || (old.progress >= 1) !== (s.progress >= 1)
        || old.operation?.stage !== s.operation?.stage || old.operation?.status !== s.operation?.status
        || old.operation?.waitingFor !== s.operation?.waitingFor || !same(old.operation?.actions, s.operation?.actions)
        || !same(old.operation?.lastResult, s.operation?.lastResult)) return true;
    }
    return count !== prev.statsById.size;
  }
  function receiveStats(snapshot: DownloadStats[]): void {
    statsRevision++;
    const elapsed = Math.max(0, Date.now() - lastStatsPublication);
    if ((countersVisible && (!statsInterval || elapsed >= statsInterval)) || urgentStats(snapshot)) {
      clearTimeout(statsTimer); statsTimer = undefined; delayedStats = null;
      applyStats(snapshot); return;
    }
    delayedStats = snapshot;
    if (countersVisible) statsTimer ??= setTimeout(flushStats, statsInterval - elapsed);
  }
  function setStatsInterval(interval: number): void {
    if (!Number.isFinite(interval) || interval < 0 || interval > 5000) throw Error('Invalid UI statistics interval');
    if (statsInterval === interval) return;
    statsInterval = interval; flushStats();
  }

  function restartPolling(): void {
    clearInterval(timer); timer = undefined;
    if (owners && (documentVisible || visibleCounterOwners > 0)) timer = setInterval(() => {
      void refresh().catch(error => console.error('Failed to refresh downloads:', error));
    }, 5000);
  }
  /** Keep the shared critical-event subscription; only defer optional UI work. */
  function setActivity(visible: boolean, showCounters = visible): void {
    const resumed = !documentVisible && visible;
    documentVisible = visible; mainCountersVisible = showCounters;
    reconcileActivity(resumed);
  }
  function reconcileActivity(resumed = false): void {
    const next = (documentVisible && mainCountersVisible) || visibleCounterOwners > 0;
    resumed ||= !countersVisible && next;
    countersVisible = next;
    flushStats(); // Clears a queued timer on hide, retains only its latest snapshot.
    restartPolling();
    if (resumed && owners) {
      // A pull started before the window returned is not a fresh snapshot.
      mutationRevision++;
      void refresh().catch(error => console.error('Failed to resume downloads:', error));
    }
  }
  /** A visible detached player needs source counters even when the shell rests. */
  function retainVisibleCounters(): () => void {
    visibleCounterOwners++; reconcileActivity();
    let released = false;
    return () => {
      if (released) return; released = true;
      visibleCounterOwners--; reconcileActivity();
    };
  }

  function refresh(): Promise<void> {
    flushStats();
    if (pending) return pending;
    pending = (async () => {
      // A local mutation or visibility resumption invalidates an older pull. Repeat
      // once against the current main state rather than resurrecting old rows.
      let mutationAtStart: number;
      do {
        mutationAtStart = mutationRevision;
        const statsAtStart = statsRevision;
        const list = await api().getDownloads();
        if (store.getState().availability !== 'ready') store.setState({ availability: 'ready' });
        if (mutationAtStart !== mutationRevision) continue;
        flushStats();
        const prev = store.getState(), stats = new Map(prev.statsById), live = new Set<string>();
        let changed = false, statsChanged = false;
        const downloads = list.filter(d => d.status !== 'removed').map(d => {
          live.add(d.id);
          const s = stats.get(d.id);
          // DB progress is persisted less often than live stats. Keep the live
          // values for the same activity, including pushes received BEFORE the
          // pull began. A newer push also wins a race with an older DB status.
          if (s && (statsRevision > statsAtStart || s.status === d.status)) d = { ...d, ...s };
          else if (s && s.status !== d.status) { stats.set(d.id, { ...s, status: d.status }); statsChanged = true; }
          const old = prev.byId.get(d.id);
          if (old && same(old, d)) return old;
          changed = true; return d;
        });
        for (const id of stats.keys()) if (!live.has(id)) { stats.delete(id); statsChanged = true; }
        changed ||= downloads.length !== prev.downloads.length || downloads.some((d, i) => d !== prev.downloads[i]);
        publish(changed ? downloads : prev.downloads, statsChanged ? stats : prev.statsById, true);
      } while (mutationAtStart !== mutationRevision);
    })().catch(error => { if (store.getState().availability !== 'unavailable') store.setState({ availability: 'unavailable' }); throw error; }).finally(() => { pending = null; });
    return pending;
  }

  function updateDownloads(update: (downloads: Download[]) => Download[]) {
    flushStats();
    mutationRevision++;
    const prev = store.getState(), downloads = update(prev.downloads), stats = new Map(prev.statsById);
    const live = new Map(downloads.map(d => [d.id, d]));
    for (const id of stats.keys()) if (live.get(id) !== prev.byId.get(id)) stats.delete(id);
    publish(downloads, stats, prev.loaded);
  }

  function retain() {
    if (owners++ === 0) {
      off = api().onDownloadStats(receiveStats);
      void refresh().catch(error => console.error('Failed to load downloads:', error));
      restartPolling();
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      if (--owners === 0) {
        off?.(); off = undefined; clearInterval(timer); timer = undefined;
        clearTimeout(statsTimer); statsTimer = undefined; delayedStats = null;
      }
    };
  }
  return { store, refresh, receiveStats, updateDownloads, retain, setStatsInterval, setActivity, retainVisibleCounters };
}
