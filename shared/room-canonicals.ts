/**
 * Byte-stable canonicals for room signatures. Guest and engine MUST produce
 * identical UTF-8. Field order is load-bearing — never reorder, never add.
 *
 * New semantics get a new type with its own domain tag (see CONVENTIONS).
 */

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function chatCanonical(topic: string, m: { id: string; at: number; memberId: string; text: string }): Uint8Array {
  return utf8(JSON.stringify([topic, m.id, m.at, m.memberId, m.text]));
}

export function editCanonical(topic: string, m: { msgId: string; memberId: string; at: number; text: string }): Uint8Array {
  return utf8(JSON.stringify(['chat-edit', topic, m.msgId, m.memberId, m.at, m.text]));
}

export function voiceStateCanonical(topic: string, m: { memberId: string; inVoice: boolean; muted: boolean; at: number }): Uint8Array {
  return utf8(JSON.stringify(['voice-state', topic, m.memberId, m.at, m.inVoice, m.muted]));
}

export function voiceSignalCanonical(topic: string, m: { memberId: string; to: string; kind: string; data: unknown }): Uint8Array {
  return utf8(JSON.stringify(['voice-signal', topic, m.memberId, m.to, m.kind, m.data]));
}

export function rekeyCanonical(topic: string, m: { newCode: string; kickedId: string; by: string }): Uint8Array {
  return utf8(JSON.stringify(['rekey', topic, m.newCode, m.kickedId, m.by]));
}

export function kickedCanonical(topic: string, m: { targetId: string; by: string }): Uint8Array {
  return utf8(JSON.stringify(['kicked', topic, m.targetId, m.by]));
}

export function renameCanonical(topic: string, m: { name: string; at: number; by: string }): Uint8Array {
  return utf8(JSON.stringify(['rename', topic, m.name, m.at, m.by]));
}

export function topicCanonical(topic: string, m: { text: string; at: number; by: string }): Uint8Array {
  return utf8(JSON.stringify(['topic', topic, m.text, m.at, m.by]));
}

export function profileCanonical(topic: string, m: {
  memberId: string; at: number; name: string; avatarSeed: string; color: string; status: string; img: string;
}): Uint8Array {
  return utf8(JSON.stringify(['profile', topic, m.memberId, m.at, m.name, m.avatarSeed, m.color, m.status, m.img]));
}
