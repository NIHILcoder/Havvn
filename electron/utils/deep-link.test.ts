import { describe, it, expect } from 'vitest';
import { isHavvnUrl, parseHavvnInvite } from './deep-link';

const INVITE = 'swift-amber-otter-comet-4821';
const INVITE_E2E_PIN = 'swift-amber-otter-comet-4821-e2e~0123456789abcdef0123456789abcdef';

describe('isHavvnUrl', () => {
  it('accepts havvn:// and bare havvn: (case-insensitive, trimmed)', () => {
    expect(isHavvnUrl('havvn://join/x')).toBe(true);
    expect(isHavvnUrl('havvn:join/x')).toBe(true);
    expect(isHavvnUrl('  HAVVN://JOIN/x  ')).toBe(true);
  });
  it('rejects other schemes and non-strings', () => {
    expect(isHavvnUrl('magnet:?xt=urn:btih:abc')).toBe(false);
    expect(isHavvnUrl('https://havvn.example/join/x')).toBe(false);
    expect(isHavvnUrl('havvnsomething')).toBe(false);
    expect(isHavvnUrl(null)).toBe(false);
    expect(isHavvnUrl(42 as any)).toBe(false);
  });
});

describe('parseHavvnInvite', () => {
  it('extracts the invite from the canonical join form', () => {
    expect(parseHavvnInvite(`havvn://join/${INVITE}`)).toBe(INVITE);
  });
  it('preserves the -e2e suffix and ~ownerPin (~ is URL-safe, stays literal)', () => {
    expect(parseHavvnInvite(`havvn://join/${INVITE_E2E_PIN}`)).toBe(INVITE_E2E_PIN);
  });
  it('accepts a bare havvn://<invite> without the join/ segment', () => {
    expect(parseHavvnInvite(`havvn://${INVITE}`)).toBe(INVITE);
  });
  it('accepts the bare-scheme havvn:join/<invite> form', () => {
    expect(parseHavvnInvite(`havvn:join/${INVITE}`)).toBe(INVITE);
  });
  it('tolerates a trailing slash, query and hash', () => {
    expect(parseHavvnInvite(`havvn://join/${INVITE}/`)).toBe(INVITE);
    expect(parseHavvnInvite(`havvn://join/${INVITE}?ref=twitter`)).toBe(INVITE);
    expect(parseHavvnInvite(`havvn://join/${INVITE}#frag`)).toBe(INVITE);
  });
  it('URL-decodes a percent-encoded payload (incl. an encoded ~)', () => {
    const encoded = encodeURIComponent(INVITE_E2E_PIN); // encodes ~ as %7E
    expect(parseHavvnInvite(`havvn://join/${encoded}`)).toBe(INVITE_E2E_PIN);
  });
  it('is case-insensitive on the scheme/path but preserves the payload as-is', () => {
    expect(parseHavvnInvite(`HAVVN://JOIN/${INVITE}`)).toBe(INVITE);
  });
  it('returns null for non-havvn URLs', () => {
    expect(parseHavvnInvite('magnet:?xt=urn:btih:abc')).toBeNull();
    expect(parseHavvnInvite('https://evil.example/join/x')).toBeNull();
    expect(parseHavvnInvite('')).toBeNull();
    expect(parseHavvnInvite(undefined)).toBeNull();
  });
  it('returns null for an empty payload', () => {
    expect(parseHavvnInvite('havvn://join/')).toBeNull();
    expect(parseHavvnInvite('havvn://')).toBeNull();
  });
  it('bounds the payload length (rejects an implausibly long deep link)', () => {
    expect(parseHavvnInvite('havvn://join/' + 'a'.repeat(201))).toBeNull();
    expect(parseHavvnInvite('havvn://join/' + 'a'.repeat(200))).toHaveLength(200);
  });
  it('does not throw on a malformed percent-encoding (keeps the raw payload)', () => {
    // '%zz' is invalid; decodeURIComponent throws, and we fall back to raw.
    expect(parseHavvnInvite('havvn://join/abc%zz')).toBe('abc%zz');
  });
});
