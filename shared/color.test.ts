import { describe, it, expect } from 'vitest';
import { parseColor, rgbToHsl, hslToRgb, toHex, toRgbString, toTriplet } from './color';

describe('parseColor', () => {
  it('parses hex 3/4/6/8', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('#00000080')?.a).toBeCloseTo(128 / 255, 3);
    const short = parseColor('#f008');
    expect(short?.r).toBe(255);
    expect(short?.a).toBeCloseTo(0x88 / 255, 3);
  });

  it('parses rgb/rgba with comma or space/slash separators', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it('parses hsl to the right rgb', () => {
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor('hsl(240, 100%, 50%)')).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  it('parses named colors and transparent', () => {
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('parses a bare r,g,b triplet (the --*-rgb token shape)', () => {
    expect(parseColor('232, 121, 43')).toEqual({ r: 232, g: 121, b: 43, a: 1 });
  });

  it('rejects junk', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('rgb(zz)')).toBeNull();
    expect(parseColor('not-a-color')).toBeNull();
    expect(parseColor('300, 0')).toBeNull();
  });

  it('does not throw on inherited object keys', () => {
    expect(parseColor('constructor')).toBeNull();
    expect(parseColor('__proto__')).toBeNull();
    expect(parseColor('hasOwnProperty')).toBeNull();
    expect(parseColor('toString')).toBeNull();
  });

  it('rejects a present-but-malformed alpha instead of coercing to opaque', () => {
    expect(parseColor('rgba(1, 2, 3, zz)')).toBeNull();
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });
});

describe('hsl <-> rgb round trips', () => {
  it('round-trips primaries', () => {
    for (const c of [{ r: 255, g: 0, b: 0, a: 1 }, { r: 0, g: 255, b: 0, a: 1 }, { r: 0, g: 0, b: 255, a: 1 }, { r: 128, g: 64, b: 200, a: 1 }]) {
      const back = hslToRgb(rgbToHsl(c));
      expect(back.r).toBeCloseTo(c.r, -0.5);
      expect(back.g).toBeCloseTo(c.g, -0.5);
      expect(back.b).toBeCloseTo(c.b, -0.5);
    }
  });

  it('grayscale has zero saturation', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128, a: 1 }).s).toBe(0);
  });
});

describe('formatting', () => {
  it('toHex drops alpha when opaque, keeps it when asked', () => {
    expect(toHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 }, true)).toBe('#ff000080');
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 }, false)).toBe('#ff0000');
  });

  it('toRgbString switches rgb/rgba on alpha', () => {
    expect(toRgbString({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(toRgbString({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('toTriplet emits the bare shape', () => {
    expect(toTriplet({ r: 232, g: 121, b: 43, a: 1 })).toBe('232, 121, 43');
  });
});
