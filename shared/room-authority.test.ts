import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { roomFileName, orderedTransferPrefix, ownerChainAnchored, ownerChainAdvances, transferCanonical, canDeleteRoomFile, canReviveRoomFile, currentRoomDeletion } from './room-authority';
import { acceptVoiceStamp, ROOM_VOICE_FLOORS } from './room-voice-policy';
import { DESKTOP_ROOM_CAPABILITIES, GUEST_ROOM_CAPABILITIES, validRoomCapabilities, readRoomCapabilities } from './room-capabilities';
import { generateIdentityWeb, signWeb, verifyWeb } from './room-web-crypto';
import { voiceStateCanonical, voiceStateV2Canonical } from './room-canonicals';

describe('shared room authority', () => {
  it('uses identical safe basenames for Node and the browser without a Node polyfill', () => {
    const names = ['movie.mkv', '../movie.mkv', '..\\movie.mkv', 'C:movie.mkv', 'C:\\folder\\movie.mkv', 'C:\\', 'C:', '//server/share/movie.mkv', 'folder/movie.mkv/', 'folder/..', '.', '..', '', 'C:folder\\..', '\\server\\share\\'];
    for (const name of names) {
      const base = path.win32.basename(name);
      expect(roomFileName(name)).toBe(base === '.' || base === '..' ? '' : base);
    }
    expect(roomFileName(null)).toBe(''); expect(roomFileName(3)).toBe('');
  });
  const a = { by: 'A', newOwnerId: 'B', at: 10, pub: 'pub', sig: 'sig' };
  const b = { ...a, by: 'B', newOwnerId: 'C', at: 20 };
  it('walks only contiguous increasing transfers and anchors root, intermediate and current pins', () => {
    const chain = [a, b];
    expect(orderedTransferPrefix([a, { ...b, by: 'X' }], 100)).toEqual([a]);
    expect(orderedTransferPrefix([a, { ...b, at: 10 }], 100)).toEqual([a]);
    expect(orderedTransferPrefix([{ ...a, at: 60101 }], 100)).toEqual([]);
    for (const pin of ['A', 'B', 'C']) expect(ownerChainAnchored({ ownerId: '', ownerPin: pin, transferChain: [] }, chain)).toBe(true);
    expect(ownerChainAnchored({ ownerId: '', ownerPin: 'X', transferChain: [] }, chain)).toBe(false);
    expect(ownerChainAnchored({ ownerId: 'X', ownerPin: '', transferChain: [] }, chain)).toBe(false);
    expect(ownerChainAdvances({ ownerId: 'C', ownerPin: 'A', transferChain: chain, transferAt: 20 }, [a])).toBe(false);
  });
  it('permits only owner/author deletion and owner/deleter revival with no timestamp-only resurrection', () => {
    expect(canDeleteRoomFile('', undefined, 'A')).toBe(false);
    expect(canDeleteRoomFile('O', 'A', 'A')).toBe(true);
    expect(canDeleteRoomFile('O', 'A', 'O')).toBe(true);
    expect(canDeleteRoomFile('O', 'A', 'X')).toBe(false);
    expect(canReviveRoomFile('O', 'D', 'A')).toBe(false);
    expect(canReviveRoomFile('O', 'D', 'D')).toBe(true);
    expect(currentRoomDeletion(20, 21, undefined, 100)).toBe(false);
    expect(currentRoomDeletion(20, 10, 20, 100)).toBe(false);
    expect(currentRoomDeletion(21, 10, 20, 100)).toBe(true);
  });
  it('preserves transfer v1 bytes and verifies the same proof in Node and WebCrypto', async () => {
    const identity = await generateIdentityWeb();
    const bytes = transferCanonical('root', a);
    expect(new TextDecoder().decode(bytes)).toBe('["th-room-transfer:v1","root","A","B",10]');
    const sig = await signWeb(identity.priv, bytes);
    expect(crypto.verify(null, bytes, identity.pub, Buffer.from(sig, 'base64'))).toBe(true);
    expect(await verifyWeb(identity.pub, transferCanonical('other-room-root', a), sig)).toBe(false);
  });
  it('binds every v2 voice field, including deafened, without changing the legacy signature', async () => {
    const identity = await generateIdentityWeb();
    const state = { memberId: identity.memberId, at: 10, inVoice: true, muted: false, deafened: true };
    const bytes = voiceStateV2Canonical('topic', state), sig = await signWeb(identity.priv, bytes);
    expect(crypto.verify(null, bytes, identity.pub, Buffer.from(sig, 'base64'))).toBe(true);
    for (const changed of [{ at: 11 }, { inVoice: false }, { muted: true }, { deafened: false }, { memberId: 'X' }]) {
      expect(await verifyWeb(identity.pub, voiceStateV2Canonical('topic', { ...state, ...changed }), sig)).toBe(false);
    }
    expect(await verifyWeb(identity.pub, voiceStateV2Canonical('other-topic', state), sig)).toBe(false);
    expect(voiceStateCanonical('topic', state)).toEqual(voiceStateCanonical('topic', { ...state, deafened: false }));
  });
});

describe('room compatibility and retained floors', () => {
  it('bounds advertisements, tolerates future capabilities and grants browser no owner authority', () => {
    expect(validRoomCapabilities({})).toBe(true);
    expect(validRoomCapabilities({ protocolVersion: 3, capabilities: ['future-feature', 'chat-v2'] })).toBe(true);
    expect(readRoomCapabilities({ protocolVersion: 3, capabilities: ['future-feature', 'chat-v2'] })).toEqual({ protocolVersion: 3, capabilities: ['chat-v2'] });
    for (const m of [{ protocolVersion: 0 }, { protocolVersion: Infinity }, { capabilities: [1] }, { capabilities: ['chat', 'chat'] }]) expect(validRoomCapabilities(m)).toBe(false);
    expect(DESKTOP_ROOM_CAPABILITIES).toContain('owner-manage');
    expect(GUEST_ROOM_CAPABILITIES).not.toContain('owner-manage');
    expect(GUEST_ROOM_CAPABILITIES).not.toContain('e2e-files');
  });
  it('never evicts a departed member floor under identity churn', () => {
    const floors = new Map<string, number>();
    expect(acceptVoiceStamp(floors, 'original', 20, 100)).toBe(true);
    for (let i = 0; i < ROOM_VOICE_FLOORS; i++) acceptVoiceStamp(floors, 'peer-' + i, 30, 100);
    expect(floors.size).toBe(ROOM_VOICE_FLOORS);
    expect(acceptVoiceStamp(floors, 'extra', 40, 100)).toBe(false);
    expect(acceptVoiceStamp(floors, 'original', 10, 100)).toBe(false);
    expect(acceptVoiceStamp(floors, 'original', 21, 100)).toBe(true);
  });
});

it('allows only extensions of known ownership history, never a newer fork from an old owner', () => {
  const a = { by: 'A', newOwnerId: 'B', at: 10, pub: 'pub', sig: 'sig' }, b = { ...a, by: 'B', newOwnerId: 'C', at: 20 };
  const known = { ownerId: 'C', ownerPin: 'A', transferChain: [a, b], transferAt: 20 };
  expect(ownerChainAdvances(known, [{ ...a, newOwnerId: 'X', at: 30 }])).toBe(false);
  expect(ownerChainAdvances(known, [a, { ...b, newOwnerId: 'X', at: 30 }])).toBe(false);
  expect(ownerChainAdvances(known, [a, b, { ...a, by: 'C', newOwnerId: 'D', at: 30 }])).toBe(true);
});
