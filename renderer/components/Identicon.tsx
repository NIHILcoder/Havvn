/**
 * Identicon — a deterministic, colorful avatar generated purely from a seed
 * string (a room member's id). No network, no uploads: the same seed always
 * yields the same symmetric geometric glyph on the same gradient.
 *
 * Avatars are the one place in this otherwise-monochrome UI where colour earns
 * its keep — it's identity, and vivid gradients make members instantly
 * distinguishable. The pattern is a 5×5 grid mirrored left↔right (GitHub-style)
 * so it always reads as a balanced symbol.
 */

import React, { useMemo } from 'react';

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

interface Glyph {
  cells: boolean[];   // 25 cells, row-major (5×5), already mirrored
  gradId: string;
  c1: string;
  c2: string;
  angle: number;
  fg: string;
}

function buildGlyph(seed: string): Glyph {
  const rng = mulberry32(hashSeed(seed || 'anon'));
  // Two harmonious hues for the gradient.
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 35 + Math.floor(rng() * 90)) % 360;
  const c1 = `hsl(${h1} 72% 56%)`;
  const c2 = `hsl(${h2} 70% 44%)`;
  const angle = Math.floor(rng() * 360);

  // 3 left columns × 5 rows decide the pattern; mirror cols 0,1 → 4,3.
  const grid: boolean[] = new Array(25).fill(false);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const on = rng() > 0.5;
      grid[row * 5 + col] = on;
      grid[row * 5 + (4 - col)] = on;
    }
  }
  return { cells: grid, gradId: 'idg-' + (hashSeed(seed) >>> 0).toString(36), c1, c2, angle, fg: 'rgba(255,255,255,0.94)' };
}

export const Identicon: React.FC<IdenticonProps> = ({ seed, size = 40, online, ring, className, title }) => {
  const g = useMemo(() => buildGlyph(seed), [seed]);
  const radius = Math.round(size * 0.28);
  const cell = size / 5;
  const pad = cell * 0.12;
  const dot = Math.max(7, Math.round(size * 0.22));

  return (
    <span
      className={`identicon${ring ? ' identicon-ring' : ''}${className ? ' ' + className : ''}`}
      style={{ width: size, height: size }}
      title={title}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title || 'avatar'}>
        <defs>
          <linearGradient id={g.gradId} gradientTransform={`rotate(${g.angle} 0.5 0.5)`}>
            <stop offset="0%" stopColor={g.c1} />
            <stop offset="100%" stopColor={g.c2} />
          </linearGradient>
        </defs>
        <rect width={size} height={size} rx={radius} ry={radius} fill={`url(#${g.gradId})`} />
        {g.cells.map((on, i) =>
          on ? (
            <rect
              key={i}
              x={(i % 5) * cell + pad}
              y={Math.floor(i / 5) * cell + pad}
              width={cell - pad * 2}
              height={cell - pad * 2}
              rx={Math.max(1, cell * 0.18)}
              fill={g.fg}
            />
          ) : null
        )}
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

export default Identicon;
