import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { beginWatch, beginPlaybackWatch, cancelPlaybackWatch, applyExternalWatch, saveWatch, watchEntries, changeWatch, clearWatchHistory, migrateWatchHistory, subscribeWatchHistory, WATCH_HISTORY_KEY } from './watchHistory';
import { watchKey, resumablePosition, normalizeWatchEntry, type WatchEntry } from '../../shared/watch-history';
import type { Download } from '../../shared/types';
import { receiveExternalWatch } from './externalWatch';
import type { ExternalPlayerApi } from '../../shared/external-player';
let storage: Map<string, string>;
const entry = (path = 'Series/S01E01.mp4'): WatchEntry => ({ identity: 'hash', downloadId: 'one', title: 'Series', path, fileIndex: 0,
  position: 42, duration: 1000, lastOpened: 100, updatedAt: 100, completed: false, tracks: { audio: 'descriptor', subtitle: 'off', at: 100 } });
beforeEach(() => {
  storage = new Map(); vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());
it('external updates survive reload, preserve track choices, and cannot resurrect cleared or removed history', () => {
  const a = entry(), builtin = beginPlaybackWatch(a.identity, a.path)!; saveWatch(a, builtin);
  const external = beginPlaybackWatch(a.identity, a.path)!;
  expect(applyExternalWatch({ id: 'one', session: external, entry: { ...a, tracks: undefined, position: 155, updatedAt: 200 } })).toBe(true);
  expect(watchEntries()[0]).toMatchObject({ position: 155, tracks: a.tracks });
  saveWatch({ ...a, updatedAt: 300 }, builtin); expect(watchEntries()[0].position).toBe(155);
  expect(applyExternalWatch({ id: 'old', session: external, entry: { ...a, position: 88, updatedAt: 180 } })).toBe(true);
  expect(watchEntries()[0].position).toBe(155);
  changeWatch(watchEntries()[0], 'remove'); applyExternalWatch({ id: 'late', session: external, entry: { ...a, updatedAt: 400 } }); expect(watchEntries()).toEqual([]);
  const next = beginPlaybackWatch(a.identity, a.path)!; clearWatchHistory(); applyExternalWatch({ id: 'late2', session: next, entry: a }); expect(watchEntries()).toEqual([]);
});
it('failed handoff restores the builtin session; quota errors keep updates pending', () => {
  const a = entry(), builtin = beginPlaybackWatch(a.identity, a.path)!;
  const external = beginPlaybackWatch(a.identity, a.path)!; cancelPlaybackWatch(external);
  expect(saveWatch(a, builtin)).toBe(true);
  const next = beginPlaybackWatch(a.identity, a.path)!;
  expect(next.revision).toBeGreaterThan(external.revision);
  applyExternalWatch({ id: 'failed-launch', session: external, entry: { ...a, position: 999, updatedAt: 250 } });
  expect(watchEntries()[0].position).toBe(a.position);
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: () => { throw Error('quota'); } });
  expect(applyExternalWatch({ id: 'retry', session: next, entry: { ...a, updatedAt: 200 } })).toBe(false);
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('disabled'); } });
  expect(applyExternalWatch({ id: 'unreadable', session: next, entry: a })).toBe(false);
});
it('the app receiver persists updates after navigation/reload and stops polling on unmount', async () => {
  const a = entry(), session = beginPlaybackWatch(a.identity, a.path)!;
  const updates = vi.fn(async () => [{ id: 'snapshot', entry: a, session }]), ack = vi.fn(async () => {});
  const stop = receiveExternalWatch({ watchUpdates: updates, acknowledgeWatch: ack } as unknown as ExternalPlayerApi);
  await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(['snapshot'])); expect(watchEntries()[0].position).toBe(42); stop();
  const count = updates.mock.calls.length; await new Promise(r => setTimeout(r, 1100)); expect(updates).toHaveBeenCalledTimes(count);
  // Reload of the consumer acknowledges already persisted samples without dropping newer ones.
  const stopAgain = receiveExternalWatch({ watchUpdates: updates, acknowledgeWatch: ack } as unknown as ExternalPlayerApi);
  await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2)); stopAgain(); expect(watchEntries()).toHaveLength(1);
});
it('keeps identity across a new download id, display name, file index and directory', () => {
  const a = entry(), session = beginWatch(a.identity, a.path); saveWatch(a, session);
  saveWatch({ ...a, downloadId: 'readded', title: 'Renamed', fileIndex: 7, position: 55 }, session);
  expect(watchEntries()).toHaveLength(1); expect(watchEntries()[0]).toMatchObject({ position: 55, title: 'Renamed', tracks: a.tracks });
  expect(watchKey({ ...a, path: 'Series\\S01E01.mp4' })).toBe(watchKey(a));
  expect(watchKey({ ...a, path: 'Series/S02E01.mp4' })).not.toBe(watchKey(a));
});
it('invalidates stale player flushes after remove, watched and clear without losing unrelated films', () => {
  const a = entry(), b = entry('Other.mp4'), session = beginWatch(a.identity, a.path);
  saveWatch(a, session); saveWatch(b, beginWatch(b.identity, b.path)); changeWatch(a, 'remove'); saveWatch({ ...a, position: 60 }, session);
  expect(watchEntries().map(e => e.path)).toEqual([b.path]);
  const newer = beginWatch(a.identity, a.path); saveWatch(a, newer); changeWatch(a, 'watched'); saveWatch(a, newer);
  expect(watchEntries().find(e => e.path === a.path)?.completed).toBe(true);
  clearWatchHistory(); saveWatch(a, newer); expect(watchEntries()).toEqual([]);
});
it('starts watched entries from zero and retains unknown-duration transcode positions', () => {
  expect(resumablePosition({ ...entry(), completed: true })).toBe(0);
  expect(resumablePosition({ ...entry(), duration: null, position: 333 })).toBe(333);
  expect(resumablePosition({ ...entry(), position: 960 })).toBe(0);
  changeWatch(entry(), 'start'); expect(watchEntries()[0]).toMatchObject({ position: 0, completed: false });
});
it('migrates once; preserves unresolved metadata; clear does not reimport old positions', async () => {
  storage.set('playPositions', JSON.stringify({ 'hash:2': { t: 123, d: 1800, at: 88 }, 'unknown:0': { t: 55, d: 600, at: 50 }, 'hash:NaN': { t: 1, d: 10, at: 1 }, bad: { t: -3 } }));
  const dl = { id: 'one', infoHash: 'hash', name: 'Series', status: 'paused' } as Download;
  const unavailable = vi.fn(async () => []);
  await migrateWatchHistory([dl], unavailable); expect(watchEntries()).toEqual([]); expect(storage.has('playPositions')).toBe(false);
  const files = vi.fn(async () => [{ name: 'S01E03.mp4', path: 'Series/S01E03.mp4', index: 2, length: 10, downloaded: 10, progress: 1 }]);
  await migrateWatchHistory([dl], files); expect(watchEntries()[0]).toMatchObject({ position: 123, duration: 1800, fileIndex: 2 });
  await migrateWatchHistory([dl], files); expect(watchEntries()).toHaveLength(1);
  changeWatch(watchEntries()[0], 'remove'); await migrateWatchHistory([dl], files); expect(watchEntries()).toEqual([]);
  clearWatchHistory(); storage.set('playPositions', JSON.stringify({ 'hash:2': { t: 500, d: 1800, at: 88 } }));
  await migrateWatchHistory([dl], files); expect(watchEntries()).toEqual([]);
});
it('does not resurrect entries when clear runs while migration awaits metadata', async () => {
  storage.set('playPositions', JSON.stringify({ 'hash:0': { t: 55, d: 600, at: 50 } }));
  let done!: (files: []) => void;
  const pending = migrateWatchHistory([{ id: 'one', infoHash: 'hash', status: 'paused' } as Download], () => new Promise(resolve => { done = resolve; }));
  clearWatchHistory(); done([]); await pending; expect(watchEntries()).toEqual([]);
});
it('recovers from corrupt data, bounds history and tolerates quota errors', async () => {
  storage.set(WATCH_HISTORY_KEY, '{broken'); storage.set('playPositions', '[1,2]');
  await migrateWatchHistory([], async () => []); expect(watchEntries()).toEqual([]);
  for (let i = 0; i < 210; i++) { const e = { ...entry('film' + i), updatedAt: i }; saveWatch(e, beginWatch(e.identity, e.path)); }
  expect(watchEntries()).toHaveLength(200);
  expect(normalizeWatchEntry({ ...entry(), lastOpened: 1e99 })).toBeNull();
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('disabled'); }, setItem: () => { throw Error('quota'); } });
  expect(() => saveWatch(entry(), beginWatch('hash', entry().path))).not.toThrow();
});
it('broadcasts local changes and storage events and cleans subscriptions', () => {
  const fn = vi.fn(), unsubscribe = subscribeWatchHistory(fn); saveWatch(entry(), beginWatch('hash', entry().path)); expect(fn).toHaveBeenCalledTimes(1);
  const event = new Event('storage'); Object.assign(event, { key: WATCH_HISTORY_KEY }); window.dispatchEvent(event); expect(fn).toHaveBeenCalledTimes(2);
  unsubscribe(); changeWatch(entry(), 'remove'); window.dispatchEvent(event); expect(fn).toHaveBeenCalledTimes(2);
});
