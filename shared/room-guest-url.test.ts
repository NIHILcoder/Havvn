import { describe, it, expect } from 'vitest';
import {
  ROOM_GUEST_BASE, PUBLIC_RENDEZVOUS_TRACKERS,
  buildGuestUrl, parseGuestLocation, resolveGuestTrackers,
} from './room-guest-url';

describe('room-guest-url', () => {
  const invite = 'swift-amber-otter-comet-4821~' + 'ab'.repeat(16);

  it('builds a hash-only URL for the public-tracker case (short QR)', () => {
    expect(buildGuestUrl(invite)).toBe(ROOM_GUEST_BASE + '#' + encodeURIComponent(invite));
    expect(buildGuestUrl(invite, [])).toBe(ROOM_GUEST_BASE + '#' + encodeURIComponent(invite));
  });

  it('encodes custom trackers as repeated tr= so a custom room stays findable', () => {
    const url = buildGuestUrl(invite, ['wss://mine.example/announce']);
    expect(url).toContain('?tr=' + encodeURIComponent('wss://mine.example/announce'));
    expect(url.endsWith('#' + encodeURIComponent(invite))).toBe(true);
  });

  it('parses hash invite and falls back to ?c=', () => {
    const fromHash = parseGuestLocation('#' + encodeURIComponent(invite), '');
    expect(fromHash.invite).toBe(invite);
    expect(fromHash.code).toBe('swift-amber-otter-comet-4821');
    expect(fromHash.ownerPin).toBe('ab'.repeat(16));
    expect(fromHash.trackers).toEqual([...PUBLIC_RENDEZVOUS_TRACKERS]);

    const fromQuery = parseGuestLocation('', '?c=' + encodeURIComponent(invite));
    expect(fromQuery.code).toBe('swift-amber-otter-comet-4821');
  });

  it('URL trackers replace the public set when they are usable wss://', () => {
    const loc = parseGuestLocation('#' + invite, '?tr=wss://a.example&tr=http://nope');
    expect(loc.trackers).toEqual(['wss://a.example']);
  });

  it('unusable URL trackers fall back to the public set', () => {
    expect(resolveGuestTrackers(['http://nope', 'garbage'])).toEqual([...PUBLIC_RENDEZVOUS_TRACKERS]);
  });
});
