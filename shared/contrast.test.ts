import { describe, it, expect } from 'vitest';
import { relativeLuminance, contrastRatio, wcagLevel, compositeOver } from './contrast';

describe('relativeLuminance', () => {
  it('is 1 for white and 0 for black', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black/white either way', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 4);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 4);
  });

  it('is 1 for identical colors', () => {
    expect(contrastRatio('#345678', '#345678')).toBeCloseTo(1, 5);
  });

  it('matches a known reference pair (#777 on white ~= 4.48)', () => {
    const r = contrastRatio('#777777', '#ffffff');
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(4.4);
    expect(r as number).toBeLessThan(4.6);
  });

  it('composites a translucent foreground over the background', () => {
    // Fully transparent fg → same color as bg → ratio 1.
    expect(contrastRatio('rgba(0,0,0,0)', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('composites a translucent background over the given base, not white', () => {
    // On a dark base, a translucent dark surface is dark → high contrast with light text.
    const overDark = contrastRatio('#cccccc', 'rgba(20,20,20,0.6)', '#0a0a0a');
    expect(overDark as number).toBeGreaterThan(9);
    // Same inputs but defaulting to white composites to mid-gray → much lower.
    const overWhite = contrastRatio('#cccccc', 'rgba(20,20,20,0.6)');
    expect(overWhite as number).toBeLessThan(4);
  });

  it('returns null on unparseable input', () => {
    expect(contrastRatio('nope', '#fff')).toBeNull();
    expect(contrastRatio('#fff', 'var(--x)')).toBeNull();
  });
});

describe('wcagLevel', () => {
  it('classifies against WCAG thresholds', () => {
    expect(wcagLevel(21)).toBe('AAA');
    expect(wcagLevel(7)).toBe('AAA');
    expect(wcagLevel(4.5)).toBe('AA');
    expect(wcagLevel(3)).toBe('AA-large');
    expect(wcagLevel(2.9)).toBe('fail');
  });
});

describe('compositeOver', () => {
  it('50% black over white is mid-gray', () => {
    const c = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(c.r).toBeCloseTo(127.5, 1);
    expect(c.a).toBe(1);
  });
});
