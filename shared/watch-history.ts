import { playerFileKey, type FileTrackChoice } from './player-preferences';
export interface WatchEntry {
  identity: string;
  downloadId: string;
  title: string;
  path: string;
  fileIndex: number;
  position: number;
  duration: number | null;
  lastOpened: number;
  updatedAt: number;
  completed: boolean;
  tracks?: FileTrackChoice;
  nextPath?: string;
}
export interface WatchSession { key: string; epoch: number; revision: number }
export type WatchTarget = Pick<WatchEntry, 'identity' | 'downloadId' | 'title' | 'path' | 'fileIndex'>;
export interface ExternalWatchUpdate { id: string; entry: WatchEntry; session: WatchSession }
export function validWatchSession(value: unknown): value is WatchSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as WatchSession;
  return typeof s.key === 'string' && s.key.length <= 9000 &&
    Number.isSafeInteger(s.epoch) && s.epoch >= 0 && Number.isSafeInteger(s.revision) && s.revision >= 0;
}
export const watchKey = (entry: Pick<WatchEntry, 'identity' | 'path'>): string => playerFileKey(entry.identity, entry.path);
export function normalizeWatchEntry(value: unknown): WatchEntry | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as WatchEntry;
  if (![e.identity, e.downloadId, e.title, e.path].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096) ||
      !Number.isInteger(e.fileIndex) || e.fileIndex < 0 || !Number.isFinite(e.position) || e.position < 0 ||
      !Number.isFinite(e.lastOpened) || e.lastOpened < 0 || e.lastOpened > 8.64e15 || !Number.isFinite(e.updatedAt) || e.updatedAt < 0 || e.updatedAt > 8.64e15) return null;
  const duration = typeof e.duration === 'number' && Number.isFinite(e.duration) && e.duration > 0 ? e.duration : null;
  return { ...e, path: e.path.replace(/\\/g, '/'), duration, position: duration ? Math.min(e.position, duration) : e.position, completed: e.completed === true };
}
export function resumablePosition(e: WatchEntry | undefined): number {
  return e && !e.completed && e.position >= 5 && (!e.duration || e.position < e.duration * 0.95) ? e.position : 0;
}
