import type { RoomChatMessage, RoomEvent } from './types';

export const ROOM_LOCAL_HISTORY_LIMIT = 5000;
export const ROOM_LOCAL_HISTORY_PAGE = 50;
export const ROOM_HISTORY_DAYS = [7, 30, 90, 365, 0] as const;
export type RoomHistoryDays = typeof ROOM_HISTORY_DAYS[number];
export interface RoomHistoryPage {
  items: Array<{ kind: 'chat'; message: RoomChatMessage } | { kind: 'event'; event: RoomEvent }>;
  next?: string;
  cursorExpired: boolean;
  retentionDays: RoomHistoryDays;
}
export interface RoomDiskUsage {
  previewId: string;
  plaintext: number;
  ciphertext: number;
  originals: number;
  protectedCiphertext: number;
  untrackedBytes: number;
  removable: number;
  files: Array<{ fileId: string; name: string; plaintext: number; ciphertext: number; removable: number; original: boolean }>;
  skipped: number;
}
export function historyDays(value: unknown): RoomHistoryDays {
  if (!ROOM_HISTORY_DAYS.includes(value as RoomHistoryDays)) throw new Error('Invalid room history retention');
  return value as RoomHistoryDays;
}
export function retainLocalHistory<T>(list: T[], days: RoomHistoryDays, time: (item: T) => number, now = Date.now()): T[] {
  const cutoff = days ? now - days * 86400000 : 0;
  return list.filter(item => time(item) >= cutoff).slice(-ROOM_LOCAL_HISTORY_LIMIT);
}
export function localHistoryPage<T extends { id: string }>(items: T[], before?: string): { items: T[]; next?: string; cursorExpired: boolean } {
  if (before !== undefined && (typeof before !== 'string' || before.length > 256)) throw new Error('Invalid history cursor');
  const index = before ? items.findIndex(item => item.id === before) : items.length;
  if (index < 0) return { items: [], cursorExpired: true };
  const start = Math.max(0, index - ROOM_LOCAL_HISTORY_PAGE);
  return { items: items.slice(start, index), next: start > 0 ? items[start].id : undefined, cursorExpired: false };
}
