import { watchPolicyCanonical } from '../shared/room-watch-host';
import { WatchSender, watchCanonical, watchHostCanonical } from '../shared/room-watch-sync';
import { roomHelloParts, ROOM_FILE_LIMIT } from '../shared/room-manifest-sync';
/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise the encrypted wire boundary with real signatures. */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { GuestRoom } from './mesh';
import { deriveKey, topicHash, encrypt, deriveMemberId, decrypt } from '../electron/sharing/room-crypto';
import { generateIdentityWeb } from '../shared/room-web-crypto';
import { banSnapshotCanonical, type RoomBanSnapshot } from '../shared/room-bans';
import { transferCanonical } from '../shared/room-authority';
import { renameCanonical, topicCanonical, rekeyCanonical, kickedCanonical, voiceStateCanonical, voiceStateV2Canonical } from '../shared/room-canonicals';

vi.mock('./tracker', () => ({ startRendezvous: () => ({ stop() {} }) }));
const CODE = 'swift-amber-otter-comet-4821';
function identity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { pub, memberId: deriveMemberId(pub), sign: (bytes: Uint8Array) => crypto.sign(null, bytes, priv).toString('base64') };
}
const A = identity(), B = identity(), C = identity(), X = identity();
const topic = topicHash(CODE);
const json = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const link = (by: ReturnType<typeof identity>, to: string, at: number) => {
  const body = { by: by.memberId, newOwnerId: to, at };
  return { ...body, pub: by.pub, sig: by.sign(transferCanonical(A.memberId, body)) };
};
const hello = (who = A, extra: any = {}) => ({ t: 'hello', memberId: who.memberId, pub: who.pub, name: who.memberId, avatarSeed: who.memberId, ownerId: A.memberId, ...extra });
const file = (extra: any = {}) => ({ fileId: 'f'.repeat(40), infoHash: 'f'.repeat(40), name: 'movie.mp4', size: 100, magnetURI: 'magnet:?xt=urn:btih:' + 'f'.repeat(40), addedBy: B.memberId, addedByName: 'B', addedAt: 1, ...extra });
const deletion = (who: ReturnType<typeof identity>, at: number) => ({ t: 'del', fileId: file().fileId, memberId: who.memberId, at, pub: who.pub, sig: who.sign(json(['del', topic, file().fileId, who.memberId, at])) });

async function fixture(pin = '') {
  const room = new GuestRoom({ identity: await generateIdentityWeb(), name: 'Guest', avatarSeed: 'guest', trackers: [], onChange: vi.fn() });
  const internals = room as any, sent: string[] = [], forwarded: string[] = [];
  internals.key = new Uint8Array(deriveKey(CODE)); internals.topic = topic; internals.code = CODE; room.ownerPin = pin;
  const rec = { id: 1, wire: { connected: true, send: (raw: string) => sent.push(raw), destroy: vi.fn() } };
  internals.wires.set(1, rec);
  internals.wires.set(2, { id: 2, memberId: 'neighbor', wire: { send: (raw: string) => forwarded.push(raw), destroy: vi.fn() } });
  return { room, internals, sent, forwarded, frame: (m: any) => internals.onFrame(rec, encrypt(Buffer.from(internals.key), m)) };
}

