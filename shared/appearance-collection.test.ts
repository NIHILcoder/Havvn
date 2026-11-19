import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APPEARANCE_COLLECTION, collectionProfile } from './appearance-collection';
import { validateAppearanceProfile } from './appearance-profile';
import { SCENIC_BACKGROUNDS } from './appearance';
import { inspectReadability } from './theme-readability';
import { validateTheme } from './theme';

describe('illustrated appearance collection', () => {
  it('round-trips all ten complete profiles through the import trust boundary', () => {
    expect(APPEARANCE_COLLECTION).toHaveLength(10);
    expect(new Set(APPEARANCE_COLLECTION.map(spec => spec.id))).toEqual(new Set(SCENIC_BACKGROUNDS));
    for (const spec of APPEARANCE_COLLECTION) {
      const p = collectionProfile(spec);
      expect(validateAppearanceProfile(JSON.parse(JSON.stringify(p))), spec.id).toEqual(p);
      expect(validateTheme(p.theme), spec.id).toEqual({ ok: true, theme: p.theme, warnings: [] });
      expect(p.appearance.background).toBe(spec.id);
    }
  });

  it('keeps text and accents legible in both palette modes', () => {
    for (const spec of APPEARANCE_COLLECTION) for (const mode of ['dark', 'light'] as const) {
      const theme = collectionProfile(spec).theme!;
      for (const pair of inspectReadability(theme[mode])) {
        expect(pair.ratio, `${spec.id}/${mode}: ${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('ships a distinct local illustration and translated labels for every profile', () => {
    const css = readFileSync('renderer/styles/appearance-scenes.css', 'utf8');
    const images = new Set<string>();
    for (const locale of ['en', 'ru']) {
      const dict = JSON.parse(readFileSync(`renderer/i18n/${locale}.json`, 'utf8'));
      for (const spec of APPEARANCE_COLLECTION) {
        expect(dict[`appearance.collection.${spec.id}.name`]).toBeTruthy();
        expect(dict[`appearance.collection.${spec.id}.description`]).toBeTruthy();
        expect(dict[`appearance.background.${spec.id}`]).toBeTruthy();
      }
    }
    for (const spec of APPEARANCE_COLLECTION) {
      const svg = readFileSync(`renderer/assets/scenes/${spec.id}.svg`, 'utf8');
      expect(svg).toContain('viewBox="0 0 1600 1000"');
      expect(svg).not.toMatch(/<script|<foreignObject|href=|url\(https?:/i);
      expect(css).toContain(`../assets/scenes/${spec.id}.svg`);
      images.add(svg);
    }
    expect(images.size).toBe(10);
  });
});
