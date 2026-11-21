import { describe, expect, it } from 'vitest';
import { inspectReadability, proposeReadableColors, BODY_TEXT_CONTRAST } from './theme-readability';
import { contrastRatio } from './contrast';

const colors = (bg: string, fg: string) => ({
  '--color-bg-primary': bg, '--color-bg-secondary': bg, '--color-bg-tertiary': bg, '--color-bg-elevated': bg,
  '--color-text-primary': fg, '--color-text-secondary': fg, '--color-text-tertiary': fg,
  '--color-accent-primary': fg, '--color-accent-primary-hover': fg,
  '--color-text-on-accent': bg,
});
describe('theme readability repair', () => {
  it.each([['#101010', '#171717'], ['#fafafa', '#f2f2f2'], ['rgba(0,0,0,0.8)', 'rgba(0,0,0,0.1)']])('proposes readable body text on %s', (bg, fg) => {
    const tokens = colors(bg, fg), before = structuredClone(tokens), patch = proposeReadableColors(tokens);
    expect(Object.keys(patch).length).toBeGreaterThan(0);
    expect(tokens).toEqual(before);
    expect(inspectReadability({ ...tokens, ...patch }).every(row => row.ratio !== null && row.ratio >= BODY_TEXT_CONTRAST)).toBe(true);
    expect(Object.keys(patch).every(key => !key.includes('bg-'))).toBe(true);
  });
  it('keeps already readable colors and is idempotent', () => {
    const tokens = colors('#111111', '#eeeeee'); expect(proposeReadableColors(tokens)).toEqual({});
    const broken = colors('#111111', '#111111'), patched = { ...broken, ...proposeReadableColors(broken) };
    expect(proposeReadableColors(patched)).toEqual({});
  });
  it('checks all shared text surfaces instead of fixing only the first background', () => {
    const tokens = { ...colors('#000000', '#777777'), '--color-bg-elevated': '#ffffff' };
    const patch = proposeReadableColors(tokens), patched = { ...tokens, ...patch };
    expect(inspectReadability(patched).filter(row => row.fg === '--color-text-primary').every(row => row.ratio! >= BODY_TEXT_CONTRAST)).toBe(true);
  });
  it('does not claim a fix when surfaces cannot share a readable foreground', () => {
    const tokens = { ...colors('#000000', '#444444'), '--color-bg-secondary': '#777777', '--color-bg-elevated': '#ffffff' };
    const patch = proposeReadableColors(tokens);
    expect(patch['--color-text-primary']).toBeUndefined();
    expect(inspectReadability({ ...tokens, ...patch }).some(row => row.ratio === null || row.ratio < BODY_TEXT_CONTRAST)).toBe(true);
  });
  it('unknown or invalid backgrounds remain visible as unmeasurable, without inventing a passing result', () => {
    const tokens = { ...colors('var(--missing)', '#fff'), '--color-accent-primary': 'var(--missing)', '--color-accent-primary-hover': 'var(--missing)' };
    expect(inspectReadability(tokens).every(row => row.ratio === null)).toBe(true);
    expect(proposeReadableColors(tokens)).toEqual({});
  });
  it('detects unreadable button labels on both gradient stops and proposes a readable label', () => {
    const tokens = { ...colors('#101010', '#eeeeee'), '--color-text-on-accent': '#dddddd' };
    const rows = inspectReadability(tokens).filter(row => row.fg === '--color-text-on-accent');
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ratio! < BODY_TEXT_CONTRAST)).toBe(true);
    const patched = { ...tokens, ...proposeReadableColors(tokens) };
    for (const background of ['--color-accent-primary', '--color-accent-primary-hover']) {
      expect(contrastRatio(patched['--color-text-on-accent'], patched[background], patched['--color-bg-primary'])!).toBeGreaterThanOrEqual(BODY_TEXT_CONTRAST);
    }
  });
  it('keeps button labels readable after repairing the accent colours too', () => {
    const tokens = { ...colors('#101010', '#171717'), '--color-text-on-accent': '#dddddd' };
    const patched = { ...tokens, ...proposeReadableColors(tokens) };
    for (const background of ['--color-accent-primary', '--color-accent-primary-hover']) {
      expect(contrastRatio(patched['--color-text-on-accent'], patched[background], patched['--color-bg-primary'])!).toBeGreaterThanOrEqual(BODY_TEXT_CONTRAST);
    }
    expect(inspectReadability(patched).every(row => row.ratio! >= BODY_TEXT_CONTRAST)).toBe(true);
  });
});
