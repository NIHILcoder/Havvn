import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { contentKeyEpoch, mergeContentKeys, mintKeyPages, verifyKeyMetadata, verifyKeyPage, completeKeyPages } from './room-keyring';
import { keyMetadataCanonical, keyPageCanonical, ROOM_KEY_LIMIT, type RoomE2ECfg } from '../../shared/room-keyring';
import { validateGossip } from '../../shared/room-protocol';
import { gossipProofs } from '../../shared/room-message-auth';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ownerId = crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32);
const secret = (n: number) => n.toString(16).padStart(64, '0');
const cfg = (): RoomE2ECfg => ({ ownerId, e2e: true, secret: secret(90), pub, sig: 'v1' });

describe('versioned room content epochs and signed history pages', () => {
  it('freezes the domains/field order and interoperates with WebCrypto Ed25519', async () => {
    const c = cfg(), pages = mintKeyPages('topic', c, [secret(1), secret(2)], priv);
    expect(contentKeyEpoch(secret(1))).toBe(crypto.createHash('sha256').update('th-room-content-epoch:v2\0').update(Buffer.from(secret(1), 'hex')).digest('hex'));
    expect(new TextDecoder().decode(keyMetadataCanonical('topic', c, c.keys!))).toBe(JSON.stringify(['th-room-e2e-keys:v2', 'topic', ownerId, true, c.secret, c.keys!.epoch, c.keys!.root, 3, 1]));
    expect(new TextDecoder().decode(keyPageCanonical('topic', pages[0]))).toBe(JSON.stringify(['th-room-e2e-key-page:v2', 'topic', ownerId, c.keys!.epoch, c.keys!.root, 0, 3, pages[0].entries.map(e => [e.epoch, e.secret])]));
    const key = await crypto.webcrypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), 'Ed25519', false, ['verify']);
    for (const [bytes, sig] of [[keyMetadataCanonical('topic', c, c.keys!), c.keys!.sig], [keyPageCanonical('topic', pages[0]), pages[0].sig]] as const) {
      expect(await crypto.webcrypto.subtle.verify('Ed25519', key, Buffer.from(sig, 'base64'), bytes)).toBe(true);
    }
    expect(verifyKeyMetadata('topic', c)).toBe(true); expect(verifyKeyPage('topic', c, pages[0])).toBe(true);
  });
  it('retains legacy uppercase hex keys by bytes without rewriting the signed current-secret field', () => {
    const c = { ...cfg(), secret: 'AB'.repeat(32) }, previous = ['CD'.repeat(32), 'cd'.repeat(32)];
    const pages = mintKeyPages('topic', c, previous, priv); expect(c.secret).toBe('AB'.repeat(32));
    expect(contentKeyEpoch(c.secret)).toBe(contentKeyEpoch(c.secret.toLowerCase())); expect(mergeContentKeys(c.secret, previous, [c.secret])).toEqual(['cd'.repeat(32)]);
    expect(c.keys!.total).toBe(2); expect(verifyKeyPage('topic', c, pages[0])).toBe(true); expect(pages[0].entries.map(e => e.secret)).toEqual(expect.arrayContaining(['ab'.repeat(32), 'cd'.repeat(32)]));
  });
  it('transmits 100 prior keys in bounded pages with no eviction and a deterministic root', () => {
    const c = cfg(), previous = Array.from({ length: 100 }, (_, i) => secret(i + 100));
    const pages = mintKeyPages('topic', c, previous, priv);
    expect(pages).toHaveLength(4); expect(pages.every(p => p.entries.length <= 32 && validateGossip(p))).toBe(true);
    expect(completeKeyPages(c, [...pages].reverse())).toBe(true);
    const other = cfg(); mintKeyPages('topic', other, [...previous].reverse(), priv); expect(other.keys!.root).toBe(c.keys!.root);
    expect(mergeContentKeys(c.secret, previous, previous)).toHaveLength(100);
  });
  it('rejects tampering, unknown epoch IDs, cross-topic/owner/config replay and incomplete history', () => {
    const c = cfg(), pages = mintKeyPages('topic', c, [secret(1)], priv), page = pages[0];
    for (const patch of [{ epoch: 'f'.repeat(64) }, { root: 'f'.repeat(64) }, { ownerId: 'other' }, { page: 1 }, { total: 1 },
      { entries: [{ epoch: page.entries[0].epoch, secret: secret(1000) }] }, { sig: 'forged' }]) expect(verifyKeyPage('topic', c, { ...page, ...patch })).toBe(false);
    expect(verifyKeyPage('other-topic', c, page)).toBe(false);
    expect(verifyKeyMetadata('topic', { ...c, secret: secret(99) })).toBe(false);
    expect(verifyKeyMetadata('topic', { ...c, keys: { ...c.keys!, total: 1 } })).toBe(false);
    expect(completeKeyPages(c, [])).toBe(false); expect(completeKeyPages(c, [page, page])).toBe(false);
    for (const proof of gossipProofs({ ...page }, 'topic', ownerId)) expect(crypto.verify(null, proof.bytes, publicKey, Buffer.from(proof.sig, 'base64'))).toBe(true);
  });
  it('fails explicitly at the retention bound instead of dropping the oldest key', () => {
    const held = Array.from({ length: ROOM_KEY_LIMIT }, (_, i) => secret(i + 1));
    expect(mergeContentKeys('', held)).toHaveLength(ROOM_KEY_LIMIT);
    expect(() => mergeContentKeys(secret(9999), held)).toThrow(/history is full/);
    expect(held[0]).toBe(secret(1));
    expect(validateGossip({ t: 'e2e-key-request', memberId: ownerId, root: 'a'.repeat(64), page: 64 })).toBeNull();
  });
});
