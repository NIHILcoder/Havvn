import { describe, it, expect } from 'vitest';
import {
  TOKEN_WHITELIST,
  tokenCategory,
  sanitizeTokenValue,
  deriveAccent,
  validateTheme,
  applyTheme,
  clearAppliedTheme,
  FONT_OPTIONS,
  EDITABLE_TOKENS,
  ADVANCED_GROUPS,
  sanitizeFontData,
  type Theme,
  type ThemeApplyTarget,
} from './theme';

/** Records every setProperty/removeProperty/setAttribute for assertions. */
function fakeRoot() {
  const props = new Map<string, string>();
  const removed: string[] = [];
  let attr = '';
  const root: ThemeApplyTarget = {
    style: {
      setProperty: (n, v) => { props.set(n, v); },
      removeProperty: (n) => { removed.push(n); props.delete(n); },
    },
    setAttribute: (n, v) => { if (n === 'data-theme') attr = v; },
  };
  return { root, props, removed, get attr() { return attr; } };
}

describe('TOKEN_WHITELIST', () => {
  it('contains exactly the 126 :root tokens', () => {
    expect(TOKEN_WHITELIST.size).toBe(126);
  });
  it('includes representative real tokens', () => {
    for (const t of ['--color-bg-primary', '--color-accent-primary', '--color-logo', '--font-family', '--radius-lg', '--shadow-glow', '--z-modal']) {
      expect(TOKEN_WHITELIST.has(t)).toBe(true);
    }
  });
  it('excludes anything not defined in variables.css', () => {
    for (const t of ['--evil', '--color-nope', 'color', '--']) {
      expect(TOKEN_WHITELIST.has(t)).toBe(false);
    }
  });
});

describe('tokenCategory', () => {
  it('maps tokens to their value shape', () => {
    expect(tokenCategory('--color-accent-rgb')).toBe('colorTriplet');
    expect(tokenCategory('--color-bg-primary')).toBe('color');
    expect(tokenCategory('--glass-bg')).toBe('color');
    expect(tokenCategory('--glass-blur')).toBe('filter');
    expect(tokenCategory('--gradient-primary')).toBe('gradient');
    expect(tokenCategory('--shadow-glow')).toBe('shadow');
    expect(tokenCategory('--transition-fast')).toBe('transition');
    expect(tokenCategory('--line-height-normal')).toBe('number');
    expect(tokenCategory('--font-weight-bold')).toBe('fontWeight');
    expect(tokenCategory('--font-size-lg')).toBe('length');
    expect(tokenCategory('--font-family')).toBe('fontFamily');
    expect(tokenCategory('--z-modal')).toBe('integer');
    expect(tokenCategory('--space-4')).toBe('length');
    expect(tokenCategory('--radius-lg')).toBe('length');
    expect(tokenCategory('--sidebar-width')).toBe('length');
    expect(tokenCategory('--settings-content-max-width')).toBe('length');
  });
});

describe('sanitizeTokenValue — colors', () => {
  it('accepts hex, rgb/rgba, hsl, and named', () => {
    expect(sanitizeTokenValue('--color-bg-primary', '#141519')).toBe('#141519');
    expect(sanitizeTokenValue('--color-bg-primary', '#FFF')).toBe('#FFF');
    expect(sanitizeTokenValue('--color-bg-primary', '#f2913faa')).toBe('#f2913faa');
    expect(sanitizeTokenValue('--color-bg-hover', 'rgba(236, 235, 230, 0.06)')).toBe('rgba(236, 235, 230, 0.06)');
    expect(sanitizeTokenValue('--color-bg-primary', 'hsl(24, 88%, 60%)')).toBe('hsl(24, 88%, 60%)');
    expect(sanitizeTokenValue('--color-bg-primary', 'transparent')).toBe('transparent');
    expect(sanitizeTokenValue('--color-bg-primary', '  #141519  ')).toBe('#141519'); // trimmed
  });
  it('rejects malformed and non-color', () => {
    expect(sanitizeTokenValue('--color-bg-primary', '#12')).toBeNull();
    expect(sanitizeTokenValue('--color-bg-primary', 'reddish')).toBeNull();
    expect(sanitizeTokenValue('--color-bg-primary', '12px')).toBeNull();
    expect(sanitizeTokenValue('--color-bg-primary', 42)).toBeNull();
  });
});

