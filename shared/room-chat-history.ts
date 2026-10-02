import type { RoomChatMessage } from './types';

/** One bounded window, everywhere. Arrival order, never a remote clock cursor. */
export const ROOM_CHAT_LIMIT = 200;
export const ROOM_CHAT_PAGE_SIZE = 50;
export const ROOM_CHAT_ID_LIMIT = 128;

export function chatIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, ROOM_CHAT_LIMIT).filter((id): id is string =>
    typeof id === 'string' && /^[\w-]{1,128}$/.test(id)))];
}
export function validChatTime(at: unknown): at is number {
  return typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8_640_000_000_000_000;
}

/** Parse both versions before verification. No local receipt metadata on wire. */
export function chatEnvelope(raw: unknown): RoomChatMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const string = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : '';
  const id = string(m.id, ROOM_CHAT_ID_LIMIT), memberId = string(m.memberId, ROOM_CHAT_ID_LIMIT);
  const text = string(m.text, 2000), pub = string(m.pub, 2048), sig = string(m.sig, 1024);
  if (!/^[\w-]{1,128}$/.test(id) || !memberId || !text.trim() || !validChatTime(m.at)) return null;
  if (m.chatV !== undefined && m.chatV !== 2) return null;
  if (m.contextSig !== undefined && m.chatV !== 2) return null;
  const contextSig = string(m.contextSig, 1024);
  if (m.chatV === 2 && (!contextSig || (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !/^[\w-]{1,128}$/.test(m.replyTo)))
    || (m.replyName !== undefined && (typeof m.replyName !== 'string' || m.replyName.length > 256))
    || (m.replyText !== undefined && (typeof m.replyText !== 'string' || m.replyText.length > 140))
    || (!m.replyTo && (m.replyName !== undefined || m.replyText !== undefined)))) return null;
  const replyTo = string(m.replyTo, ROOM_CHAT_ID_LIMIT);
  return { id, at: m.at, memberId, text, pub, sig,
    name: typeof m.name === 'string' ? m.name.slice(0, 256) : '?',
    avatarSeed: typeof m.avatarSeed === 'string' ? m.avatarSeed.slice(0, 256) : memberId,
    ...(replyTo ? { replyTo, replyName: typeof m.replyName === 'string' ? m.replyName.slice(0, 256) : '', replyText: typeof m.replyText === 'string' ? m.replyText.slice(0, 140) : '' } : {}),
    ...(m.chatV === 2 ? { chatV: 2, contextSig } : {}),
  };
}

/** A legacy relay can strip v2 fields; accept the authenticated upgrade later. */
export function upgradeChat(existing: RoomChatMessage, incoming: RoomChatMessage): RoomChatMessage | undefined {
  if (existing.chatV === 2 || incoming.chatV !== 2 || !incoming.contextSig || existing.id !== incoming.id
    || existing.memberId !== incoming.memberId || existing.at !== incoming.at || existing.text !== incoming.text
    || existing.pub !== incoming.pub || existing.sig !== incoming.sig) return;
  const body = { ...existing };
  delete body.replyTo; delete body.replyName; delete body.replyText;
  return { ...body, chatV: 2, contextSig: incoming.contextSig,
    ...(incoming.replyTo ? { replyTo: incoming.replyTo, replyName: incoming.replyName, replyText: incoming.replyText } : {}) };
}

export function retainRoomChat(messages: RoomChatMessage[]): RoomChatMessage[] {
  const byId = new Map<string, RoomChatMessage>();
  for (const m of messages) {
    if (!m?.id) continue;
    const prior = byId.get(m.id);
    if (!prior) byId.set(m.id, m);
    else { const upgrade = upgradeChat(prior, m); if (upgrade) byId.set(m.id, upgrade); }
  }
  return [...byId.values()].slice(-ROOM_CHAT_LIMIT);
}

/** Up to four bounded unicast frames. An absent inventory means legacy/all. */
export function chatBackfillPages(history: RoomChatMessage[], known?: unknown): RoomChatMessage[][] {
  const have = new Set(chatIds(known));
  const missing = retainRoomChat(history).filter(m => !have.has(m.id) && m.pub && m.sig)
    .map(chatEnvelope).filter((m): m is RoomChatMessage => m !== null);
  const pages: RoomChatMessage[][] = [];
  for (let i = 0; i < missing.length; i += ROOM_CHAT_PAGE_SIZE) pages.push(missing.slice(i, i + ROOM_CHAT_PAGE_SIZE));
  return pages;
}

export function roomChatPage(history: RoomChatMessage[], before?: string) {
  const messages = retainRoomChat(history);
  const end = before ? messages.findIndex(m => m.id === before) : messages.length;
  if (end < 0) return { messages: [] as RoomChatMessage[], hasMore: false, cursorExpired: true };
  const start = Math.max(0, end - ROOM_CHAT_PAGE_SIZE);
  return { messages: messages.slice(start, end), hasMore: start > 0, cursorExpired: false };
}
