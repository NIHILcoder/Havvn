import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { deriveKey, topicHash, rendezvousId, encrypt, decrypt, deriveMemberId } from '../electron/sharing/room-crypto';
import { chatCanonical } from './room-canonicals';
import {
  deriveKeyWeb, topicHashWeb, rendezvousIdWeb, encryptWeb, decryptWeb,
  deriveMemberIdWeb, generateIdentityWeb, signWeb, verifyWeb,
  hexToBinary, binaryToHex, derToPem,
} from './room-web-crypto';

const CODE = 'swift-amber-otter-comet-4821';

describe('room-web-crypto matches Node room-crypto', () => {
  it('deriveKey / topicHash / rendezvousId are byte-identical', async () => {
    const web = await deriveKeyWeb(CODE);
    const node = deriveKey(CODE);
    expect(Buffer.from(web).equals(node)).toBe(true);
    expect(await topicHashWeb(CODE)).toBe(topicHash(CODE));
    expect(await rendezvousIdWeb(web)).toBe(rendezvousId(node));
  });

  it('AES-GCM tokens decrypt both ways', async () => {
    const key = deriveKey(CODE);
    const webKey = await deriveKeyWeb(CODE);
    const payload = { t: 'ping', memberId: 'x', n: 7 };
    const fromNode = encrypt(key, payload);
    expect(await decryptWeb(webKey, fromNode)).toEqual(payload);
    const fromWeb = await encryptWeb(webKey, payload);
    expect(decrypt(key, fromWeb)).toEqual(payload);
  });

  it('Ed25519 PEM from Web Crypto verifies on Node and the reverse', async () => {
    const id = await generateIdentityWeb();
    expect(await deriveMemberIdWeb(id.pub)).toBe(deriveMemberId(id.pub));
    const bytes = chatCanonical(topicHash(CODE), { id: 'm1', at: 1, memberId: id.memberId, text: 'hi' });
    const sig = await signWeb(id.priv, bytes);
    expect(await verifyWeb(id.pub, bytes, sig)).toBe(true);
    const ok = crypto.verify(null, Buffer.from(bytes), crypto.createPublicKey(id.pub), Buffer.from(sig, 'base64'));
    expect(ok).toBe(true);

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const nodeSig = crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(priv)).toString('base64');
    expect(await verifyWeb(pub, bytes, nodeSig)).toBe(true);
    expect(deriveMemberId(pub)).toBe(await deriveMemberIdWeb(pub));
  });

  it('PEM wrapping of a Node SPKI matches Node export', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const der = publicKey.export({ type: 'spki', format: 'der' });
    expect(derToPem(new Uint8Array(der), 'PUBLIC KEY')).toBe(pem);
  });

  it('hex ↔ tracker binary round-trips a 20-byte id', () => {
    const hex = '00112233445566778899aabbccddeeff00112233';
    expect(binaryToHex(hexToBinary(hex))).toBe(hex);
    expect(hexToBinary(hex).length).toBe(20);
  });
});
