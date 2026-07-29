import { describe, it, expect } from 'vitest';
import { resolveTrackers, RENDEZVOUS_TRACKERS, customTurnToIce } from './ice-servers';

// RENDEZVOUS_TRACKERS is resolved once at module load and reflects
// HAVVN_ROOM_TRACKERS when that is set, so these assertions compare against the
// exported value rather than a hard-coded list — they hold either way.
describe('resolveTrackers', () => {
  it('falls back to the module default when no list is configured', () => {
    expect(resolveTrackers('')).toEqual(RENDEZVOUS_TRACKERS);
    expect(resolveTrackers('   ')).toEqual(RENDEZVOUS_TRACKERS);
    expect(resolveTrackers(undefined)).toEqual(RENDEZVOUS_TRACKERS);
  });

  it('falls back when the configured list has nothing usable in it', () => {
    // The safety property: a typo must degrade to normal behaviour, never to a
    // room that announces nowhere and can therefore never find a peer.
    expect(resolveTrackers('tracker.example.com')).toEqual(RENDEZVOUS_TRACKERS);
    expect(resolveTrackers('http://tracker.example.com')).toEqual(RENDEZVOUS_TRACKERS);
  });

  it('never returns an empty list', () => {
    for (const raw of ['', '   ', undefined, 'nonsense', 'http://x.example', 'wss://ok.example']) {
      expect(resolveTrackers(raw).length).toBeGreaterThan(0);
    }
  });

  it('prefers the configured list when it parses (no dev override in play)', () => {
    // Skip when HAVVN_ROOM_TRACKERS is set: the override deliberately outranks
    // the stored setting, so "custom wins" is not the expected outcome there.
    if ((process.env.HAVVN_ROOM_TRACKERS || '').trim()) return;
    expect(resolveTrackers('wss://mine.example')).toEqual(['wss://mine.example']);
    expect(resolveTrackers('wss://a.example, http://bad.example')).toEqual(['wss://a.example']);
  });
});

describe('customTurnToIce', () => {
  it('returns nothing when no relay is configured', () => {
    expect(customTurnToIce()).toEqual([]);
    expect(customTurnToIce('')).toEqual([]);
    expect(customTurnToIce('   ')).toEqual([]);
  });

  it('builds a bare entry when only a URL is given', () => {
    expect(customTurnToIce('turn:relay.example.com:3478'))
      .toEqual([{ urls: 'turn:relay.example.com:3478' }]);
  });

  it('attaches credentials when both are present', () => {
    expect(customTurnToIce('turn:relay.example.com:3478', 'user', 'pass'))
      .toEqual([{ urls: 'turn:relay.example.com:3478', username: 'user', credential: 'pass' }]);
  });
});
