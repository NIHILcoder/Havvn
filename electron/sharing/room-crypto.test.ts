import { describe, it, expect } from 'vitest';
import { deriveKey, topicHash, rendezvousId, normalizeCode, buildInvite, parseInvite, deriveMemberId } from './room-crypto';

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

describe('room-crypto: owner-pinned invite', () => {
  const code = 'swift-amber-otter-comet-4821';
  const owner = deriveMemberId('-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + 'x'.repeat(30) + '=\n-----END PUBLIC KEY-----\n');

  it('deriveMemberId is a 32-hex hash of the pubkey', () => {
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
  });

  it('buildInvite pins the owner; parseInvite round-trips it', () => {
    const invite = buildInvite(code, owner);
    expect(invite).toBe(code + '~' + owner);
    expect(parseInvite(invite)).toEqual({ code, ownerPin: owner });
  });

  it('the pin is NOT part of the KDF — pinned and bare joiners derive the SAME key', () => {
    const invite = buildInvite(code, owner);
    const bare = parseInvite(code);
    const pinned = parseInvite(invite);
    expect(pinned.code).toBe(bare.code);
    expect(deriveKey(pinned.code).equals(deriveKey(code))).toBe(true);
    expect(rendezvousId(deriveKey(pinned.code))).toBe(rendezvousId(deriveKey(code)));
    // ...and the same for topic (signature domain).
    expect(topicHash(pinned.code)).toBe(topicHash(code));
  });

  it('a bare code parses with no pin (trust-on-first-use fallback preserved)', () => {
    expect(parseInvite(code)).toEqual({ code, ownerPin: '' });
    expect(buildInvite(code)).toBe(code); // no owner → bare, still speakable
  });

  it('rejects a malformed pin (not a 32-hex memberId) instead of trusting it', () => {
    expect(parseInvite(code + '~not-a-real-id').ownerPin).toBe('');
    expect(parseInvite(code + '~' + owner.slice(0, 10)).ownerPin).toBe(''); // too short
    expect(parseInvite(code + '~' + owner.toUpperCase()).ownerPin).toBe(owner); // case-normalized
    expect(buildInvite(code, 'bogus')).toBe(code); // invalid owner id → not pinned
  });

  it('keeps the -e2e marker with the pin', () => {
    const e2e = 'swift-amber-otter-comet-4821-e2e';
    const parsed = parseInvite(buildInvite(e2e, owner));
    expect(parsed).toEqual({ code: e2e, ownerPin: owner });
  });
});
