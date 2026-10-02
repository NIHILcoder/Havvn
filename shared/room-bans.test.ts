import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { validBanSnapshot, banSnapshotCanonical, banSnapshotAdvances, copyBanSnapshot, ROOM_BAN_LIMIT } from './room-bans';
import { validateGossip } from './room-protocol';
import { gossipProofs, currentHelloProofs } from './room-message-auth';
import { verifyWeb } from './room-web-crypto';

const key = crypto.generateKeyPairSync('ed25519');
const pub = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const owner = crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32);
const topic = 'f'.repeat(40), removed = 'b'.repeat(32);
function proof(bans = [removed], revision = 1) {
  const p = { v: 1 as const, ownerId: owner, revision, bans, pub, sig: '' };
  p.sig = crypto.sign(null, banSnapshotCanonical(topic, p), key.privateKey).toString('base64');
  return p;
}
describe('signed room ban snapshots', () => {
  it('uses identical Node/WebCrypto bytes and binds topic, owner, revision and every ban', async () => {
    const p = proof();
    expect(await verifyWeb(pub, banSnapshotCanonical(topic, p), p.sig)).toBe(true);
    for (const changed of [{ ...p, ownerId: removed }, { ...p, revision: 2 }, { ...p, bans: [] }]) {
      expect(await verifyWeb(pub, banSnapshotCanonical(topic, changed), p.sig)).toBe(false);
    }
    expect(await verifyWeb(pub, banSnapshotCanonical('e'.repeat(40), p), p.sig)).toBe(false);
  });
  it('rejects duplicates, unsorted IDs, self-ban, invalid revisions and oversized history', () => {
    const p = proof(); expect(validBanSnapshot(p)).toBe(true);
    for (const changed of [{ ...p, bans: [removed, removed] }, { ...p, bans: ['z', 'a'] }, { ...p, bans: [owner] },
      { ...p, revision: 0 }, { ...p, revision: 1.5 }, { ...p, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...p, bans: ['x'.repeat(129)] }, { ...p, bans: Array.from({ length: ROOM_BAN_LIMIT + 1 }, (_, i) => String(i).padStart(5, '0')) }]) {
      expect(validBanSnapshot(changed)).toBe(false);
      expect(validateGossip({ t: 'hello', memberId: 'peer', banState: changed })).toBeNull();
    }
  });
  it('never removes held bans, accepts an identical proof and rejects lower/equivocating revisions or wrong owners', () => {
    const p = proof(), held = new Set(p.bans);
    expect(banSnapshotAdvances(p, owner, p, held)).toBe(true);
    expect(banSnapshotAdvances(proof([], 2), owner, p, held)).toBe(false);
    expect(banSnapshotAdvances(proof([removed], 1), owner, proof([removed], 2), held)).toBe(false);
    expect(banSnapshotAdvances({ ...p, sig: 'different' }, owner, p, held)).toBe(false);
    expect(banSnapshotAdvances(p, removed, null, held)).toBe(false);
    expect(banSnapshotAdvances(proof([removed, 'c'.repeat(32)], 2), owner, p, held)).toBe(true);
  });
  it('charges the HELLO proof, filters stale outgoing signatures and copies only signed fields', () => {
    const p = proof(); const hello = { t: 'hello', memberId: 'peer', banState: p };
    const verify = (v: ReturnType<typeof gossipProofs>[number]) => crypto.verify(null, v.bytes, v.pub, Buffer.from(v.sig, 'base64'));
    expect(gossipProofs(hello, topic, owner)).toHaveLength(1);
    expect(currentHelloProofs(hello, topic, owner, verify).banState).toEqual(p);
    expect(currentHelloProofs(hello, 'new-topic', owner, verify).banState).toBeUndefined();
    const copied = copyBanSnapshot({ ...p, extra: { arbitrary: true } } as typeof p);
    expect(copied).toEqual(p); expect(copied.bans).not.toBe(p.bans);
  });
});