describe('sanitizeTokenValue — the beacon / breakout vectors', () => {
  const attacks = [
    'url(https://evil.example/beacon)',
    'URL(https://evil.example)',
    "url('https://evil')",
    '#fff; background-image: url(https://evil)',
    'rgba(0,0,0,0.5); position: fixed',
    '@import "https://evil/x.css"',
    'expression(alert(1))',
    'javascript:alert(1)',
    'var(--x)',
    'image-set("https://evil" 1x)',
    '-webkit-cross-fade(url(a), url(b), 50%)',
    'element(#target)',
    'paint(evil)',
    'red/**/;color:blue',
    '<script>',
    'red}body{display:none',
  ];
  it('drops every attack on a color token', () => {
    for (const a of attacks) {
      expect(sanitizeTokenValue('--color-bg-primary', a)).toBeNull();
    }
  });
  it('drops url() smuggled into a gradient', () => {
    expect(sanitizeTokenValue('--gradient-primary', 'linear-gradient(#000, url(https://evil))')).toBeNull();
  });
  it('drops url() smuggled into a shadow', () => {
    expect(sanitizeTokenValue('--shadow-glow', '0 0 0 1px url(https://evil)')).toBeNull();
  });
  it('drops a control character (NUL) inside a value', () => {
    expect(sanitizeTokenValue('--color-bg-primary', '#fff' + String.fromCharCode(0))).toBeNull();
  });
  it('rejects an over-long value', () => {
    expect(sanitizeTokenValue('--color-bg-primary', '#' + 'a'.repeat(300))).toBeNull();
  });
});

describe('sanitizeTokenValue — non-color categories', () => {
  it('colorTriplet accepts 0-255 triplets only', () => {
    expect(sanitizeTokenValue('--color-accent-rgb', '242, 145, 63')).toBe('242, 145, 63');
    expect(sanitizeTokenValue('--color-accent-rgb', '300, 0, 0')).toBeNull();
    expect(sanitizeTokenValue('--color-accent-rgb', '#f2913f')).toBeNull();
  });
  it('gradient accepts linear/radial with stops', () => {
    expect(sanitizeTokenValue('--gradient-primary', 'linear-gradient(135deg, #F2913F 0%, #E0673A 100%)'))
      .toBe('linear-gradient(135deg, #F2913F 0%, #E0673A 100%)');
    expect(sanitizeTokenValue('--gradient-card', 'radial-gradient(circle, #1B1D22, #000)'))
      .toBe('radial-gradient(circle, #1B1D22, #000)');
    expect(sanitizeTokenValue('--gradient-primary', 'not-a-gradient')).toBeNull();
  });
  it('filter accepts only blur(<length>)', () => {
    expect(sanitizeTokenValue('--glass-blur', 'blur(20px)')).toBe('blur(20px)');
    expect(sanitizeTokenValue('--glass-blur', 'blur(1.5rem)')).toBe('blur(1.5rem)');
    expect(sanitizeTokenValue('--glass-blur', 'brightness(2)')).toBeNull();
  });
  it('length accepts units and bare 0', () => {
    expect(sanitizeTokenValue('--radius-lg', '10px')).toBe('10px');
    expect(sanitizeTokenValue('--space-4', '1.5rem')).toBe('1.5rem');
    expect(sanitizeTokenValue('--settings-content-max-width', '50%')).toBe('50%');
    expect(sanitizeTokenValue('--space-1', '0')).toBe('0');
    expect(sanitizeTokenValue('--radius-lg', '10')).toBeNull(); // no unit
  });
  it('number (line-height) accepts unitless or length', () => {
    expect(sanitizeTokenValue('--line-height-normal', '1.5')).toBe('1.5');
    expect(sanitizeTokenValue('--line-height-normal', '20px')).toBe('20px');
    expect(sanitizeTokenValue('--line-height-normal', 'tall')).toBeNull();
  });
  it('fontWeight accepts named + 100..900 hundreds', () => {
    expect(sanitizeTokenValue('--font-weight-bold', '700')).toBe('700');
    expect(sanitizeTokenValue('--font-weight-normal', 'normal')).toBe('normal');
    expect(sanitizeTokenValue('--font-weight-bold', '401')).toBeNull();
    expect(sanitizeTokenValue('--font-weight-bold', '1000')).toBeNull();
  });
  it('integer (z-index) accepts plain ints', () => {
    expect(sanitizeTokenValue('--z-modal', '400')).toBe('400');
    expect(sanitizeTokenValue('--z-modal', '10px')).toBeNull();
  });
  it('shadow accepts multi-layer shadows and none', () => {
    expect(sanitizeTokenValue('--shadow-lg', '0 8px 32px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.4)'))
      .toBe('0 8px 32px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.4)');
    expect(sanitizeTokenValue('--shadow-xs', 'none')).toBe('none');
  });
  it('transition accepts timing + easing', () => {
    expect(sanitizeTokenValue('--transition-fast', '150ms cubic-bezier(0.4, 0, 0.2, 1)'))
      .toBe('150ms cubic-bezier(0.4, 0, 0.2, 1)');
    expect(sanitizeTokenValue('--transition-fast', 'evil')).toBeNull();
  });
  it('fontFamily accepts a family stack, rejects punctuation', () => {
    expect(sanitizeTokenValue('--font-family', "'Inter', sans-serif")).toBe("'Inter', sans-serif");
    expect(sanitizeTokenValue('--font-family', "Inter; color:red")).toBeNull();
  });
});