describe('browser ownership and pin compatibility', () => {
  it.each([A.memberId, B.memberId, C.memberId])('walks the verified chain for pin %s and applies the new owner topic/rename', async pin => {
    const f = await fixture(pin), chain = [link(A, B.memberId, 10), link(B, C.memberId, 20)];
    const t = { text: 'new owner topic', at: 21, by: C.memberId };
    await f.frame(hello(C, { ownerId: C.memberId, transferChain: chain, topicMsg: { ...t, pub: C.pub, sig: C.sign(topicCanonical(topic, t)) }, protocolVersion: 2, capabilities: ['owner-transfer-v1', 'owner-manage', 'future-capability'] }));
    expect(f.room.ownerId).toBe(C.memberId);
    expect(f.room.snapshot().topic).toBe(t.text);
    expect(f.room.snapshot().members.find(m => m.memberId === C.memberId)).toMatchObject({ role: 'owner', protocolVersion: 2, capabilities: ['owner-transfer-v1', 'owner-manage'] });
    expect(f.internals.helloMsg().transferChain).toEqual(chain);
    const rename = { name: 'Transferred room', at: 22, by: C.memberId };
    await f.frame({ t: 'rename', ...rename, pub: C.pub, sig: C.sign(renameCanonical(topic, rename)) });
    expect(f.room.roomName).toBe(rename.name);
    await f.frame(hello(A)); expect(f.room.ownerId).toBe(C.memberId);
    const old = { name: 'Old owner cannot rename', at: 23, by: A.memberId };
    await f.frame({ t: 'rename', ...old, pub: A.pub, sig: A.sign(renameCanonical(topic, old)), _g: 'old-owner', _t: 4 });
    expect(f.room.roomName).toBe(rename.name);
    expect(f.forwarded.map(raw => decrypt(deriveKey(CODE), raw)).some(m => m._g === 'old-owner')).toBe(false);
  });
  it('rejects a forged chain or an unrelated pin without creating an owner role', async () => {
    const f = await fixture(A.memberId), a = link(A, B.memberId, 10), b = link(B, C.memberId, 20);
    await f.frame(hello(C, { ownerId: C.memberId, transferChain: [a, { ...b, newOwnerId: X.memberId }] }));
    expect(f.room.ownerId).toBe('');
    expect(f.internals.transferChain).toEqual([]);
    const other = await fixture(X.memberId);
    await other.frame(hello(C, { ownerId: C.memberId, transferChain: [a, b] }));
    expect(other.room.ownerId).toBe('');
  });
  it('applies live transfers, then accepts rekey only from the current owner', async () => {
    const f = await fixture(A.memberId);
    await f.frame(hello(A)); await f.frame(hello(B));
    await f.frame({ t: 'transfer', ...link(A, B.memberId, 10) });
    expect(f.room.ownerId).toBe(B.memberId);
    const body = { newCode: 'swift-amber-otter-comet-4822', kickedId: X.memberId, by: B.memberId };
    await f.frame({ t: 'rekey', ...body, pub: B.pub, sig: B.sign(rekeyCanonical(topic, body)) });
    expect(f.internals.code).toBe(body.newCode); expect(f.internals.bans.has(X.memberId)).toBe(true);
    const rename = { name: 'After rekey', at: 20, by: B.memberId };
    await f.frame({ t: 'rename', ...rename, pub: B.pub, sig: B.sign(renameCanonical(f.internals.topic, rename)) });
    expect(f.room.roomName).toBe(rename.name);
    expect(f.internals.helloMsg().transferChain).toHaveLength(1);
  });
  it('does not grant owner commands when ownership is unknown', async () => {
    const f = await fixture(A.memberId), body = { newCode: 'other-code', kickedId: B.memberId, by: X.memberId };
    await f.frame({ t: 'rekey', ...body, pub: X.pub, sig: X.sign(rekeyCanonical(topic, body)) });
    expect(f.internals.code).toBe(CODE);
    const kicked = { targetId: f.room.identity.memberId, by: X.memberId };
    await f.frame({ t: 'kicked', ...kicked, pub: X.pub, sig: X.sign(kickedCanonical(topic, kicked)) });
    expect(f.room.kicked).toBe(false);
  });
});

