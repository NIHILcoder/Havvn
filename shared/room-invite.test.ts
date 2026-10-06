import { describe, it, expect } from 'vitest';
import { normalizeCode, codeIsE2E, buildInvite, parseInvite, isRoomCode, isRoomInvite } from './room-invite';

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


describe('desktop room invite validation', () => {
  const legacy = 'swift-amber-otter-comet-4821';
  const current = 'bright-frosty-swift-harbor-anchor-62590';
  const owner = 'a'.repeat(32);
  it.each([legacy, current])('accepts historical and generated codes with encryption and owner pins: %s', code => {
    for (const suffix of ['', '-e2e']) {
      expect(isRoomCode(code + suffix)).toBe(true);
      expect(isRoomInvite(code + suffix)).toBe(true);
      expect(isRoomInvite(buildInvite(code + suffix, owner))).toBe(true);
    }
  });
  it('uses the engine normalization for pasted whitespace, case and repeated dashes', () => {
    const raw = '  BRIGHT -- FROSTY SWIFT HARBOR ANCHOR 62590 E2E ~ ' + owner.toUpperCase() + '  ';
    expect(isRoomInvite(raw)).toBe(true);
    expect(parseInvite(raw)).toEqual({ code: current + '-e2e', ownerPin: owner });
  });
  it.each([
    'bright-frosty-swift-harbor-anchor-6259',
    'swift-amber-otter-comet-48219',
    'bright-frosty-swift-harbor-anchor-62590-e2e~',
    'bright-frosty-swift-harbor-anchor-62590-e2e~not-a-pin',
    current + '~' + owner + '~' + owner,
    current + '-unexpected',
    '',
  ])('rejects incomplete or altered invites without dropping the owner pin: %s', raw => {
    expect(isRoomInvite(raw)).toBe(false);
  });
});
