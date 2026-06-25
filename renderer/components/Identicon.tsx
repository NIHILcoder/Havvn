/**
 * Identicon — a deterministic, colorful avatar generated purely from a seed
 * string. No network, no uploads: the same seed always yields the same avatar.
 *
 * Avatars are the one place in this otherwise-monochrome UI where colour earns
 * its keep — it's identity, and vivid gradients make members instantly
 * distinguishable.
 *
 * The seed may carry an optional style prefix, "<style>:<base>" (e.g.
 * "rings:7f3a9c"). When the prefix names a known style the avatar is drawn in
 * that style; otherwise the whole seed is treated as a plain seed and rendered
 * in the classic mirrored-glyph style. That keeps every pre-existing seed
 * (a bare memberId) rendering exactly as before, and lets a member pick a style
 * by simply changing their avatarSeed — which already syncs to peers.
 */

import React, { useMemo } from 'react';

export const AVATAR_STYLES = ['mirror', 'grid', 'rings', 'bauhaus'] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

interface IdenticonProps {
  seed: string;
  size?: number;
  /** Show a small online dot in the corner. */
  online?: boolean;
  /** Optional ring (used to highlight "you"). */
  ring?: boolean;
  className?: string;
  title?: string;
}

// FNV-1a → 32-bit, then mulberry32 PRNG for a stable stream of values.
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

/** Split a seed into its (optional) style prefix and base. */
export function parseAvatar(seed: string): { style: AvatarStyle; base: string } {
  const i = (seed || '').indexOf(':');
  if (i > 0) {
    const prefix = seed.slice(0, i);
    if ((AVATAR_STYLES as readonly string[]).includes(prefix)) {
      return { style: prefix as AvatarStyle, base: seed.slice(i + 1) || 'anon' };
    }
  }
  // No recognized prefix → classic style over the whole seed (back-compat).
  return { style: 'mirror', base: seed || 'anon' };
}

/** Compose a seed string from a style + base (the inverse of parseAvatar). */
export function makeAvatarSeed(style: AvatarStyle, base: string): string {
  return `${style}:${base}`;
}

interface Palette {
  gradId: string;
  clipId: string;
  c1: string;
  c2: string;
  angle: number;
  fg: string;
}

function palette(seed: string, rng: () => number): Palette {
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 35 + Math.floor(rng() * 90)) % 360;
  const uid = (hashSeed(seed) >>> 0).toString(36);
  return {
    gradId: 'idg-' + uid,
    clipId: 'idc-' + uid,
    c1: `hsl(${h1} 72% 56%)`,
    c2: `hsl(${h2} 70% 44%)`,
    angle: Math.floor(rng() * 360),
    fg: 'rgba(255,255,255,0.94)',
  };
}

// ── Style builders ───────────────────────────────────────────────────────────
// Each returns the foreground SVG elements drawn over the gradient base. Every
// builder is pure in (rng, size) so the avatar is fully deterministic.

function buildMirror(rng: () => number, size: number, fg: string): React.ReactNode {
  const cell = size / 5;
  const pad = cell * 0.12;
  const cells: boolean[] = new Array(25).fill(false);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const on = rng() > 0.5;
      cells[row * 5 + col] = on;
      cells[row * 5 + (4 - col)] = on;
    }
  }
  return cells.map((on, i) =>
    on ? (
      <rect
        key={i}
        x={(i % 5) * cell + pad}
        y={Math.floor(i / 5) * cell + pad}
        width={cell - pad * 2}
        height={cell - pad * 2}
        rx={Math.max(1, cell * 0.18)}
        fill={fg}
      />
    ) : null
  );
}

function buildGrid(rng: () => number, size: number, fg: string): React.ReactNode {
  // Chunky 3×3 rounded tiles, vertically mirrored for balance.
  const cell = size / 3;
  const pad = cell * 0.16;
  const cells: boolean[] = new Array(9).fill(false);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      const on = rng() > 0.42;
      cells[row * 3 + col] = on;
      cells[row * 3 + (2 - col)] = on;
    }
  }
  return cells.map((on, i) =>
    on ? (
      <rect
        key={i}
        x={(i % 3) * cell + pad}
        y={Math.floor(i / 3) * cell + pad}
        width={cell - pad * 2}
        height={cell - pad * 2}
        rx={Math.max(2, cell * 0.28)}
        fill={fg}
      />
    ) : null
  );
}

function buildRings(rng: () => number, size: number, fg: string): React.ReactNode {
  // Concentric ring arcs of varying thickness, offset from centre.
  const cx = size * (0.42 + rng() * 0.16);
  const cy = size * (0.42 + rng() * 0.16);
  const count = 3 + Math.floor(rng() * 2);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const r = size * (0.12 + i * 0.13);
    const sw = Math.max(2, size * (0.05 + rng() * 0.05));
    const op = 0.35 + rng() * 0.6;
    nodes.push(
      <circle
        key={i}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={fg}
        strokeWidth={sw}
        strokeOpacity={op}
        strokeDasharray={rng() > 0.5 ? `${r * 1.4} ${r * 0.9}` : undefined}
      />
    );
  }
  return nodes;
}

