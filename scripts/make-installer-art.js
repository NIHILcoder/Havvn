/**
 * Generates the NSIS installer artwork (BMP, no dependencies):
 *   build/installerSidebar.bmp    164x314 — welcome/finish page panel (blaze mark on graphite)
 *   build/uninstallerSidebar.bmp  164x314 — same, muted gray mark
 *   build/installerHeader.bmp     150x57  — assisted-installer header (mark on light,
 *                                           because the NSIS header chrome is light)
 *
 * The mark is the W-wings brand (assets/logo/mark-flat.svg, viewBox 512x295.8):
 * two pure polygons — near-black contour + the orange body — rasterized with
 * supersampled coverage anti-aliasing. A small VV zigzag underline echoes the
 * cover art (assets/havvn-cover.png). The angular wordmark is rasterized from
 * the shared SVG, so setup and the application use the same lettering.
 *
 * Run: node scripts/make-installer-art.js
 */
const fs = require('fs');
const path = require('path');

// ── tiny raster helpers ─────────────────────────────────────────────────────
function makeCanvas(w, h, bg) {
  const px = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2];
  }
  return { w, h, px };
}

function blend(c, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 3;
  c.px[i] = c.px[i] * (1 - a) + rgb[0] * a;
  c.px[i + 1] = c.px[i + 1] * (1 - a) + rgb[1] * a;
  c.px[i + 2] = c.px[i + 2] * (1 - a) + rgb[2] * a;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Stroke a polyline with round caps/joins, 1px anti-aliased edge. */
function strokePolyline(c, pts, width, rgb) {
  const r = width / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const x0 = Math.floor(minX - r - 2), x1 = Math.ceil(maxX + r + 2);
  const y0 = Math.floor(minY - r - 2), y1 = Math.ceil(maxY + r + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let d = Infinity;
      for (let s = 0; s < pts.length - 1; s++) {
        d = Math.min(d, distToSegment(x + 0.5, y + 0.5, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
      }
      const a = Math.max(0, Math.min(1, r - d + 0.5)); // 1px soft edge
      blend(c, x, y, rgb, a);
    }
  }
}

function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fill a polygon with 5x5 supersampled coverage per pixel. */
function fillPolygon(c, pts, rgb) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const x0 = Math.floor(minX) - 1, x1 = Math.ceil(maxX) + 1;
  const y0 = Math.floor(minY) - 1, y1 = Math.ceil(maxY) + 1;
  const S = 5, inv = 1 / (S * S);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let cov = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          if (pointInPolygon(pts, x + (sx + 0.5) / S, y + (sy + 0.5) / S)) cov++;
        }
      }
      if (cov) blend(c, x, y, rgb, cov * inv);
    }
  }
}

// ── the W-wings mark (assets/logo/mark-flat.svg, viewBox 512x295.8) ─────────
const WING_OUTLINE = [
  [6.2, 6.3], [217, 147.9], [223.9, 161.8], [256, 127.7], [288.1, 161.8],
  [295, 147.9], [505.8, 6.3], [366.7, 222.8], [369.2, 232.2], [330.5, 289.6],
  [256, 204.6], [181.5, 289.6], [142.8, 232.2], [145.3, 222.8],
];
const WING_BODY = [
  [478.1, 34.8], [358.2, 221.2], [360.4, 230.9], [329.7, 276.6], [256, 192.5],
  [182.3, 276.6], [151.6, 230.9], [154.1, 221.8], [153.8, 221.2], [33.9, 34.8],
  [211, 153.4], [221.7, 175.9], [256, 139.3], [290.3, 175.9], [301, 153.4],
];

/** W-wings centered at (cx, cy), `width` px wide: contour, then body on top. */
function drawWings(c, cx, cy, width, bodyRgb, outlineRgb) {
  const s = width / 512;
  const map = (pts) => pts.map(([x, y]) => [cx + (x - 256) * s, cy + (y - 147.9) * s]);
  fillPolygon(c, map(WING_OUTLINE), outlineRgb);
  fillPolygon(c, map(WING_BODY), bodyRgb);
}

/** Small VV zigzag underline (the cover-art flourish). */
function drawVV(c, cx, cy, half, amp, width, rgb) {
  strokePolyline(c, [
    [cx - half, cy + amp], [cx - half / 2, cy - amp], [cx, cy + amp],
    [cx + half / 2, cy - amp], [cx + half, cy + amp],
  ], width, rgb);
}

