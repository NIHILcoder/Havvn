import { chatEnvelope, validChatTime } from './room-chat-history';
import type { RoomChatMessage } from './types';

export const ROOM_PIN_LIMIT = 10;
export interface RoomChatPin {
  message: RoomChatMessage;
  topic: string;
  edit?: { text: string; at: number; by: string; pub: string; sig: string; topic: string };
}
export interface RoomChatPins {
  t: 'chat-pins-v1'; by: string; ownerAt: number; at: number; pub: string; sig: string; items: RoomChatPin[];
  signedTopic?: string; // local persistence only
}
const str = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export function validChatPins(value: unknown): value is RoomChatPins {
  if (!value || typeof value !== 'object') return false;
  const p = value as RoomChatPins;
  return p.t === 'chat-pins-v1' && str(p.by, 128) && Number.isSafeInteger(p.ownerAt) && p.ownerAt >= 0
    && validChatTime(p.at) && p.at > 0 && str(p.pub, 2048) && str(p.sig)
    && Array.isArray(p.items) && p.items.length <= ROOM_PIN_LIMIT
    && p.items.every(i => i && str(i.topic, 128) && !!chatEnvelope(i.message) && str(i.message.pub, 2048) && str(i.message.sig)
      && (!i.edit || str(i.edit.text, 2000) && validChatTime(i.edit.at) && str(i.edit.by, 128)
        && i.edit.by === i.message.memberId && str(i.edit.pub, 2048) && str(i.edit.sig) && str(i.edit.topic, 128)))
    && new Set(p.items.map(i => i.message.id)).size === p.items.length;
}
/** Local clocks/extension fields never become signed or cross the wire. */
export function cleanChatPin(i: RoomChatPin): RoomChatPin {
  return { topic: i.topic, message: chatEnvelope(i.message)!, ...(i.edit ? { edit: {
    text: i.edit.text, at: i.edit.at, by: i.edit.by, pub: i.edit.pub, sig: i.edit.sig, topic: i.edit.topic,
  } } : {}) };
}
export function chatPinsCanonical(topic: string, p: Pick<RoomChatPins, 'by' | 'ownerAt' | 'at' | 'items'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['chat-pins-v1', topic, p.by, p.ownerAt, p.at, p.items.map(cleanChatPin)]));
}
export function newerChatPins(next: RoomChatPins, old: RoomChatPins | undefined, ownerId: string, ownerAt: number, now = Date.now()): boolean {
  if (!validChatPins(next) || next.by !== ownerId || next.ownerAt !== ownerAt || next.at > now + 60_000) return false;
  return !old || old.by !== ownerId || old.ownerAt !== ownerAt || next.at > old.at || next.at === old.at && next.sig > old.sig;
}
