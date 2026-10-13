import type { RoomChatMessage } from './types';

export type RoomNotifyMode = 'all' | 'mentions' | 'off';
export function roomNotifyMode(pref: { notifyMode?: RoomNotifyMode; notifyMuted?: boolean }): RoomNotifyMode {
  return pref.notifyMode && ['all', 'mentions', 'off'].includes(pref.notifyMode) ? pref.notifyMode : pref.notifyMuted ? 'off' : 'all';
}
/** Explicit @name, including spaces and Unicode, outside code blocks and URLs. */
export function hasRoomMention(text: string, name: string): boolean {
  return roomMentionRanges(text, name).length > 0;
}
export function roomMentionRanges(text: string, name: string): Array<{ start: number; end: number }> {
  const clean = name.trim();
  if (!clean) return [];
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plain = text.replace(/```[\s\S]*?(?:```|$)|`[^`]*`|https?:\/\/\S+/g, match => ' '.repeat(match.length));
  const regex = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu');
  return [...plain.matchAll(regex)].map(match => ({ start: match.index! + match[1].length, end: match.index! + match[0].length }));
}
export type FileRequestStatus = 'open' | 'fulfilled' | 'cancelled';
export interface RoomFileRequest { title: string; status: FileRequestStatus; fileIds: string[] }
const REQUEST_PREFIX = '🙋 havvn-request-v1 ';
export function fileRequestText(request: RoomFileRequest): string {
  return REQUEST_PREFIX + JSON.stringify({ title: request.title.trim().slice(0, 500), status: request.status, fileIds: request.fileIds.slice(0, 5) });
}
export function parseFileRequest(text: string): RoomFileRequest | undefined {
  if (!text.startsWith('🙋')) return;
  if (!text.startsWith(REQUEST_PREFIX)) return { title: text.replace(/^🙋\s*/, '').slice(0, 500), status: 'open', fileIds: [] };
  try {
    const r = JSON.parse(text.slice(REQUEST_PREFIX.length));
    if (!r || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 500
      || !['open', 'fulfilled', 'cancelled'].includes(r.status) || !Array.isArray(r.fileIds) || r.fileIds.length > 5
      || r.fileIds.some((id: unknown) => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id as string))) return;
    return { title: r.title, status: r.status, fileIds: [...new Set<string>(r.fileIds)] };
  } catch { return; }
}
export interface RoomChatFilter { query: string; author: string; kind: 'all' | 'links' | 'requests' | 'mentions'; after: string; before: string }
export const EMPTY_CHAT_FILTER: RoomChatFilter = { query: '', author: '', kind: 'all', after: '', before: '' };
export interface RoomChatSearchPage { messages: RoomChatMessage[]; edits: Record<string, { text: string; at: number }>; next?: string }
export function validateChatFilter(value: unknown): asserts value is RoomChatFilter {
  const f = value as RoomChatFilter | undefined;
  const date = (v: unknown) => typeof v === 'string' && (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(new Date(v + 'T00:00:00Z').getTime()) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v);
  if (!f || typeof f.query !== 'string' || f.query.length > 200 || typeof f.author !== 'string' || !/^[\w-]{0,128}$/.test(f.author)
    || !['all', 'links', 'requests', 'mentions'].includes(f.kind) || !date(f.after) || !date(f.before)) throw new Error('Invalid chat search');
}
export function chatFilterActive(f: RoomChatFilter): boolean { return !!(f.query.trim() || f.author || f.kind !== 'all' || f.after || f.before); }
export function matchesChatFilter(m: RoomChatMessage, body: string, f: RoomChatFilter, selfName = ''): boolean {
  const request = parseFileRequest(body), visible = request?.title ?? body;
  const q = f.query.trim().toLocaleLowerCase();
  if (q && !visible.toLocaleLowerCase().includes(q) && !m.name.toLocaleLowerCase().includes(q)) return false;
  if (f.author && m.memberId !== f.author) return false;
  if (f.kind === 'links' && !/https?:\/\/\S+/i.test(body) || f.kind === 'requests' && !request
    || f.kind === 'mentions' && !hasRoomMention(visible, selfName)) return false;
  if (f.after && m.at < new Date(f.after + 'T00:00:00').getTime()) return false;
  if (f.before) { const end = new Date(f.before + 'T00:00:00'); end.setDate(end.getDate() + 1); if (m.at >= end.getTime()) return false; }
  return true;
}
export function firstUnreadMessage(messages: RoomChatMessage[], lastRead: number, selfId?: string): RoomChatMessage | undefined {
  return messages.find(m => m.memberId !== selfId && (m.receivedAt ?? m.at) > lastRead);
}
