import { describe, expect, it } from 'vitest';
import { RoomStateEncoder, RoomStateDecoder, type RoomStatePacket } from './room-state-ipc';
import type { RoomState } from './types';

const fixture = (): RoomState => ({
  roomId: 'a', name: 'Room', files: Array.from({ length: 1000 }, (_, i) => ({ fileId: String(i), name: `file-${i}`, magnet: 'm'.repeat(250), size: i })),
  members: [{ memberId: 'self', have: ['1', '2'], lastSeen: 1 }],
  chat: Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: 'body'.repeat(100), at: i })),
  history: [{ id: 'event', at: 1 }], folders: [{ id: 'folder', name: 'Folder' }],
  transfers: { '1': { progress: 0.1, haveLocally: false } }, voice: { participants: [], inVoice: false },
  lan: { participants: [], active: false }, peerCount: 1, chatEdits: { old: { text: 'edit', at: 1 } },
} as unknown as RoomState);
const transport = (packet: RoomStatePacket | undefined) => structuredClone(packet!);

describe('room IPC deltas', () => {
  it('sends tiny progress/presence deltas and preserves unchanged collection references', () => {
    const encoder = new RoomStateEncoder(), decoder = new RoomStateDecoder(), input = fixture();
    const full = transport(encoder.encode(input)), first = decoder.accept(full)!;
    input.transfers['1'].progress = 0.2; input.members[0].lastSeen = 2;
    const delta = transport(encoder.encode(input)), next = decoder.accept(delta)!;
    expect(next).toEqual(input); expect(next.files).toBe(first.files); expect(next.chat).toBe(first.chat);
    expect(next.members[0].have).toBe(first.members[0].have);
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(full).length / 100);
    expect(encoder.encode(input)).toBeUndefined();
  });

  it('handles in-place edits, insertion, deletion, reordering and optional-field removal', () => {
    const encoder = new RoomStateEncoder(), decoder = new RoomStateDecoder(), input = fixture();
    decoder.accept(transport(encoder.encode(input)));
    input.files[0].name = 'renamed'; input.files.splice(1, 1); input.files.reverse();
    input.chat.push({ ...input.chat[0], id: 'new', text: 'new body' }); input.chat.shift();
    input.folders = []; input.history = []; delete input.chatEdits;
    delete input.transfers['1']; input.transfers['3'] = { progress: 0.5 } as RoomState['transfers'][string];
    input.lan.active = true;
    expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
    input.files = []; input.members = []; input.chat = []; delete input.folders;
    expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
  });

  it('requires a baseline, rejects gaps/duplicates and recovers through a fresh full snapshot', () => {
    const encoder = new RoomStateEncoder(), decoder = new RoomStateDecoder(), input = fixture();
    const full = transport(encoder.encode(input));
    input.peerCount = 2; const skipped = transport(encoder.encode(input));
    input.peerCount = 3; const gap = transport(encoder.encode(input));
    expect(decoder.accept(skipped)).toBeUndefined(); decoder.accept(full);
    expect(decoder.accept(gap)).toBeUndefined();
    expect(decoder.accept(transport(encoder.encode(input, true)))).toEqual(input);
    expect(decoder.accept(gap)).toBeUndefined();
    input.peerCount = 4; expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
    decoder.delete(input.roomId); input.peerCount = 5;
    expect(decoder.accept(transport(encoder.encode(input)))).toBeUndefined();
    expect(decoder.accept(transport(new RoomStateEncoder().encode(input)))).toEqual(input);
  });

  it('falls back to replacement for unkeyed or duplicate-key arrays', () => {
    const input = fixture(), encoder = new RoomStateEncoder(), decoder = new RoomStateDecoder();
    decoder.accept(transport(encoder.encode(input)));
    input.typingMemberIds = ['a', 'b']; input.files.push(input.files[0]);
    expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
    input.typingMemberIds.reverse(); input.members[0].have!.push('3');
    expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
  });

  it('keeps room streams independent and rejects malformed collection patches without losing the baseline', () => {
    const input = fixture(), encoder = new RoomStateEncoder(), decoder = new RoomStateDecoder();
    const full = transport(encoder.encode(input)); decoder.accept(full);
    const bad: RoomStatePacket = { roomId: input.roomId, stream: full.stream, revision: 2, base: 1,
      patch: { fields: { files: { key: 'fileId', entries: {}, order: ['absent'] } } } };
    expect(decoder.accept(bad)).toBeUndefined();
    input.peerCount = 9; expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
    const other = { ...fixture(), roomId: 'b' }; decoder.accept(transport(new RoomStateEncoder().encode(other)));
    decoder.delete('b'); input.peerCount = 10;
    expect(decoder.accept(transport(encoder.encode(input)))).toEqual(input);
  });
});
