import { DEFAULT_APPEARANCE, getThemeGlass, type Appearance } from './appearance';
import type { AppearanceProfile } from './appearance-profile';
import { FONT_OPTIONS, type Theme } from './theme';
import { contrastingTextColor } from './contrast';

type Palette = readonly [base: string, surface: string, raised: string, text: string,
  secondary: string, muted: string, accent: string, companion: string];
export interface CollectionSpec {
  id: Exclude<Appearance['background'], 'none' | 'aurora' | 'aero' | 'sunset' | 'image'>;
  name: string;
  dark: Palette;
  light: Palette;
  radius: number;
  font: 'inter' | 'system' | 'mono';
  mode: 'dark' | 'light';
  material: 'frosted' | 'liquid';
  opacity: number;
}

/** Each world has its own two-mode palette, typography, geometry and illustration. */
export const APPEARANCE_COLLECTION: readonly CollectionSpec[] = [
  { id: 'cyberpunk', name: 'Neon District', dark: ['#090D1B', '#11172B', '#20213F', '#EFFAFF', '#B8D3E5', '#93ADC8', '#42EDF5', '#FF55BA'],
    light: ['#EFF8FC', '#E2EDF6', '#FFFFFF', '#102339', '#354F68', '#526A82', '#006677', '#AC1765'], radius: 3, font: 'mono', mode: 'dark', material: 'liquid', opacity: 70 },
  { id: 'steampunk', name: 'Brass & Steam', dark: ['#1B1512', '#292019', '#3B2E22', '#F9EDD5', '#D5BE97', '#B49B78', '#E8B767', '#85C3B6'],
    light: ['#F4EAD7', '#EADBC0', '#FFF7E9', '#342619', '#63482F', '#796247', '#805014', '#26685C'], radius: 6, font: 'system', mode: 'dark', material: 'frosted', opacity: 84 },
  { id: 'solarpunk', name: 'Verdant Tomorrow', dark: ['#10221B', '#193229', '#244739', '#F0F8DF', '#BED8B6', '#96B59A', '#ACE07C', '#F3CE77'],
    light: ['#F4F7E8', '#E5EED6', '#FCFFF4', '#213A2A', '#3E6246', '#547558', '#3D701F', '#8A5C0B'], radius: 22, font: 'inter', mode: 'light', material: 'liquid', opacity: 76 },
  { id: 'cosmos', name: 'Orbital Silence', dark: ['#0B1023', '#141D35', '#222C4B', '#F1F0FF', '#C3C8E8', '#9CA8CE', '#BAA3FF', '#6BD5E5'],
    light: ['#F2F2FC', '#E6E8F5', '#FFFFFF', '#202544', '#464C73', '#60688B', '#6644B4', '#126A7D'], radius: 16, font: 'inter', mode: 'dark', material: 'liquid', opacity: 72 },
  { id: 'abyss', name: 'Bathysphere', dark: ['#061A22', '#0C2833', '#123D49', '#E7FCFA', '#AED5D6', '#83B4BE', '#62E3CE', '#83BCFF'],
    light: ['#EDF9F8', '#D9EFEE', '#F8FFFF', '#173A43', '#365D65', '#51757C', '#006B62', '#285F9C'], radius: 28, font: 'inter', mode: 'dark', material: 'liquid', opacity: 69 },
  { id: 'sakura', name: 'Kyoto After Rain', dark: ['#211725', '#302335', '#473047', '#FFF0F5', '#E4BFCE', '#BC99B0', '#FFA8C8', '#D1B4FA'],
    light: ['#FFF4F4', '#F5E3E8', '#FFFDFB', '#462B3B', '#715064', '#896779', '#A72C61', '#7150A0'], radius: 14, font: 'system', mode: 'dark', material: 'frosted', opacity: 78 },
  { id: 'deco', name: 'The Grand Royale', dark: ['#101D1E', '#192B2C', '#263B3A', '#FFF3D8', '#DAC99E', '#B7AB8D', '#E7C577', '#7CC7B4'],
    light: ['#F6F0E2', '#EAE1CB', '#FFFCF2', '#223B37', '#4F6251', '#6C7760', '#7F5A17', '#276B5D'], radius: 0, font: 'system', mode: 'dark', material: 'frosted', opacity: 89 },
  { id: 'synthwave', name: 'Sunset Drive 1986', dark: ['#1C102D', '#2B173E', '#42204F', '#FFF0FC', '#E8BCE0', '#C399BF', '#FF84CB', '#64E6F0'],
    light: ['#FFF0FA', '#F4E0F3', '#FFFCFF', '#422043', '#714C73', '#89698A', '#A62672', '#006E7A'], radius: 8, font: 'mono', mode: 'dark', material: 'liquid', opacity: 73 },
  { id: 'arcane', name: 'Obsidian Sanctum', dark: ['#171424', '#252036', '#383049', '#F5EEFF', '#CCC0E1', '#A69ABF', '#C2A0FF', '#8FD6B3'],
    light: ['#F5F0F9', '#E8E0F0', '#FFFBFF', '#352545', '#604C72', '#7D668E', '#7044A9', '#276F51'], radius: 10, font: 'system', mode: 'dark', material: 'frosted', opacity: 82 },
  { id: 'arctic', name: 'Polar Light', dark: ['#12212C', '#1D303D', '#2B4352', '#F0F9FC', '#C1D8E3', '#97B7C8', '#A2DEEE', '#B7C7FC'],
    light: ['#F3F8FB', '#E4EFF5', '#FFFFFF', '#1D3545', '#496474', '#5B7687', '#23677F', '#4F61A0'], radius: 18, font: 'inter', mode: 'light', material: 'frosted', opacity: 81 },
];

