/**
 * Deterministic identicon SVG — same hash / palette / styles as the desktop
 * Identicon so a guest wearing `rings:7f3a9c` looks like the same person in-app.
 */

export const AVATAR_STYLES = ['mirror', 'grid', 'rings', 'bauhaus', 'pixel', 'orbit'] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseAvatar(seed: string): { style: AvatarStyle; base: string } {
  const i = (seed || '').indexOf(':');
  if (i > 0) {
    const prefix = seed.slice(0, i);
    if ((AVATAR_STYLES as readonly string[]).includes(prefix)) {
      return { style: prefix as AvatarStyle, base: seed.slice(i + 1) || 'anon' };
    }
  }
  return { style: 'mirror', base: seed || 'anon' };
}

export function makeAvatarSeed(style: AvatarStyle, base: string): string {
  return `${style}:${base}`;
}

function palette(rng: () => number): { c1: string; c2: string; angle: number; fg: string } {
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 35 + Math.floor(rng() * 90)) % 360;
  return {
    c1: `hsl(${h1} 72% 56%)`,
    c2: `hsl(${h2} 70% 44%)`,
    angle: Math.floor(rng() * 360),
    fg: 'rgba(255,255,255,0.94)',
  };
}

function rects(cells: boolean[], cols: number, size: number, padRatio: number, rxRatio: number, fg: string): string {
  const cell = size / cols;
  const pad = cell * padRatio;
  const rx = Math.max(0.5, cell * rxRatio);
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    out += `<rect x="${(i % cols) * cell + pad}" y="${Math.floor(i / cols) * cell + pad}" width="${cell - pad * 2}" height="${cell - pad * 2}" rx="${rx}" fill="${fg}"/>`;
  }
  return out;
}

function fgSvg(style: AvatarStyle, rng: () => number, size: number, fg: string): string {
  if (style === 'grid') {
    const cells = new Array(9).fill(false) as boolean[];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const on = rng() > 0.42;
        cells[row * 3 + col] = on;
        cells[row * 3 + (2 - col)] = on;
      }
    }
    return rects(cells, 3, size, 0.16, 0.28, fg);
  }
  if (style === 'pixel') {
    const cells = new Array(49).fill(false) as boolean[];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 4; col++) {
        const on = rng() > 0.55;
        cells[row * 7 + col] = on;
        cells[row * 7 + (6 - col)] = on;
      }
    }
    return rects(cells, 7, size, 0.1, 0.12, fg);
  }
  if (style === 'rings') {
    const cx = size * (0.42 + rng() * 0.16);
    const cy = size * (0.42 + rng() * 0.16);
    const count = 3 + Math.floor(rng() * 2);
    let out = '';
    for (let i = 0; i < count; i++) {
      const r = size * (0.12 + i * 0.13);
      const sw = Math.max(2, size * (0.05 + rng() * 0.05));
      const op = 0.35 + rng() * 0.6;
      const dash = rng() > 0.5 ? ` stroke-dasharray="${r * 1.4} ${r * 0.9}"` : '';
      out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-width="${sw}" stroke-opacity="${op}"${dash}/>`;
    }
    return out;
  }
  if (style === 'orbit') {
    const cx = size * (0.4 + rng() * 0.2);
    const cy = size * (0.4 + rng() * 0.2);
    let out = `<circle cx="${cx}" cy="${cy}" r="${size * (0.1 + rng() * 0.08)}" fill="${fg}" fill-opacity="0.95"/>`;
    const rings = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < rings; i++) {
      const r = size * (0.2 + i * 0.14 + rng() * 0.04);
      out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-width="${Math.max(1, size * 0.02)}" stroke-opacity="0.45"/>`;
      const moons = 1 + Math.floor(rng() * 2);
      for (let m = 0; m < moons; m++) {
        const a = rng() * Math.PI * 2;
        out += `<circle cx="${cx + Math.cos(a) * r}" cy="${cy + Math.sin(a) * r}" r="${Math.max(1.5, size * (0.035 + rng() * 0.035))}" fill="${fg}" fill-opacity="0.9"/>`;
      }
    }
    return out;
  }
  if (style === 'bauhaus') {
    let out = '';
    const shapes = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < shapes; i++) {
      const op = 0.45 + rng() * 0.5;
      const pick = Math.floor(rng() * 4);
      const cx = size * (0.2 + rng() * 0.6);
      const cy = size * (0.2 + rng() * 0.6);
      const s = size * (0.22 + rng() * 0.3);
      if (pick === 0) out += `<circle cx="${cx}" cy="${cy}" r="${s / 2}" fill="${fg}" fill-opacity="${op}"/>`;
      else if (pick === 1) {
        const rot = Math.floor(rng() * 180);
        out += `<rect x="${cx - s / 2}" y="${cy - s * 0.16}" width="${s}" height="${s * 0.32}" rx="${s * 0.16}" fill="${fg}" fill-opacity="${op}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      } else if (pick === 2) {
        const rot = Math.floor(rng() * 360);
        const h = s * 0.9;
        out += `<polygon points="${cx},${cy - h / 2} ${cx - s / 2},${cy + h / 2} ${cx + s / 2},${cy + h / 2}" fill="${fg}" fill-opacity="${op}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      } else {
        const rot = Math.floor(rng() * 360);
        const r = s / 2;
        out += `<path d="M ${cx} ${cy} L ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z" fill="${fg}" fill-opacity="${op}" transform="rotate(${rot} ${cx} ${cy})"/>`;
      }
    }
    return out;
  }
  const cells = new Array(25).fill(false) as boolean[];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const on = rng() > 0.5;
      cells[row * 5 + col] = on;
      cells[row * 5 + (4 - col)] = on;
    }
  }
  return rects(cells, 5, size, 0.12, 0.18, fg);
}

let uid = 0;

export function identiconSvg(seed: string, size: number, online?: boolean): string {
  const { style, base } = parseAvatar(seed);
  const pal = palette(mulberry32(hashSeed(base)));
  const rng = mulberry32(hashSeed(base + '|' + style));
  const id = 'g' + (++uid);
  const dot = online === undefined ? '' : `<span class="identicon-status ${online ? 'online' : 'offline'}" style="width:${Math.max(7, Math.round(size * 0.22))}px;height:${Math.max(7, Math.round(size * 0.22))}px"></span>`;
  return `<span class="identicon" style="width:${size}px;height:${size}px">${
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><defs>`
    + `<linearGradient id="${id}" gradientTransform="rotate(${pal.angle} 0.5 0.5)"><stop offset="0%" stop-color="${pal.c1}"/><stop offset="100%" stop-color="${pal.c2}"/></linearGradient>`
    + `</defs><rect width="${size}" height="${size}" fill="url(#${id})"/>${fgSvg(style, rng, size, pal.fg)}</svg>`
  }${dot}</span>`;
}

export function randomAvatarBase(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(36) + Date.now().toString(36).slice(-3);
}
