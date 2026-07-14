import { describe, it, expect } from 'vitest';
import { generatePalette, adaptVariant } from './palette';
import { parseColor } from './color';
import { contrastRatio } from './contrast';
import { sanitizeTokenValue } from './theme';

describe('generatePalette', () => {
  it('returns {} on unparseable input', () => {
    expect(generatePalette({ accent: 'nope', bg: '#111' })).toEqual({});
    expect(generatePalette({ accent: '#f90', bg: 'nope' })).toEqual({});
  });

  it('keeps the exact background as bg-primary and derives the accent group', () => {
    const p = generatePalette({ accent: '#3f7fff', bg: '#141519' });
    expect(p['--color-bg-primary']).toBe('#141519');
    expect(p['--color-accent-primary']).toBe('#3f7fff');
    expect(p['--color-accent-rgb']).toBe('63, 127, 255');
  });

  it('produces readable primary-text-on-background contrast (AA+), incl. mid-tones', () => {
    for (const bg of ['#141519', '#0b1020', '#f6f4f0', '#ffffff', '#808080', '#999999', '#666666', '#3a3a3a']) {
      const p = generatePalette({ accent: '#e8792b', bg });
      const ratio = contrastRatio(p['--color-text-primary'], p['--color-bg-primary']);
      expect(ratio, `contrast for bg ${bg}`).not.toBeNull();
      expect(ratio as number, `contrast for bg ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the elevated surface distinct from the page even on a pure-white seed', () => {
    for (const bg of ['#ffffff', '#f6f4f0', '#141519']) {
      const p = generatePalette({ accent: '#e8792b', bg });
      expect(p['--color-bg-elevated'], `elevated for ${bg}`).not.toBe(p['--color-bg-primary']);
    }
  });

  it('emits only sanitizer-valid values', () => {
    const p = generatePalette({ accent: '#e8792b', bg: '#141519' });
    for (const [k, v] of Object.entries(p)) {
      expect(sanitizeTokenValue(k, v), `${k}=${v}`).not.toBeNull();
    }
  });
});

describe('adaptVariant', () => {
  it('inverts lightness so a dark bg becomes light (and vice-versa)', () => {
    const dark = { '--color-bg-primary': '#141519', '--color-text-primary': '#ececec' };
    const light = adaptVariant(dark);
    const bg = parseColor(light['--color-bg-primary'])!;
    const text = parseColor(light['--color-text-primary'])!;
    // dark bg -> light bg
    expect((bg.r + bg.g + bg.b) / 3).toBeGreaterThan(160);
    // light text -> dark text
    expect((text.r + text.g + text.b) / 3).toBeLessThan(90);
  });

  it('preserves the accent group and non-color tokens verbatim', () => {
    const src = {
      '--color-accent-primary': '#e8792b',
      '--color-accent-rgb': '232, 121, 43',
      '--radius-md': '10px',
      '--color-bg-primary': '#141519',
    };
    const out = adaptVariant(src);
    expect(out['--color-accent-primary']).toBe('#e8792b');
    expect(out['--color-accent-rgb']).toBe('232, 121, 43');
    expect(out['--radius-md']).toBe('10px');
    expect(out['--color-bg-primary']).not.toBe('#141519'); // flipped
  });

  it('carries alpha through on translucent colors', () => {
    const out = adaptVariant({ '--color-success-bg': 'rgba(63, 185, 80, 0.15)' });
    const p = parseColor(out['--color-success-bg']);
    expect(p).not.toBeNull();
    expect(p!.a).toBeCloseTo(0.15, 2);
  });

  it('emits only sanitizer-valid values', () => {
    const out = adaptVariant({
      '--color-bg-primary': '#141519',
      '--color-text-primary': '#ececec',
      '--color-success-rgb': '63, 185, 80',
    });
    for (const [k, v] of Object.entries(out)) {
      expect(sanitizeTokenValue(k, v), `${k}=${v}`).not.toBeNull();
    }
  });
});
