import { describe, it, expect } from 'vitest';
import { normalizeCode, codeIsE2E, buildInvite, parseInvite } from './room-invite';

describe('room-invite', () => {
  const code = 'swift-amber-otter-comet-4821';
  const owner = 'a'.repeat(32);

  it('normalizes whitespace and case', () => {
    expect(normalizeCode('  Swift  Amber Otter-comet-4821  ')).toBe(code);
  });

  it('detects the e2e marker', () => {
    expect(codeIsE2E(code)).toBe(false);
    expect(codeIsE2E(code + '-e2e')).toBe(true);
  });

  it('pins and round-trips an owner id', () => {
    const invite = buildInvite(code, owner);
    expect(invite).toBe(code + '~' + owner);
    expect(parseInvite(invite)).toEqual({ code, ownerPin: owner });
  });

  it('rejects a malformed pin instead of trusting it', () => {
    expect(parseInvite(code + '~not-a-real-id').ownerPin).toBe('');
    expect(buildInvite(code, 'bogus')).toBe(code);
  });

  it('keeps the -e2e marker with the pin', () => {
    const e2e = code + '-e2e';
    expect(parseInvite(buildInvite(e2e, owner))).toEqual({ code: e2e, ownerPin: owner });
    expect(codeIsE2E(parseInvite(buildInvite(e2e, owner)).code)).toBe(true);
  });
});
