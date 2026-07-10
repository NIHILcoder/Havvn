/**
 * Generates the NSIS installer artwork (BMP, no dependencies):
 *   build/installerSidebar.bmp    164x314 — welcome/finish page panel (ember mark on graphite)
 *   build/uninstallerSidebar.bmp  164x314 — same, muted gray mark
 *   build/installerHeader.bmp     150x57  — assisted-installer header (ember mark on light,
 *                                           because the NSIS header chrome is light)
 *
 * The mark is the brand Double-V (renderer/components/Logo.tsx):
 *   path M4 9 L10.5 21 L16 12 L21.5 21 L28 9  +  node circle (16, 9.4) r2.3
 * rasterized with distance-based anti-aliasing.
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

function fillCircle(c, cx, cy, radius, rgb) {
  const x0 = Math.floor(cx - radius - 2), x1 = Math.ceil(cx + radius + 2);
  const y0 = Math.floor(cy - radius - 2), y1 = Math.ceil(cy + radius + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = Math.max(0, Math.min(1, radius - d + 0.5));
      blend(c, x, y, rgb, a);
    }
  }
}

/** The Double-V at a given scale, centered at (cx, cy). Design box: 24x12 units. */
function drawMark(c, cx, cy, scale, stroke, node) {
  const P = [[4, 9], [10.5, 21], [16, 12], [21.5, 21], [28, 9]]
    .map(([x, y]) => [cx + (x - 16) * scale, cy + (y - 15) * scale]);
  strokePolyline(c, P, 2.3 * scale, stroke);
  fillCircle(c, cx + (16 - 16) * scale, cy + (9.4 - 15) * scale, 2.3 * scale, node);
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

// ── palette (renderer/styles/variables.css, dark Ember) ─────────────────────
const GRAPHITE = [0x14, 0x15, 0x19];  // --color-bg-primary
const GRAPHITE2 = [0x17, 0x18, 0x1d]; // --color-bg-secondary
const EMBER = [0xf2, 0x91, 0x3f];     // --color-accent-primary
const EMBER2 = [0xe0, 0x67, 0x3a];    // --color-accent-primary-hover
const MUTED = [0x98, 0x95, 0x8d];     // --color-text-tertiary
const LIGHT = [0xf6, 0xf4, 0xf0];     // light-theme bg (header chrome is light)

const out = path.join(__dirname, '..', 'build');

// Sidebar 164x314 — graphite with a soft vertical lift and the ember mark.
{
  const c = makeCanvas(164, 314, GRAPHITE);
  for (let y = 0; y < c.h; y++) {
    const t = 1 - y / c.h; // slightly lighter at the top
    for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 3;
      for (let k = 0; k < 3; k++) c.px[i + k] = GRAPHITE[k] + (GRAPHITE2[k] - GRAPHITE[k]) * t;
    }
  }
  drawMark(c, 82, 120, 3.4, EMBER, EMBER2);
  // ember baseline accent at the bottom
  for (let y = 306; y < 309; y++) for (let x = 30; x < 134; x++) blend(c, x, y, EMBER, 0.9);
  writeBmp(path.join(out, 'installerSidebar.bmp'), c);
}

// Uninstaller sidebar — same geometry, muted mark (leaving, not arriving).
{
  const c = makeCanvas(164, 314, GRAPHITE);
  drawMark(c, 82, 120, 3.4, MUTED, MUTED);
  writeBmp(path.join(out, 'uninstallerSidebar.bmp'), c);
}

// Header 150x57 — light chrome background, compact ember mark on the right.
{
  const c = makeCanvas(150, 57, LIGHT);
  drawMark(c, 116, 28, 1.5, EMBER, EMBER2);
  writeBmp(path.join(out, 'installerHeader.bmp'), c);
}