function paletteTokens(p: Palette, radius: number, light: boolean): Theme['dark'] {
  const [base, surface, raised, text, secondary, muted, accent, companion] = p;
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  const alpha = (hex: string, opacity: number) => `rgba(${rgb(hex)}, ${opacity})`;
  const semantic = light
    ? { success: '#216C50', warning: '#875300', error: '#AD2847', info: '#305EB1' }
    : { success: '#83DFAD', warning: '#F3CE77', error: '#FF91A5', info: '#99C4FF' };
  const tokens: Theme['dark'] = {
    '--color-bg-primary': base, '--color-bg-base': base,
    '--color-bg-secondary': surface, '--color-bg-subtle': surface,
    '--color-bg-tertiary': raised, '--color-bg-elevated': raised,
    '--color-bg-hover': alpha(text, .06), '--color-bg-active': alpha(accent, .14),
    '--color-text-primary': text, '--color-text-secondary': secondary,
    '--color-text-on-accent': contrastingTextColor([accent, companion]),
    '--color-text-tertiary': muted, '--color-text-muted': muted, '--color-text-disabled': alpha(text, .4),
    '--color-border-default': alpha(text, .15), '--color-border-subtle': alpha(text, .08),
    '--color-border-strong': alpha(text, .27), '--color-border-focus': accent,
    '--color-border': alpha(text, .15), '--color-border-hover': alpha(text, .27),
    '--color-accent-primary': accent, '--color-accent-primary-hover': companion,
    '--color-accent': accent, '--color-accent-hover': companion,
    '--color-accent-rgb': rgb(accent), '--color-accent-bg': alpha(accent, .13),
    '--color-accent-secondary': companion, '--color-accent-secondary-hover': accent,
    '--color-logo': accent, '--color-logo-outline': base, '--color-logo-glare': text,
    '--gradient-primary': `linear-gradient(130deg, ${accent}, ${companion})`,
    '--gradient-sidebar': `linear-gradient(180deg, ${surface}, ${base})`,
    '--gradient-card': `linear-gradient(135deg, ${surface}, ${raised})`,
    '--gradient-elevated': `linear-gradient(135deg, ${raised}, ${surface})`,
    '--glass-bg': alpha(surface, .8), '--glass-border': alpha(text, .15),
    '--radius-scale': `${radius}px`, '--shadow-focus': `0 0 0 3px ${alpha(accent, .35)}`,
    '--shadow-glow': `0 0 24px ${alpha(accent, .18)}`, '--shadow-glow-sm': `0 0 12px ${alpha(accent, .12)}`,
    '--color-video': companion, '--color-audio': accent, '--color-image': companion,
    '--color-archive': muted, '--color-document': text,
  };
  for (const [kind, color] of Object.entries(semantic)) {
    tokens[`--color-${kind}`] = color;
    tokens[`--color-${kind}-bg`] = alpha(color, .13);
    tokens[`--color-${kind}-rgb`] = rgb(color);
  }
  for (const [status, color] of Object.entries({ queued: muted, downloading: accent, paused: semantic.warning,
    completed: semantic.success, seeding: companion, error: semantic.error, removed: muted,
    connected: semantic.success, download: accent, upload: companion })) tokens[`--color-status-${status}`] = color;
  return tokens;
}

/** A fresh profile can be edited/exported through the existing profile controls. */
export function collectionProfile(spec: CollectionSpec, name = spec.name): AppearanceProfile {
  const appearance: Appearance = { ...structuredClone(DEFAULT_APPEARANCE), material: spec.material,
    background: spec.id, backgroundDim: spec.mode === 'light' ? 24 : 18,
    intensity: 75, opacity: spec.opacity, blur: spec.material === 'liquid' ? 20 : 14,
    highlight: spec.material === 'liquid' ? 48 : 24, depth: 30,
    radii: { panels: spec.radius, cards: spec.radius, buttons: Math.min(spec.radius, 16), inputs: Math.min(spec.radius, 12) } };
  const font = FONT_OPTIONS.find(option => option.id === spec.font)!.stack;
  return { version: 1, name, appearance,
    theme: { id: `collection-${spec.id}`, name: spec.name,
      dark: { ...paletteTokens(spec.dark, spec.radius, false), '--font-display': font },
      light: { ...paletteTokens(spec.light, spec.radius, true), '--font-display': font }, font, glass: getThemeGlass(appearance) },
    mode: spec.mode, accent: null, font: spec.font, density: 'normal', reduceMotion: false };
}