describe('browser signed deletion and revival', () => {
  it('retains authorship, rejects unsigned/foreign deletion, suppresses stale adds and accepts only a signed revival', async () => {
    const f = await fixture(A.memberId), original = file();
    await f.frame(hello(A, { files: [original] }));
    await f.frame({ t: 'add', file: file({ addedBy: X.memberId, addedAt: 5 }) });
    await f.frame({ ...deletion(X, 10), _g: 'foreign-delete', _t: 4 });
    await f.frame({ t: 'del', fileId: original.fileId, memberId: B.memberId });
    expect(f.room.snapshot().files).toHaveLength(1);
    expect(f.room.snapshot().files[0].addedBy).toBe(B.memberId);
    expect(f.forwarded.some(raw => decrypt(deriveKey(CODE), raw)._g === 'foreign-delete')).toBe(false);
    await f.frame(deletion(B, 10)); expect(f.room.snapshot().files).toEqual([]);
    await f.frame(hello(A, { files: [original] }));
    await f.frame({ t: 'add', file: file({ addedAt: 100 }) });
    expect(f.room.snapshot().files).toEqual([]);
    const revive = { revAt: 10, revBy: B.memberId, revPub: B.pub, revSig: B.sign(json(['revive', topic, original.fileId, 10, B.memberId])) };
    await f.frame({ t: 'add', file: file({ ...revive, addedAt: 2 }) });
    expect(f.room.snapshot().files).toHaveLength(1); // valid revival works despite skewed addedAt
    await f.frame(deletion(B, 10)); expect(f.room.snapshot().files).toHaveLength(1);
    await f.frame(deletion(A, 11)); expect(f.room.snapshot().files).toEqual([]);
  });
  it('keeps an author tomb received before the manifest and re-serves the verified proof', async () => {
    const f = await fixture(A.memberId), del = deletion(B, 10);
    await f.frame(hello(A)); await f.frame(del);
    expect(f.internals.pendingTombs.size).toBe(1);
    await f.frame({ t: 'add', file: file() });
    expect(f.room.snapshot().files).toEqual([]); expect(f.internals.pendingTombs.size).toBe(0);
    expect(f.internals.helloMsg().tombSigs[file().fileId]).toEqual({ at: del.at, by: B.memberId, pub: B.pub, sig: del.sig });
    const later = await fixture(A.memberId);
    await later.frame(hello(A, { files: [file()], tombSigs: f.internals.helloMsg().tombSigs }));
    expect(later.room.snapshot().files).toEqual([]);
  });
  it('does not promote a foreign pending tomb into a revival guard and clamps future manifest clocks', async () => {
    const f = await fixture(A.memberId); await f.frame(hello(A));
    await f.frame(deletion(X, 40));
    const foreignRevive = { revAt: 40, revBy: X.memberId, revPub: X.pub, revSig: X.sign(json(['revive', topic, file().fileId, 40, X.memberId])) };
    await f.frame({ t: 'add', file: file(foreignRevive) });
    expect(f.internals.revives.has(file().fileId)).toBe(false);
    await f.frame(deletion(A, 30)); expect(f.room.snapshot().files).toEqual([]);
    const late = await fixture(A.memberId);
    await late.frame(hello(A, { files: [file({ addedAt: Date.now() + 100000000 })] }));
    expect(late.room.snapshot().files[0].addedAt).toBeLessThanOrEqual(Date.now());
    await late.frame(deletion(A, Date.now() + 1)); expect(late.room.snapshot().files).toEqual([]);
  });

  it('bounds pending tombs without letting an unknown file signer delete a held file', async () => {
    const f = await fixture(A.memberId); await f.frame(hello(A));
    for (let i = 0; i < 501; i++) await f.internals.acceptTomb('missing-' + i, { at: 10, by: B.memberId, pub: B.pub, sig: 'pending' });
    expect(f.internals.pendingTombs.size).toBe(500);
    await f.frame({ t: 'add', file: file({ addedBy: C.memberId }) });
    await f.frame(deletion(B, 20)); expect(f.room.snapshot().files).toHaveLength(1);
  });
});

