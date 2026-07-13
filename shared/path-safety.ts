/**
 * Path-safety helpers shared across processes.
 *
 * These exist because several code paths take an UNTRUSTED, peer-supplied name
 * (a room member's file name, a torrent's internal name) and feed it to
 * path.join(baseDir, name) before writing bytes there. path.join normalizes
 * '..', so a name like `..\\..\\..\\Startup\\evil.exe` escapes baseDir and gives
 * an arbitrary-file-write. Reducing the name to a bare basename removes any
 * directory component and closes that.
 */
import path from 'path';

/**
 * Reduce an untrusted filename to a bare, traversal-free basename.
 * path.win32.basename treats BOTH '/' and '\\' as separators on every OS, so a
 * mixed-separator payload can't sneak a directory component through. Returns ''
 * for non-strings and for empty / '.' / '..' (callers should treat '' as "no
 * usable name" and reject the entry rather than writing to the bare base dir).
 */
export function safeBaseName(name: unknown): string {
  if (typeof name !== 'string' || !name) return '';
  const base = path.win32.basename(name);
  if (!base || base === '.' || base === '..') return '';
  return base;
}

/** Windows reserved device names — illegal as a file/dir name on any drive. */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Reduce an (untrusted, peer-supplied) folder NAME to ONE safe path segment for
 * a real subdirectory — so a room folder like "Movies" can nest files under
 * <roomDir>/Movies/. Strips directory components (safeBaseName), replaces the
 * characters Windows forbids in names (< > : " / \ | ? * and control chars) with
 * a space, trims trailing dots/spaces, rejects reserved device names, and caps
 * length. Returns '' when nothing usable remains — the caller then falls back to
 * the base directory (no subfolder). Control chars are filtered by code point to
 * avoid embedding raw control bytes in this source.
 */
export function safeDirSegment(name: unknown): string {
  const base = safeBaseName(name);
  if (!base) return '';
  let s = '';
  for (let i = 0; i < base.length; i++) {
    if (base.charCodeAt(i) < 0x20) continue; // drop control chars
    s += '<>:"/\\|?*'.includes(base[i]) ? ' ' : base[i];
  }
  s = s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/g, '').trim();
  if (!s || s === '.' || s === '..' || WIN_RESERVED.test(s)) return '';
  return s.slice(0, 80).replace(/[.\s]+$/g, '');
}