function buildBauhaus(rng: () => number, size: number, fg: string): React.ReactNode {
  // A few geometric shapes (disc, quarter, bar, triangle) placed deterministically.
  const nodes: React.ReactNode[] = [];
  const shapes = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < shapes; i++) {
    const op = 0.45 + rng() * 0.5;
    const pick = Math.floor(rng() * 4);
    const cx = size * (0.2 + rng() * 0.6);
    const cy = size * (0.2 + rng() * 0.6);
    const s = size * (0.22 + rng() * 0.3);
    if (pick === 0) {
      nodes.push(<circle key={i} cx={cx} cy={cy} r={s / 2} fill={fg} fillOpacity={op} />);
    } else if (pick === 1) {
      // bar
      const rot = Math.floor(rng() * 180);
      nodes.push(
        <rect
          key={i}
          x={cx - s / 2}
          y={cy - s * 0.16}
          width={s}
          height={s * 0.32}
          rx={s * 0.16}
          fill={fg}
          fillOpacity={op}
          transform={`rotate(${rot} ${cx} ${cy})`}
        />
      );
    } else if (pick === 2) {
      // triangle
      const rot = Math.floor(rng() * 360);
      const h = s * 0.9;
      nodes.push(
        <polygon
          key={i}
          points={`${cx},${cy - h / 2} ${cx - s / 2},${cy + h / 2} ${cx + s / 2},${cy + h / 2}`}
          fill={fg}
          fillOpacity={op}
          transform={`rotate(${rot} ${cx} ${cy})`}
        />
      );
    } else {
      // half-disc (quarter pie)
      const rot = Math.floor(rng() * 360);
      const r = s / 2;
      nodes.push(
        <path
          key={i}
          d={`M ${cx} ${cy} L ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z`}
          fill={fg}
          fillOpacity={op}
          transform={`rotate(${rot} ${cx} ${cy})`}
        />
      );
    }
  }
  return nodes;
}

export const Identicon: React.FC<IdenticonProps> = ({ seed, size = 40, online, ring, className, title }) => {
  const { style, base } = useMemo(() => parseAvatar(seed), [seed]);
  const pal = useMemo(() => palette(seed, mulberry32(hashSeed(base))), [seed, base]);
  const fg = pal.fg;

  const fgNodes = useMemo(() => {
    // A fresh stream seeded from the base so the foreground is stable per seed
    // but independent of the palette draws above.
    const rng = mulberry32(hashSeed(base + '|' + style));
    switch (style) {
      case 'grid': return buildGrid(rng, size, fg);
      case 'rings': return buildRings(rng, size, fg);
      case 'bauhaus': return buildBauhaus(rng, size, fg);
      case 'mirror':
      default: return buildMirror(rng, size, fg);
    }
  }, [style, base, size, fg]);

  const radius = Math.round(size * 0.28);
  const dot = Math.max(7, Math.round(size * 0.22));

  return (
    <span
      className={`identicon${ring ? ' identicon-ring' : ''}${className ? ' ' + className : ''}`}
      style={{ width: size, height: size }}
      title={title}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title || 'avatar'}>
        <defs>
          <linearGradient id={pal.gradId} gradientTransform={`rotate(${pal.angle} 0.5 0.5)`}>
            <stop offset="0%" stopColor={pal.c1} />
            <stop offset="100%" stopColor={pal.c2} />
          </linearGradient>
          <clipPath id={pal.clipId}>
            <rect width={size} height={size} rx={radius} ry={radius} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${pal.clipId})`}>
          <rect width={size} height={size} fill={`url(#${pal.gradId})`} />
          {fgNodes}
        </g>
      </svg>
      {online !== undefined && (
        <span
          className={`identicon-status ${online ? 'online' : 'offline'}`}
          style={{ width: dot, height: dot }}
          aria-hidden="true"
        />
      )}
    </span>
  );
};

// ── Avatar picker helpers ────────────────────────────────────────────────────

/** A short random base for a freshly-rolled avatar. */
export function randomAvatarBase(): string {
  return Math.floor(Math.random() * 0xffffffff).toString(36) + Date.now().toString(36).slice(-3);
}

/** A random complete avatar seed (style + base). */
export function randomAvatarSeed(style?: AvatarStyle): string {
  const s = style || AVATAR_STYLES[Math.floor(Math.random() * AVATAR_STYLES.length)];
  return makeAvatarSeed(s, randomAvatarBase());
}

/**
 * A pool of candidate seeds for the picker: a spread across every style with a
 * couple of random bases each, shuffled. `current` (if given) is kept at the
 * front so the user's existing avatar stays selected.
 */
export function avatarCandidates(perStyle = 3, current?: string): string[] {
  const pool: string[] = [];
  for (const style of AVATAR_STYLES) {
    for (let i = 0; i < perStyle; i++) pool.push(makeAvatarSeed(style, randomAvatarBase()));
  }
  // Fisher–Yates shuffle.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (current) return [current, ...pool.filter((s) => s !== current)];
  return pool;
}

export default Identicon;