describe('browser voice authentication', () => {
  function state(at: number, extra: any = {}, v2 = true) {
    const body = { memberId: B.memberId, at, inVoice: true, muted: false, deafened: false, ...extra };
    return { t: 'voice-state', ...body, pub: B.pub, sig: B.sign(voiceStateCanonical(topic, body)),
      ...(v2 ? { voiceV: 2, stateSig: B.sign(voiceStateV2Canonical(topic, body)) } : {}) };
  }
  it('requires known membership and signed deafened state; rejects tampering, replay and downgrade', async () => {
    const f = await fixture(); await f.frame(state(10)); expect(f.room.snapshot().voice.participants).toEqual([]);
    await f.frame(hello(B));
    await f.frame(state(10, { deafened: true }, false));
    expect(f.room.snapshot().voice.participants[0].deafened).toBe(false); // legacy field was never authenticated
    const v2 = state(20, { deafened: true, muted: true });
    await f.frame({ ...v2, deafened: false, _g: 'tampered-deafened', _t: 4 });
    expect(f.room.snapshot().voice.participants[0].muted).toBe(false);
    await f.frame(v2); expect(f.room.snapshot().voice.participants[0]).toMatchObject({ muted: true, deafened: true });
    await f.frame(state(21, {}, false)); // stripping the extension cannot downgrade a v2 identity
    expect(f.room.snapshot().voice.participants[0].deafened).toBe(true);
    await f.frame(state(30, { inVoice: false }));
    await f.frame({ ...v2, _g: 'replay-after-leave' });
    expect(f.room.snapshot().voice.participants).toEqual([]);
  });
  it('signs the additive extension for Node verification while retaining the frozen v1 signature', async () => {
    const f = await fixture(); await f.frame(hello(A));
    await f.internals.sendVoiceState(true, false, 10, true);
    const sent = decrypt(deriveKey(CODE), f.sent.at(-1)!);
    expect(sent).toMatchObject({ voiceV: 2, deafened: true });
    expect(crypto.verify(null, voiceStateCanonical(topic, sent), sent.pub, Buffer.from(sent.sig, 'base64'))).toBe(true);
    expect(crypto.verify(null, voiceStateV2Canonical(topic, sent), sent.pub, Buffer.from(sent.stateSig, 'base64'))).toBe(true);
  });
});

function signedBans(who: ReturnType<typeof identity>, bans: string[], revision = 1): RoomBanSnapshot {
  const p: RoomBanSnapshot = { v: 1, ownerId: who.memberId, revision, bans: [...bans].sort(), pub: who.pub, sig: '' };
  p.sig = who.sign(banSnapshotCanonical(topic, p)); return p;
}
describe('browser signed ban convergence', () => {
  it('adopts a holder-served owner proof before accepting the banned sender or sending the full reply', async () => {
    const f = await fixture(A.memberId), proof = signedBans(A, [B.memberId]);
    await f.frame(hello(B, { banState: proof, _g: 'banned-hello', _t: 4 }));
    expect(f.internals.bans.has(B.memberId)).toBe(true);
    expect(f.room.snapshot().members.some(m => m.memberId === B.memberId)).toBe(false);
    expect(f.sent).toHaveLength(0);
    expect(f.internals.helloMsg().banState).toEqual(proof);
    await f.frame(hello(C));
    expect(f.room.snapshot().members.some(m => m.memberId === C.memberId)).toBe(true);
  });
  it('rejects tampering, foreign owner, old revision and unsigned attempts to remove known bans', async () => {
    const f = await fixture(A.memberId), proof = signedBans(A, [B.memberId], 2);
    await f.frame(hello(C, { banState: { ...proof, bans: [] }, _g: 'tampered', _t: 4 }));
    expect(f.internals.bans.size).toBe(0);
    expect(f.forwarded.some(raw => decrypt(deriveKey(CODE), raw)._g === 'tampered')).toBe(false);
    await f.frame(hello(C, { banState: signedBans(X, [B.memberId]), _g: 'foreign', _t: 4 }));
    expect(f.internals.bans.size).toBe(0);
    expect(f.forwarded.map(raw => decrypt(deriveKey(CODE), raw)).find(m => m._g === 'foreign')?.banState).toBeUndefined();
    await f.frame(hello(C, { banState: proof }));
    await f.frame(hello(C, { banState: signedBans(A, [], 3) }));
    await f.frame(hello(C, { banState: signedBans(A, [B.memberId], 1) }));
    await f.frame(hello(C));
    expect(f.internals.bans.has(B.memberId)).toBe(true); expect(f.internals.banState).toEqual(proof);
  });
  it('walks a chain containing a banned past owner, but gives that owner no live authority', async () => {
    const f = await fixture(A.memberId), chain = [link(A, C.memberId, 10)], proof = signedBans(C, [A.memberId]);
    await f.frame(hello(C, { ownerId: C.memberId, transferChain: chain, banState: proof }));
    expect(f.room.ownerId).toBe(C.memberId); expect(f.internals.bans.has(A.memberId)).toBe(true);
    await f.frame(hello(B, { ownerId: C.memberId, transferChain: chain, banState: proof }));
    expect(f.room.snapshot().members.some(m => m.memberId === B.memberId)).toBe(true);
    expect(f.internals.helloMsg().transferChain).toEqual(chain);
    const late = await fixture(A.memberId);
    await late.frame(hello(B, { ownerId: C.memberId, transferChain: chain, banState: proof }));
    expect(late.room.ownerId).toBe(C.memberId); expect(late.internals.bans.has(A.memberId)).toBe(true);
    await f.frame(hello(A, { ownerId: A.memberId, banState: signedBans(A, [B.memberId], 9) }));
    expect(f.internals.bans.has(B.memberId)).toBe(false); expect(f.room.ownerId).toBe(C.memberId);
  });
  it('tears down a banned guest before returning any full room data', async () => {
    const f = await fixture(A.memberId);
    await f.frame(hello(C, { banState: signedBans(A, [f.room.identity.memberId]) }));
    expect(f.room.kicked).toBe(true); expect(f.internals.wires.size).toBe(0); expect(f.sent).toHaveLength(0);
  });
  it('rejects a proof from the old gossip epoch after a rekey', async () => {
    const f = await fixture(A.memberId); await f.frame(hello(A));
    const body = { newCode: CODE + '-new', kickedId: B.memberId, by: A.memberId };
    await f.frame({ t: 'rekey', ...body, pub: A.pub, sig: A.sign(rekeyCanonical(topic, body)) });
    const raw = encrypt(Buffer.from(f.internals.key), hello(C, { banState: signedBans(A, [X.memberId]), _g: 'old-epoch', _t: 4 }));
    const rec = { id: 3, wire: { send: vi.fn(), destroy: vi.fn() } }; f.internals.wires.set(3, rec);
    await f.internals.onFrame(rec, raw);
    expect(f.internals.bans.has(B.memberId)).toBe(true); expect(f.internals.bans.has(X.memberId)).toBe(false);
    expect(rec.wire.send).not.toHaveBeenCalled();
  });
});

