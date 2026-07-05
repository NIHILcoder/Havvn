/**
 * Magnet infoHash normalization — the load-bearing correctness code behind
 * duplicate detection. WebTorrent normalizes every infoHash to 40-char lowercase
 * hex internally, so we MUST too: a magnet's `xt=urn:btih:` value can be either
 * 40-char hex OR 32-char RFC-4648 base32, and the same content in the two encodings
 * must resolve to the same hash or the same torrent gets added twice.
 *
 * Pure + dependency-free (no Buffer) so it runs anywhere and is unit-tested.
 */

/** Decode an RFC 4648 base32 infohash (32 chars) to 40-char lowercase hex, or null. */
export function base32ToHex(b32: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of b32.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length !== 20) return null;
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Extract a normalized (40-char lowercase hex) infoHash from a magnet URI, or null. */
export function extractInfoHashFromMagnet(magnetUri: string): string | null {
  try {
    const match = magnetUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    if (!match) return null;
    const hash = match[1];
    if (/^[a-fA-F0-9]{40}$/.test(hash)) return hash.toLowerCase();
    if (/^[a-zA-Z2-7]{32}$/.test(hash)) return base32ToHex(hash);
    return null;
  } catch {
    return null;
  }
}
