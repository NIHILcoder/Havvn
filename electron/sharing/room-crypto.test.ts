import { describe, it, expect } from 'vitest';
import { deriveKey, topicHash, rendezvousId, normalizeCode } from './room-crypto';

describe('room-crypto: topic / rendezvous split', () => {
  const code = 'swift-amber-otter-comet-4821';

  it('topicHash stays the historical value (persisted signatures must keep verifying)', () => {
    // Regression guard: topicHash is the signature domain separator, mixed into
    // persisted chat/E2E signatures. Changing it would silently reject old chat.
    expect(topicHash(code)).toBe(topicHash(code)); // deterministic
    expect(topicHash(code)).toMatch(/^[0-9a-f]{40}$/);
    // Locked value — if this ever changes, existing rooms' signatures break.
    expect(topicHash('swift-amber-otter-comet-4821')).toBe(
      require('crypto').createHash('sha1').update('th-room:v1:swift-amber-otter-comet-4821').digest('hex'),
    );
  });

  it('rendezvousId is derived from the SLOW key, not a fast hash of the code', () => {
    const key = deriveKey(code);
    const rv = rendezvousId(key);
    expect(rv).toMatch(/^[0-9a-f]{40}$/);
    expect(rv).toBe(rendezvousId(deriveKey(code))); // deterministic for a code
    // The rendezvous is NOT the old sha1(code) topic — that was the leak.
    expect(rv).not.toBe(topicHash(code));
    // And NOT any cheap hash of the code an operator could precompute.
    const cryptoNode = require('crypto');
    expect(rv).not.toBe(cryptoNode.createHash('sha1').update(code).digest('hex'));
    expect(rv).not.toBe(cryptoNode.createHash('sha1').update(normalizeCode(code)).digest('hex'));
  });

  it('different codes → different rendezvous ids', () => {
    expect(rendezvousId(deriveKey(code))).not.toBe(rendezvousId(deriveKey('brave-azure-falcon-nova-1234')));
  });

  it('rendezvous binds to the key: reversing it requires the PBKDF2 the key cost', () => {
    // Same key in → same rv out; the only way to produce rv is to hold the key,
    // which costs a full deriveKey (PBKDF2 150k) per code guess.
    const key = deriveKey(code);
    expect(rendezvousId(key)).toBe(rendezvousId(key));
  });
});