describe('ban history across owner handover', () => {
  it('consumes a current owner proof attached to the live handover', async () => {
    const f = await fixture(A.memberId); await f.frame(hello(A));
    await f.frame({ t: 'transfer', ...link(A, C.memberId, 20), banState: signedBans(A, [B.memberId]) });
    expect(f.room.ownerId).toBe(C.memberId); expect(f.internals.bans.has(B.memberId)).toBe(true);
    await f.frame(hello(C, { ownerId: C.memberId, banState: signedBans(C, [B.memberId]) }));
    expect(f.internals.helloMsg().banState.ownerId).toBe(C.memberId);
  });
  it('does not let a deposed owner poison an advancing chain through a hello snapshot', async () => {
    const f = await fixture(A.memberId); await f.frame(hello(A));
    await f.frame(hello(B, { ownerId: C.memberId, transferChain: [link(A, C.memberId, 20)], banState: signedBans(A, [C.memberId]) }));
    expect(f.room.ownerId).toBe(C.memberId); expect(f.internals.bans.has(C.memberId)).toBe(false);
  });
});

it('rejects an authentic newer fork signed by a banned past owner while preserving its original historical proof', async () => {
  const f = await fixture(A.memberId), chain = [link(A, C.memberId, 10)], bans = signedBans(C, [A.memberId]);
  await f.frame(hello(C, { ownerId: C.memberId, transferChain: chain, banState: bans }));
  await f.frame(hello(B, { ownerId: X.memberId, transferChain: [link(A, X.memberId, 30)], banState: signedBans(X, [C.memberId]), _g: 'signed-fork', _t: 4 }));
  expect(f.room.ownerId).toBe(C.memberId); expect(f.internals.bans.has(C.memberId)).toBe(false); expect(f.internals.transferChain).toEqual(chain);
  expect(f.forwarded.map(raw => decrypt(deriveKey(CODE), raw)).some(m => m._g === 'signed-fork')).toBe(false);
});

it('learns signed bans when the first authenticated owner message is a live handover', async () => {
  const f = await fixture(A.memberId);
  await f.frame({ t: 'transfer', ...link(A, C.memberId, 20), banState: signedBans(A, [B.memberId]) });
  expect(f.room.ownerId).toBe(C.memberId); expect(f.internals.bans.has(B.memberId)).toBe(true);
});


