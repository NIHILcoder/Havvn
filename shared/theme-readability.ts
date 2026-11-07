import { contrastRatio } from './contrast';
import { parseColor, toRgbString } from './color';

export const TEXT_CONTRAST_PAIRS: readonly (readonly [string, string])[] = [
  ['--color-text-primary', '--color-bg-primary'], ['--color-text-primary', '--color-bg-secondary'],
  ['--color-text-primary', '--color-bg-tertiary'], ['--color-text-primary', '--color-bg-elevated'],
  ['--color-text-secondary', '--color-bg-primary'], ['--color-text-secondary', '--color-bg-elevated'],
  ['--color-text-tertiary', '--color-bg-elevated'], ['--color-accent-primary', '--color-bg-primary'],
  ['--color-accent-primary-hover', '--color-bg-primary'],
  ['--color-text-on-accent', '--color-accent-primary'],
  ['--color-text-on-accent', '--color-accent-primary-hover'],
];
export const BODY_TEXT_CONTRAST = 4.5;
export type ColorTokens = Readonly<Record<string, string>>;
export function inspectReadability(tokens: ColorTokens) {
  return TEXT_CONTRAST_PAIRS.map(([fg, bg]) => ({ fg, bg, ratio: contrastRatio(tokens[fg] ?? '', tokens[bg] ?? '', tokens['--color-bg-primary']) }));
}

/** Propose foreground changes only. Never claim a fix unless every checked
 * background for that foreground passes, using the final serialized color. */
export function proposeReadableColors(tokens: ColorTokens): Record<string, string> {
  const patch: Record<string, string> = {};
  const base = tokens['--color-bg-primary'];
  for (const fg of new Set(TEXT_CONTRAST_PAIRS.map(pair => pair[0]))) {
    // Accent colours are also button backgrounds. Later label corrections must
    // be checked against the accent colours proposed earlier in this repair.
    const effective = { ...tokens, ...patch };
    const backgrounds = TEXT_CONTRAST_PAIRS.filter(pair => pair[0] === fg).map(pair => effective[pair[1]] ?? '');
    const passes = (color: string) => backgrounds.every(bg => (contrastRatio(color, bg, base) ?? 0) >= BODY_TEXT_CONTRAST);
    if (passes(effective[fg] ?? '')) continue;
    const original = parseColor(effective[fg] ?? '') ?? { r: 128, g: 128, b: 128, a: 1 };
    let best: { color: string; distance: number } | undefined;
    for (const end of [0, 255]) for (let step = 0; step <= 255; step++) {
      const amount = step / 255;
      const rgb = { r: Math.round(original.r + (end - original.r) * amount), g: Math.round(original.g + (end - original.g) * amount), b: Math.round(original.b + (end - original.b) * amount), a: 1 };
      const color = toRgbString(rgb);
      const distance = (rgb.r - original.r) ** 2 + (rgb.g - original.g) ** 2 + (rgb.b - original.b) ** 2;
      if (passes(color) && (!best || distance < best.distance)) best = { color, distance };
    }
    if (best) patch[fg] = best.color;
  }
  return patch;
}