// ── BMP writer (24-bit, BITMAPINFOHEADER, bottom-up) ────────────────────────
function writeBmp(file, c) {
  const rowSize = Math.ceil((c.w * 3) / 4) * 4;
  const dataSize = rowSize * c.h;
  const buf = Buffer.alloc(14 + 40 + dataSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(14 + 40, 10);         // pixel data offset
  buf.writeUInt32LE(40, 14);              // BITMAPINFOHEADER
  buf.writeInt32LE(c.w, 18);
  buf.writeInt32LE(c.h, 22);
  buf.writeUInt16LE(1, 26);               // planes
  buf.writeUInt16LE(24, 28);              // bpp
  buf.writeUInt32LE(0, 30);               // BI_RGB
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38);             // 72 DPI
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < c.h; y++) {
    const srcY = c.h - 1 - y;              // bottom-up
    let off = 14 + 40 + y * rowSize;
    for (let x = 0; x < c.w; x++) {
      const i = (srcY * c.w + x) * 3;
      buf[off++] = Math.round(c.px[i + 2]); // B
      buf[off++] = Math.round(c.px[i + 1]); // G
      buf[off++] = Math.round(c.px[i]);     // R
    }
  }
  fs.writeFileSync(file, buf);
  console.log(`${path.basename(file)}  ${c.w}x${c.h}  ${buf.length} bytes`);
}

// ── palette (the mark's own colors + dark Ember chrome) ─────────────────────
const GRAPHITE = [0x14, 0x15, 0x19];  // --color-bg-primary
const BLAZE = [0xe2, 0x51, 0x17];     // logo body orange (mark-flat.svg)
const OUTLINE = [0x16, 0x13, 0x11];   // logo contour
const MUTED = [0x98, 0x95, 0x8d];     // --color-text-tertiary
const LIGHT = [0xf6, 0xf4, 0xf0];     // light-theme bg (header chrome is light)
const WHITE = [0xec, 0xeb, 0xe6];

const wordmark = fs.readFileSync(path.join(__dirname, '..', 'assets/logo/wordmark.svg'), 'utf8');
const wordPaths = [...wordmark.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(m => m[1]);
/** This brand asset contains only M/L/Z polygons; reject curves instead of approximating them. */
function drawWordmark(c, cx, y, width, main = WHITE, accent = BLAZE) {
  const scale = width / 440;
  wordPaths.forEach((d, index) => {
    if (/[^MLZ\d.\s,-]/i.test(d)) throw new Error('Wordmark requires polygon paths');
    for (const contour of d.split(/Z/i).filter(s => s.trim())) {
      const coords = contour.match(/-?\d+(?:\.\d+)?/g).map(Number);
      const points = [];
      for (let i = 0; i < coords.length; i += 2) points.push([cx + (coords[i] - 220) * scale, y + coords[i + 1] * scale]);
      fillPolygon(c, points, index === 0 ? main : accent);
    }
  });
}
function brandGround() {
  const c = makeCanvas(164, 314, GRAPHITE);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const glow = Math.max(0, 1 - Math.hypot(x - 20, (y - 15) * .8) / 210);
    blend(c, x, y, BLAZE, glow * glow * .14);
  }
  // Fine angular flourish at the foot, matching the VV geometry.
  strokePolyline(c, [[-18, 304], [64, 233], [182, 312]], .8, [0x49, 0x2c, 0x24]);
  return c;
}

const out = path.join(__dirname, '..', 'build');

// Welcome/finish artwork — graphite, ember glow and the full brand lockup.
{
  const c = brandGround();
  drawWings(c, 82, 85, 114, BLAZE, OUTLINE);
  drawWordmark(c, 82, 132, 126);
  drawVV(c, 82, 204, 18, 4, 1.6, BLAZE);
  for (let y = 306; y < 309; y++) for (let x = 30; x < 134; x++) blend(c, x, y, BLAZE, 0.9);
  writeBmp(path.join(out, 'installerSidebar.bmp'), c);
}

// Uninstaller sidebar — same geometry, muted mark (leaving, not arriving).
{
  const c = brandGround();
  drawWings(c, 82, 85, 114, MUTED, OUTLINE);
  drawWordmark(c, 82, 132, 126, WHITE, MUTED);
  writeBmp(path.join(out, 'uninstallerSidebar.bmp'), c);
}

// Header 150x57 — light chrome background, compact mark on the right
// (the near-black contour carries the shape on light).
{
  const c = makeCanvas(150, 57, LIGHT);
  drawWings(c, 32, 28, 44, BLAZE, OUTLINE);
  drawWordmark(c, 101, 21, 80, OUTLINE, BLAZE);
  writeBmp(path.join(out, 'installerHeader.bmp'), c);
}
