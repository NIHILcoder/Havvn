import type { RoomChatDraft } from './types';

export function normalizeRoomChatDraft(raw: RoomChatDraft): RoomChatDraft {
  const text = (value: unknown, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
  const id = (value: unknown) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) ? value : undefined;
  const reply = (value: RoomChatDraft['reply']) => value && id(value.id)
    ? { id: value.id, name: text(value.name, 256), text: text(value.text, 140) } : undefined;
  const messageId = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
  return { text: text(raw?.text), reply: reply(raw?.reply), editId: id(raw?.editId), messageId: messageId(raw?.messageId),
    ...(raw?.compose ? { compose: { text: text(raw.compose.text), reply: reply(raw.compose.reply), messageId: messageId(raw.compose.messageId) } } : {}) };
}

/** Match the limiter's byte conversion while excluding NaN/Infinity and overflow. */
export function normalizeRoomRate(value: unknown): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000) throw new Error('Invalid room speed limit');
  return Math.floor(rate);
}