describe('browser manifest load', () => {
  it('accepts all 5000 files in paged authenticated HELLOs and rejects growth past the shared ceiling', async () => {
    const f = await fixture(A.memberId);
    const files = Array.from({ length: ROOM_FILE_LIMIT }, (_, i) => file({ fileId: i.toString(16).padStart(40, '0'), infoHash: i.toString(16).padStart(40, '0') }));
    const pages = roomHelloParts(hello(A, { files, have: [], tombs: [], manifestFull: true }), 'guest-load', 1);
    try {
      for (const page of pages) await f.frame(page);
      expect(f.room.snapshot().files).toHaveLength(ROOM_FILE_LIMIT);
      await f.frame({ t: 'add', file: file({ fileId: 'overflow', infoHash: 'overflow' }) });
      expect(f.room.snapshot().files).toHaveLength(ROOM_FILE_LIMIT);
    } finally { f.internals.teardown(); }
  }, 15_000);
});

function watchPolicy(who = A, hostId = B.memberId, at = Date.now()) {
  const p = { t: 'watch-policy-v1' as const, by: who.memberId, ownerAt: 0, hostId, at, pub: who.pub };
  return { ...p, sig: who.sign(watchPolicyCanonical(topic, p)) };
}
function watchFrame(who: ReturnType<typeof identity>, policy: ReturnType<typeof watchPolicy>, action = 'play', patch: any = {}) {
  const body = new WatchSender().next({ fileId: file().fileId, action, position: 5, together: true, readiness: 'ready', policyBy: policy.by, policyAt: policy.at, ...patch }, who.memberId, () => 'a'.repeat(32), Date.now(), 3)!;
  return { ...body, pub: who.pub, sig: who.sign(watchCanonical(topic, body)), hostSig: who.sign(watchHostCanonical(topic, body)) };
}
describe('browser signed watch host', () => {
  it('adopts an owner policy from HELLO, rejects forged snapshot policies and viewer controls before relay', async () => {
    const f = await fixture(A.memberId), p = watchPolicy(), sync = vi.fn(); f.room.onSync = sync;
    await f.frame(hello(A, { watchPolicy: p, files: [file()] })); await f.frame(hello(B));
    expect(f.room.snapshot().watchPolicy).toEqual(p);
    await f.frame(hello(A, { watchPolicy: { ...p, hostId: X.memberId, at: p.at + 1 } }));
    expect(f.room.snapshot().watchPolicy).toEqual(p);
    await f.frame({ ...watchFrame(A, p), _g: 'blocked-control', _t: 4 });
    expect(sync).not.toHaveBeenCalled();
    expect(f.forwarded.map(raw => decrypt(deriveKey(CODE), raw)).some(m => m._g === 'blocked-control')).toBe(false);
    await f.frame({ ...watchFrame(B, p), _g: 'host-control', _t: 4 });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ memberId: B.memberId, readiness: 'ready', policyAt: p.at }));
    const request = watchFrame(A, p, 'request', { requested: 'pause' });
    await f.frame(request); expect(sync).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'request', requested: 'pause' }));
    const count = sync.mock.calls.length; await f.frame(request); expect(sync).toHaveBeenCalledTimes(count);
  });
  it('re-serves the choice for late guests and rejects stale revisions and tampered readiness', async () => {
    const f = await fixture(A.memberId), p = watchPolicy(), sync = vi.fn(); f.room.onSync = sync;
    await f.frame(hello(A, { watchPolicy: p, files: [file()] })); await f.frame(hello(B));
    expect(f.internals.helloMsg().watchPolicy).toEqual(p);
    const next = watchPolicy(A, A.memberId, p.at + 1); await f.frame(next);
    await f.frame(p); expect(f.room.snapshot().watchPolicy).toEqual(next);
    await f.frame(watchFrame(B, p)); expect(sync).not.toHaveBeenCalled();
    await f.frame({ ...watchFrame(A, next), readiness: 'error' }); expect(sync).not.toHaveBeenCalled();
    await f.frame(watchFrame(A, next)); expect(sync).toHaveBeenCalledTimes(1);
    await f.frame({ t: 'transfer', ...link(A, B.memberId, Date.now()) });
    expect(f.room.snapshot().watchPolicy).toBeUndefined(); await f.frame(p); expect(f.room.snapshot().watchPolicy).toBeUndefined();
  });
});
