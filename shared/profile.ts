/**
 * Room profile customization — validation shared by the renderer (pre-save),
 * the IPC trust boundary (handlers) and the engine's gossip clamps, so every
 * layer agrees on what a legal color/status/avatar looks like.
 *
 * The avatar rides P2P gossip, so the cap is deliberately tight: ~64K chars of
 * data URL ≈ 47KB of image bytes — a 96-128px webp/png fits comfortably, and a
 * frame that size stays far under the ~256KiB SCTP message ceiling.
 */

export const PROFILE_STATUS_MAX = 140;
export const PROFILE_NAME_MAX = 64;

/** Stable public alias. Never derive it from an OS account or device hostname. */
export function defaultRoomName(memberId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < memberId.length; index++) hash = Math.imul(hash ^ memberId.charCodeAt(index), 16777619);
  return 'Havvn-' + (hash >>> 0).toString(16).padStart(8, '0').slice(-6).toUpperCase();
}

/** A local "You" label must never be the fallback sent to another member. */
export function publicRoomName(name: unknown, memberId: string): string {
  const clean = sanitizeProfileStatus(name).slice(0, PROFILE_NAME_MAX);
  return clean || defaultRoomName(memberId);
}
export const PROFILE_IMG_MAX_CHARS = 64_000;
/** Max decoded avatar dimension. Our own pipeline emits ≤128px; the cap only
 *  has to stop a hand-crafted pixel bomb (a ~40KB flat PNG can declare
 *  30000×30000 and decode to gigabytes on every peer). */
export const PROFILE_IMG_MAX_DIM = 1024;
export const PROFILE_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const PROFILE_IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function b64bytes(b64: string): Uint8Array | null {
  try {
    const B = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer;
    if (B) return new Uint8Array(B.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/**
 * Parse the DECLARED pixel dimensions out of a png/jpeg/webp byte stream
 * without decoding the bitmap. Null when the container is unrecognized or
 * malformed — callers treat that as invalid.
 */
export function imageDims(b: Uint8Array): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    // PNG: IHDR is always the first chunk; width/height big-endian at 16/20.
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    return w > 0 && h > 0 ? { w, h } : null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8 ') {
      // Lossy: 3-byte frame tag, then the 9D 01 2A start code, then 14-bit dims.
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      return w > 0 && h > 0 ? { w, h } : null;
    }
    if (tag === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      const w = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const h = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6));
      return { w, h };
    }
    if (tag === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { w, h };
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segment chain to the first SOF marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return w > 0 && h > 0 ? { w, h } : null;
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** '' clears the field; otherwise must be a #rrggbb hex. Null = invalid. */
export function sanitizeProfileColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v === '') return '';
  return PROFILE_COLOR_RE.test(v) ? v : null;
}

/** Trim, strip control chars + bidi overrides (render-order spoofing), cap length. Never fails — worst case ''. */
export function sanitizeProfileStatus(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, PROFILE_STATUS_MAX);
}

/**
 * '' clears; otherwise must be a capped data:image/(png|jpeg|webp) URL whose
 * container header declares sane dimensions (≤ PROFILE_IMG_MAX_DIM) — without
 * this, a ~40KB flat PNG declaring 30000×30000 would make every peer's
 * renderer decode a multi-gigabyte bitmap. Null = invalid.
 */
export function sanitizeProfileImg(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v === '') return '';
  if (v.length > PROFILE_IMG_MAX_CHARS || !PROFILE_IMG_RE.test(v)) return null;
  const bytes = b64bytes(v.slice(v.indexOf(',') + 1));
  if (!bytes) return null;
  const dims = imageDims(bytes);
  if (!dims || dims.w > PROFILE_IMG_MAX_DIM || dims.h > PROFILE_IMG_MAX_DIM) return null;
  return v;
}
