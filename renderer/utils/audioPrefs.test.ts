import { describe, it, expect } from 'vitest';
import {
  normalizeAudioPrefs, DEFAULT_AUDIO_PREFS, EQ_FREQS, EQ_LIMIT, EQ_PRESETS,
  presetFor, gainFromDb, nextIndex,
} from './audioPrefs';

describe('audio preferences', () => {
  it('turns anything at all into a usable set', () => {
    // Storage is hand-editable and survives across versions; a bad read must cost
    // the setting, never the playback.
    for (const junk of [null, undefined, 'nope', 42, [], { bands: 'loud' }]) {
      const p = normalizeAudioPrefs(junk);
      expect(p.bands).toHaveLength(EQ_FREQS.length);
      expect(p.repeat).toBe('off');
      expect(p.preamp).toBe(0);
    }
  });

  it('pads and trims the band list to the number of bands the UI draws', () => {
    // A build that changes EQ_FREQS must not leave a listener with a curve whose
    // sliders do not line up with the filters.
    expect(normalizeAudioPrefs({ bands: [3] }).bands).toEqual([3, 0, 0, 0, 0]);
    expect(normalizeAudioPrefs({ bands: [1, 2, 3, 4, 5, 6, 7] }).bands).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps every gain to the range the sliders can express', () => {
    const p = normalizeAudioPrefs({ preamp: 99, bands: [-99, 99, 1.234, NaN, Infinity] });
    expect(p.preamp).toBe(EQ_LIMIT);
    // Out of range clamps to the edge; NOT A NUMBER falls back to flat — an
    // infinity is a corrupt value, not a listener asking for maximum bass.
    expect(p.bands).toEqual([-EQ_LIMIT, EQ_LIMIT, 1.2, 0, 0]);
  });

  it('defaults to opening in a window, and lets that be turned off', () => {
    expect(DEFAULT_AUDIO_PREFS.detachOnOpen).toBe(true);
    expect(normalizeAudioPrefs({}).detachOnOpen).toBe(true);
    expect(normalizeAudioPrefs({ detachOnOpen: false }).detachOnOpen).toBe(false);
  });

  it('names a curve only when it matches a preset exactly', () => {
    expect(presetFor(EQ_PRESETS.bass as number[])).toBe('bass');
    expect(presetFor([0, 0, 0, 0, 0])).toBe('flat');
    expect(presetFor([7, 4, 0, -1, 0])).toBeNull();
  });

  it('converts dB to the linear gain a GainNode wants', () => {
    expect(gainFromDb(0)).toBe(1);
    expect(gainFromDb(6)).toBeCloseTo(1.995, 2);
    expect(gainFromDb(-6)).toBeCloseTo(0.501, 2);
  });

  describe('the next track', () => {
    const off = { repeat: 'off' as const, shuffle: false };
    const all = { repeat: 'all' as const, shuffle: false };

    it('walks the queue and stops at the end unless it repeats', () => {
      expect(nextIndex(0, 3, off)).toBe(1);
      expect(nextIndex(2, 3, off)).toBeNull();
      expect(nextIndex(2, 3, all)).toBe(0);
    });

    it('never shuffles into the track that is already playing', () => {
      // A "random" pick that lands on the current song reads as a stuck player, so
      // the draw is over the OTHER tracks and mapped back around the current index.
      const shuffled = { repeat: 'off' as const, shuffle: true };
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        for (let cur = 0; cur < 4; cur++) {
          const n = nextIndex(cur, 4, shuffled, () => r);
          expect(n).not.toBe(cur);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(4);
        }
      }
    });

    it('handles the degenerate queues instead of looping on them', () => {
      expect(nextIndex(0, 0, all)).toBeNull();
      expect(nextIndex(0, 1, off)).toBeNull();
      expect(nextIndex(0, 1, all)).toBe(0);
      // One track and shuffle on: there is nothing else to pick, and the draw above
      // would otherwise index outside the queue.
      expect(nextIndex(0, 1, { repeat: 'off', shuffle: true })).toBeNull();
    });
  });
});
