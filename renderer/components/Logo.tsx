/**
 * Havvn logomark — the sharp double-V "W" wings: the vv of Ha·vv·n as two
 * mirrored valleys with a center peak. Single source of truth for the brand
 * mark; vectorized from the LogoNew master art (assets/logo/mark-flat.svg —
 * regenerate both from the layered PNGs if the art ever changes).
 */

import React from 'react';

// Traced geometry (viewBox 0 0 512 295.8): outline silhouette, orange face,
// three cream glare swooshes.
const VB_W = 512;
const VB_H = 295.8;
export const MARK_OUTLINE = 'M6.2 6.3L217 147.9L223.9 161.8L256 127.7L288.1 161.8L295 147.9L505.8 6.3L366.7 222.8L369.2 232.2L330.5 289.6L256 204.6L181.5 289.6L142.8 232.2L145.3 222.8Z';
const MARK_FACE = 'M478.1 34.8L358.2 221.2L360.4 230.9L329.7 276.6L256 192.5L182.3 276.6L151.6 230.9L154.1 221.8L153.8 221.2L33.9 34.8L211 153.4L221.7 175.9L256 139.3L290.3 175.9L301 153.4Z';
const MARK_GLARES = [
  'M478.6 34.2C478.6 34.2 402.4 153.1 402.4 153.1C402.4 153.1 407.5 139.6 409.5 132.9C411.6 126.2 413.4 118.7 414.7 112.9C415.9 107.1 416.7 102.4 417 98.2C417.4 93.9 417.1 89.8 416.7 87.5C416.4 85.3 415.6 85.1 414.9 84.6C414.2 84.1 417.3 82.5 412.6 84.5C407.8 86.5 386.5 96.6 386.5 96.6C386.5 96.6 478.6 34.2 478.6 34.2Z',
  'M186.4 137.3C186.4 137.3 176.1 145.7 171.4 150.5C166.6 155.2 161 162 157.7 165.8C154.5 169.7 153.4 171.2 151.6 173.6C149.9 176.1 148.4 178.6 147.3 180.7C146.1 182.8 145.5 184.1 144.8 186.2C144 188.3 143.3 190.6 142.7 193.2C142.2 195.9 141.4 202.1 141.4 202.1C141.4 202.1 117.8 165.3 117.8 165.3C117.8 165.3 123.9 164.1 127.6 162.6C131.3 161.1 134.3 159.6 139.8 156.5C145.4 153.4 154.7 148.3 161 144.1C167.2 140 177.6 131.4 177.6 131.4C177.6 131.4 186.4 137.3 186.4 137.3Z',
  'M361.5 113.3C361.5 113.3 360.4 116.8 359.1 119.6C357.8 122.5 358.1 122.8 353.6 130.4C349.1 138.1 337.5 155.9 332.2 165.7C326.9 175.4 324.7 181.5 321.7 189.1C318.6 196.8 316 204.9 313.9 211.7C311.7 218.5 309.8 225.6 308.7 230.2C307.6 234.7 307.6 236.6 307.4 239.1C307.2 241.6 307.3 243 307.4 245.2C307.6 247.4 308.3 252.3 308.3 252.3C308.3 252.3 274.7 213.7 274.7 213.7C274.7 213.7 278.7 212.3 280.9 211.1C283 210 284.2 209.3 287.6 206.6C291.1 203.9 297.7 198.4 301.6 194.9C305.4 191.3 307.6 189.3 310.9 185.4C314.2 181.5 318.1 176.3 321.2 171.6C324.3 166.9 326.8 162.6 329.5 157.4C332.2 152.2 335.4 145.5 337.3 140.4C339.3 135.4 337.2 131.4 341.3 126.8C345.3 122.3 361.5 113.3 361.5 113.3Z',
];

interface LogoMarkProps {
  /** Rendered WIDTH in px (the mark is wide: height ≈ 0.58 × size). */
  size?: number;
  /** Single-silhouette fill in the current text color (for tinted contexts). */
  mono?: boolean;
  className?: string;
}

export const LogoMark: React.FC<LogoMarkProps> = ({ size = 22, mono = false, className }) => {
  const h = Math.round(size * (VB_H / VB_W) * 10) / 10;
  // SVG defs ids are document-global — several marks render at once (sidebar,
  // settings nav, About), so each instance mints its own.
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg
      className={`logo-mark${className ? ` ${className}` : ''}`}
      width={size}
      height={h}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {mono ? (
        <path className="logo-mark-path" d={MARK_OUTLINE} fill="currentColor" />
      ) : (
        <>
          <defs>
            <clipPath id={`lgc${uid}`}><path d={MARK_OUTLINE} /></clipPath>
            <linearGradient id={`lgg${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.5" stopColor="#fff" stopOpacity="0.5" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={MARK_OUTLINE} fill="#161311" />
          <path d={MARK_FACE} fill="#e25117" />
          {MARK_GLARES.map((d, i) => <path key={i} d={d} fill="#f4c1b0" />)}
          {/* The glint: a light band sweeping INSIDE the silhouette on hover. */}
          <g clipPath={`url(#lgc${uid})`}>
            <rect className="logo-glint" x="-180" y="-30" width="180" height={VB_H + 60} fill={`url(#lgg${uid})`} />
          </g>
        </>
      )}
    </svg>
  );
};

interface WordmarkProps {
  className?: string;
}

/** "Havvn" with the double-v picked out in the accent — pairs with LogoMark. */
export const Wordmark: React.FC<WordmarkProps> = ({ className }) => (
  <span className={className}>
    Ha<b style={{ color: 'var(--color-accent-primary)', fontWeight: 'inherit' }}>vv</b>n
  </span>
);

export default LogoMark;
