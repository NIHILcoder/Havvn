import { normalizeWatchEntry, watchKey, validWatchSession, type WatchEntry, type ExternalWatchUpdate } from '../../shared/watch-history';
import type { Download, TorrentFile } from '../../shared/types';
import { loadFileTrackChoice } from './playerPreferences';
export const WATCH_HISTORY_KEY = 'havvn.watchHistory.v1';
const EVENT = 'havvn:watchHistory';
interface LegacyPosition { t: number; d: number; at: number }
interface Store { version: 1; epoch: number; entries: Record<string, WatchEntry>; revisions: Record<string, number>; serials: Record<string, number>; pending: Record<string, LegacyPosition>; migrated: boolean }
function read(): Store {
  const empty: Store = { version: 1, epoch: 0, entries: {}, revisions: {}, serials: {}, pending: {}, migrated: false };
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_HISTORY_KEY) || 'null');
    if (!raw || raw.version !== 1) return empty;
    const entries = Object.values(raw.entries || {}).map(normalizeWatchEntry).filter((e): e is WatchEntry => !!e);
    const counters = (value: unknown): Record<string, number> => value && typeof value === 'object' && !Array.isArray(value) ?
      Object.fromEntries(Object.entries(value).filter(([, v]) => Number.isSafeInteger(v) && (v as number) >= 0)) : {};
    return { ...empty, epoch: Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0, entries: Object.fromEntries(entries.map(e => [watchKey(e), e])),
      revisions: counters(raw.revisions), serials: counters(raw.serials), pending: validLegacy(raw.pending), migrated: raw.migrated === true };
  } catch { return empty; }
}
function validLegacy(raw: unknown): Record<string, LegacyPosition> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, value]) => {
    const p = value as LegacyPosition;
    return /:\d{1,9}$/.test(key) && p && Number.isFinite(p.t) && p.t >= 0 && Number.isFinite(p.d) && p.d > 0 && Number.isFinite(p.at) && p.at >= 0 && p.at <= 8.64e15;
  }).slice(0, 200));
}
function write(s: Store): boolean {
  try {
    s.entries = Object.fromEntries(Object.entries(s.entries).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 200));
    localStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(s)); window.dispatchEvent(new Event(EVENT)); return true;
  } catch { return false; }
}
export function watchEntries(): WatchEntry[] { return Object.values(read().entries).sort((a, b) => b.lastOpened - a.lastOpened); }
export function pendingWatchPositions(): number { return Object.keys(read().pending).length; }
export function getWatchEntry(identity: string, path: string): WatchEntry | undefined { return read().entries[watchKey({ identity, path })]; }
export function subscribeWatchHistory(fn: () => void): () => void {
  const storage = (e: StorageEvent) => { if (!e.key || e.key === WATCH_HISTORY_KEY) fn(); };
  window.addEventListener(EVENT, fn); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(EVENT, fn); window.removeEventListener('storage', storage); };
}
export function beginWatch(identity: string, path: string) {
  const s = read(), key = watchKey({ identity, path });
  return { key, epoch: s.epoch, revision: s.revisions[key] || 0 };
}
/** New playback owns the file; older players must not overwrite it on close. */
export function beginPlaybackWatch(identity: string, path: string) {
  const s = read(), key = watchKey({ identity, path });
  const previousRevision = s.revisions[key] || 0;
  s.serials[key] = Math.max(s.serials[key] || 0, previousRevision) + 1;
  s.revisions[key] = s.serials[key];
  return write(s) ? { key, epoch: s.epoch, revision: s.revisions[key], previousRevision } : null;
}
export function cancelPlaybackWatch(session: NonNullable<ReturnType<typeof beginPlaybackWatch>>): void {
  const s = read();
  if (session.epoch !== s.epoch || session.revision !== (s.revisions[session.key] || 0)) return;
  s.revisions[session.key] = session.previousRevision; write(s);
}
export function saveWatch(entry: WatchEntry, session: ReturnType<typeof beginWatch>): boolean {
  const s = read(), valid = normalizeWatchEntry(entry);
  if (!valid || watchKey(valid) !== session.key || session.epoch !== s.epoch || session.revision !== (s.revisions[session.key] || 0)) return false;
  s.entries[session.key] = valid; return write(s);
}
/** true means safely consumed (including stale updates); false retries a storage failure. */
export function applyExternalWatch(update: ExternalWatchUpdate): boolean {
  try { localStorage.getItem(WATCH_HISTORY_KEY); } catch { return false; }
  const valid = normalizeWatchEntry(update?.entry), session = update?.session;
  if (!valid || !validWatchSession(session) || session.key !== watchKey(valid)) return true;
  const s = read(), current = s.entries[session.key];
  if (session.epoch !== s.epoch || session.revision !== (s.revisions[session.key] || 0) || (current && current.updatedAt > valid.updatedAt)) return true;
  return saveWatch({ ...valid, tracks: current?.tracks, nextPath: current?.nextPath }, session);
}
export function changeWatch(entry: WatchEntry, action: 'start' | 'watched' | 'remove'): void {
  const s = read(), key = watchKey(entry); s.revisions[key] = Math.max(s.revisions[key] || 0, s.serials[key] || 0) + 1;
  s.serials[key] = s.revisions[key];
  if (action === 'remove') delete s.entries[key];
  else s.entries[key] = { ...entry, position: action === 'start' ? 0 : entry.duration || entry.position, completed: action === 'watched', updatedAt: Date.now() };
  write(s);
}
export function clearWatchHistory(): void {
  const s = read(); write({ version: 1, epoch: s.epoch + 1, entries: {}, revisions: {}, serials: {}, pending: {}, migrated: true });
  try { localStorage.removeItem('playPositions'); } catch { /* optional storage */ }
}
let migration: Promise<void> | null = null;
export function migrateWatchHistory(downloads: Download[], filesFor: (id: string) => Promise<TorrentFile[]>): Promise<void> {
  if (migration) return migration;
  migration = (async () => {
    let s = read();
    if (!s.migrated) {
      let legacy: unknown;
      try { legacy = JSON.parse(localStorage.getItem('playPositions') || '{}'); } catch { legacy = {}; }
      s.pending = validLegacy(legacy);
      s.migrated = true;
      if (!write(s)) return;
      try { localStorage.removeItem('playPositions'); } catch { /* the migration marker prevents reimport */ }
    }
    const epoch = s.epoch;
    for (const dl of downloads.filter(d => d.status !== 'removed')) {
      const prefixes = [`${dl.infoHash || dl.id}:`, `${dl.id}:`];
      const pending = Object.entries(s.pending).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix)));
      if (!pending.length) continue;
      let files: TorrentFile[]; try { files = await filesFor(dl.id); } catch { continue; }
      s = read(); if (s.epoch !== epoch) return;
      for (const [legacyKey, p] of pending) {
        if (!s.pending[legacyKey]) continue;
        const index = Number(legacyKey.slice(legacyKey.lastIndexOf(':') + 1));
        if (!Number.isInteger(index) || index < 0) { delete s.pending[legacyKey]; continue; }
        const f = files.find((f, i) => (f.index ?? i) === index); if (!f) continue;
        const identity = dl.infoHash || dl.id, key = watchKey({ identity, path: f.path || f.name });
        if (!s.entries[key] && !s.revisions[key]) s.entries[key] = { identity, downloadId: dl.id, title: dl.name, path: f.path || f.name, fileIndex: index,
          position: p.t, duration: p.d, lastOpened: p.at, updatedAt: p.at, completed: p.t >= p.d * 0.95, tracks: loadFileTrackChoice(key) };
        delete s.pending[legacyKey];
      }
      write(s);
    }
  })().finally(() => { migration = null; });
  return migration;
}