describe('deriveAccent', () => {
  it('fans one hex out to the accent group', () => {
    const d = deriveAccent('#F2913F');
    expect(d).not.toBeNull();
    expect(d!['--color-accent-primary']).toBe('#f2913f');
    expect(d!['--color-accent-rgb']).toBe('242, 145, 63');
    expect(d!['--color-accent-bg']).toBe('rgba(242, 145, 63, 0.12)');
    expect(d!['--color-accent-primary-hover']).toMatch(/^#[0-9a-f]{6}$/);
    expect(d!['--color-accent-primary-hover']).not.toBe('#f2913f');
  });
  it('expands 3-digit hex', () => {
    expect(deriveAccent('#fff')!['--color-accent-primary']).toBe('#ffffff');
  });
  it('returns null for bad input', () => {
    expect(deriveAccent('rgb(1,2,3)')).toBeNull();
    expect(deriveAccent('not-a-color')).toBeNull();
    expect(deriveAccent('#12')).toBeNull();
  });
  it('every derived value survives its own sanitizer', () => {
    const d = deriveAccent('#3D7EA6')!;
    for (const [k, v] of Object.entries(d)) {
      expect(sanitizeTokenValue(k, v)).toBe(v);
    }
  });
});

describe('validateTheme — structure', () => {
  it('rejects non-objects', () => {
    expect(validateTheme(null).ok).toBe(false);
    expect(validateTheme([]).ok).toBe(false);
    expect(validateTheme('x').ok).toBe(false);
    expect(validateTheme(42).ok).toBe(false);
  });
  it('rejects a legacy theme with a bad base', () => {
    expect(validateTheme({ name: 'X', base: 'blue', tokens: {} }).ok).toBe(false);
  });
  it('rejects a missing name', () => {
    expect(validateTheme({ dark: {} }).ok).toBe(false);
    expect(validateTheme({ base: 'dark', tokens: {} }).ok).toBe(false);
  });
  it('rejects a legacy theme with non-object tokens', () => {
    expect(validateTheme({ name: 'X', base: 'dark', tokens: 'nope' }).ok).toBe(false);
    expect(validateTheme({ name: 'X', base: 'dark', tokens: [] }).ok).toBe(false);
  });
});

describe('validateTheme — dual-mode + legacy migration', () => {
  it('accepts a dual-mode theme and keeps valid tokens per variant', () => {
    const r = validateTheme({
      id: 'my-theme', name: 'My Theme',
      dark: { '--color-bg-primary': '#101010', '--color-accent-primary': '#00ffcc' },
      light: { '--color-bg-primary': '#fafafa' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.dark['--color-bg-primary']).toBe('#101010');
      expect(r.theme.dark['--color-accent-primary']).toBe('#00ffcc');
      expect(r.theme.light['--color-bg-primary']).toBe('#fafafa');
      expect(r.warnings).toHaveLength(0);
    }
  });
  it('migrates a legacy { base, tokens } theme into the matching variant', () => {
    const r = validateTheme({ name: 'Legacy', base: 'dark', tokens: { '--color-bg-primary': '#111' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.dark['--color-bg-primary']).toBe('#111');
      expect(r.theme.light).toEqual({}); // untouched → falls back to built-in light
    }
  });
  it('drops unknown keys with a warning but still validates', () => {
    const r = validateTheme({ name: 'X', dark: { '--evil': '#000', '--color-bg-primary': '#111' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.dark['--evil']).toBeUndefined();
      expect(r.theme.dark['--color-bg-primary']).toBe('#111');
      expect(r.warnings.some((w) => w.includes('--evil'))).toBe(true);
    }
  });
  it('drops a malicious token value but keeps the good ones (poison isolation)', () => {
    const r = validateTheme({
      name: 'Trojan',
      dark: { '--color-bg-primary': 'url(https://evil/beacon)', '--color-text-primary': '#eeeeee' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.dark['--color-bg-primary']).toBeUndefined();
      expect(r.theme.dark['--color-text-primary']).toBe('#eeeeee');
      expect(r.warnings.some((w) => w.includes('--color-bg-primary'))).toBe(true);
    }
  });
  it('validates and sanitizes an optional theme-level font', () => {
    const good = validateTheme({ name: 'X', dark: {}, light: {}, font: "'Inter', sans-serif" });
    expect(good.ok && good.theme.font).toBe("'Inter', sans-serif");
    const bad = validateTheme({ name: 'X', dark: {}, font: 'Inter; @import url(x)' });
    expect(bad.ok && bad.theme.font).toBeUndefined();
  });
  it('defaults a missing variant to an empty map', () => {
    const r = validateTheme({ name: 'Sparse', dark: { '--color-bg-primary': '#101010' } });
    expect(r.ok && r.theme.light).toEqual({});
  });
  it('strips control chars from the name and clamps length', () => {
    const r = validateTheme({ name: 'Nice\tName' + 'x'.repeat(200), dark: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.theme.name).not.toContain('\t'); // control char stripped (spaces are fine)
      expect(r.theme.name.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('applyTheme / clearAppliedTheme', () => {
  const theme: Theme = {
    id: 't', name: 'T',
    dark: { '--color-bg-primary': '#101010', '--radius-lg': '4px' },
    light: { '--color-bg-primary': '#fafafa' },
    font: "'Inter', sans-serif",
  };
  it('applies the requested variant and sets data-theme', () => {
    const f = fakeRoot();
    applyTheme(f.root, theme, 'dark');
    expect(f.attr).toBe('dark');
    expect(f.props.get('--color-bg-primary')).toBe('#101010');
    expect(f.props.get('--radius-lg')).toBe('4px');
    expect(f.props.get('--font-family')).toBe("'Inter', sans-serif");
  });
  it('applies the light variant when asked', () => {
    const f = fakeRoot();
    applyTheme(f.root, theme, 'light');
    expect(f.attr).toBe('light');
    expect(f.props.get('--color-bg-primary')).toBe('#fafafa');
    expect(f.props.has('--radius-lg')).toBe(false); // only present in the dark variant
  });
  it('clears prior overrides first (self-cleaning)', () => {
    const f = fakeRoot();
    applyTheme(f.root, theme, 'dark');
    expect(f.removed).toContain('--color-bg-primary');
    expect(f.removed.length).toBe(TOKEN_WHITELIST.size);
  });
  it('never writes a non-whitelisted token even if present', () => {
    const f = fakeRoot();
    applyTheme(f.root, { ...theme, dark: { ...theme.dark, '--evil': 'red' } as Record<string, string> }, 'dark');
    expect(f.props.has('--evil')).toBe(false);
  });
  it('clearAppliedTheme removes exactly the whitelist', () => {
    const f = fakeRoot();
    clearAppliedTheme(f.root);
    expect(f.removed.length).toBe(TOKEN_WHITELIST.size);
  });
});

describe('editor metadata', () => {
  it('FONT_OPTIONS stacks all survive the font sanitizer', () => {
    for (const opt of FONT_OPTIONS) {
      expect(sanitizeTokenValue('--font-family', opt.stack)).toBe(opt.stack);
    }
  });
  it('every EDITABLE_TOKENS entry references a whitelisted token', () => {
    for (const group of EDITABLE_TOKENS) {
      for (const t of group.tokens) {
        expect(TOKEN_WHITELIST.has(t.token)).toBe(true);
      }
    }
  });
});

describe('hardening — magnitude caps against griefing/DoS themes', () => {
  it('rejects any 7+ digit numeric run outright', () => {
    expect(sanitizeTokenValue('--glass-blur', 'blur(99999999px)')).toBeNull();
    expect(sanitizeTokenValue('--transition-normal', '99999999s')).toBeNull();
    expect(sanitizeTokenValue('--shadow-lg', '0 0 99999999px 99999999px #000')).toBeNull();
  });
  it('caps blur radius', () => {
    expect(sanitizeTokenValue('--glass-blur', 'blur(20px)')).toBe('blur(20px)');
    expect(sanitizeTokenValue('--glass-blur', 'blur(2000px)')).toBeNull();
  });
  it('caps length magnitude and clamps viewport units hard', () => {
    expect(sanitizeTokenValue('--space-4', '16px')).toBe('16px');
    expect(sanitizeTokenValue('--radius-full', '9999px')).toBe('9999px'); // real token value survives
    expect(sanitizeTokenValue('--space-16', '10001px')).toBeNull();
    expect(sanitizeTokenValue('--space-16', '99999vw')).toBeNull(); // the layout-bomb
    expect(sanitizeTokenValue('--space-16', '201vw')).toBeNull();
    expect(sanitizeTokenValue('--space-16', '100vw')).toBe('100vw');
  });
  it('caps z-index and line-height magnitude', () => {
    expect(sanitizeTokenValue('--z-modal', '400')).toBe('400');
    expect(sanitizeTokenValue('--z-modal-backdrop', '999999')).toBeNull();
    expect(sanitizeTokenValue('--line-height-normal', '1.5')).toBe('1.5');
    expect(sanitizeTokenValue('--line-height-normal', '5000')).toBeNull();
  });
  it('rejects syntactically-invalid rgb()/hsl() the charset check used to pass', () => {
    expect(sanitizeTokenValue('--glass-bg', 'rgb(zz)')).toBeNull();
    expect(sanitizeTokenValue('--glass-bg', 'rgb(255, 255, 255)')).toBe('rgb(255, 255, 255)');
    expect(sanitizeTokenValue('--color-bg-primary', 'hsl(24deg 88% 60% / 0.5)')).toBe('hsl(24deg 88% 60% / 0.5)');
  });
});

describe('applyTheme is self-defending (re-sanitizes untrusted drafts)', () => {
  it('drops a raw dangerous value even if it slipped into a variant', () => {
    const props = new Map<string, string>();
    const root: ThemeApplyTarget = {
      style: { setProperty: (n, v) => { props.set(n, v); }, removeProperty: (n) => { props.delete(n); } },
      setAttribute: () => {},
    };
    applyTheme(root, {
      id: 'x', name: 'X',
      dark: { '--color-bg-primary': 'url(https://evil/beacon)', '--color-text-primary': '#eee' },
      light: {},
    }, 'dark');
    expect(props.has('--color-bg-primary')).toBe(false); // dropped by the in-apply sanitizer
    expect(props.get('--color-text-primary')).toBe('#eee');
  });
});

describe('ADVANCED_GROUPS', () => {
  const flat = ADVANCED_GROUPS.flatMap((g) => g.tokens);

  it('covers every whitelisted token exactly once', () => {
    expect(new Set(flat).size).toBe(flat.length); // no duplicates
    expect(new Set(flat)).toEqual(new Set(TOKEN_WHITELIST)); // no missing / no unknown
    expect(flat.length).toBe(TOKEN_WHITELIST.size);
  });

  it('only lists whitelisted tokens', () => {
    for (const name of flat) expect(TOKEN_WHITELIST.has(name)).toBe(true);
  });

  it('has no empty groups and stable ids', () => {
    for (const g of ADVANCED_GROUPS) {
      expect(g.tokens.length).toBeGreaterThan(0);
      expect(g.labelKey.startsWith('settings.theme.adv.')).toBe(true);
    }
  });
});

describe('sanitizeFontData', () => {
  const okData = 'data:font/woff2;base64,d09GMgABAAAAAA==';

  it('accepts a well-formed base64 font data URL', () => {
    expect(sanitizeFontData(okData)).toBe(okData);
    expect(sanitizeFontData('data:font/ttf;base64,AAEAAAALAIAAAwAw')).not.toBeNull();
  });

  it('rejects non-font schemes, bad base64, and oversized blobs', () => {
    expect(sanitizeFontData('https://evil/font.woff2')).toBeNull();
    expect(sanitizeFontData('data:image/png;base64,AAAA')).toBeNull();
    expect(sanitizeFontData('data:font/woff2;base64,not base64!!')).toBeNull();
    expect(sanitizeFontData('data:font/woff2;base64,' + 'A'.repeat(2_000_001))).toBeNull();
    expect(sanitizeFontData(42)).toBeNull();
    expect(sanitizeFontData('')).toBeNull();
  });

  it('validateTheme keeps valid fontData and drops invalid', () => {
    const okv = validateTheme({ name: 'F', dark: {}, light: {}, font: "'tf-x', sans-serif", fontData: okData });
    expect(okv.ok && okv.theme.fontData).toBe(okData);
    const badv = validateTheme({ name: 'F', dark: {}, light: {}, fontData: 'https://evil/f.woff2' });
    expect(badv.ok && badv.theme.fontData).toBeUndefined();
    expect(badv.ok && badv.warnings.some((w) => /font data/i.test(w))).toBe(true);
  });
});
