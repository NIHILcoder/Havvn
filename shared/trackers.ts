/**
 * Parsing for the user-supplied WebRTC rendezvous tracker list
 * (settings.customTrackers). Lives in shared/ because BOTH sides need the exact
 * same verdict: the main process resolves the list it actually announces to, and
 * the settings UI tells the user how many entries it accepted. A second copy of
 * this regex in the renderer is how the two quietly drift apart.
 *
 * The default list and the HAVVN_ROOM_TRACKERS override stay in
 * electron/sharing/ice-servers.ts — those are connectivity concerns, not parsing.
 */

// Announcing is per-tracker work on every room and every share, so an
// accidentally pasted wall of URLs would cost real connect latency for no gain.
export const MAX_CUSTOM_TRACKERS = 10;

/**
 * Split a raw settings string (comma / newline / space separated) into a clean
 * tracker list.
 *
 * Deliberately strict: only ws:// and wss:// survive, because that is what the
 * WebRTC tracker client speaks. An http:// announce URL would never connect, and
 * silently keeping it would present as a broken room rather than a bad setting.
 * Duplicates are dropped and the result is capped at MAX_CUSTOM_TRACKERS.
 */
export function parseTrackers(raw?: string): string[] {
  const out: string[] = [];
  for (const part of String(raw || '').split(/[\s,]+/)) {
    const u = part.trim();
    if (!u || !/^wss?:\/\/\S+$/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length >= MAX_CUSTOM_TRACKERS) break;
  }
  return out;
}

/**
 * Does this raw string contain something the user clearly meant as a tracker,
 * yet nothing usable came out of it? Drives the "none of these are valid" hint
 * in settings — without it, a typo looks identical to leaving the field blank.
 */
export function hasOnlyInvalidTrackers(raw?: string): boolean {
  const s = String(raw || '').trim();
  return s.length > 0 && parseTrackers(s).length === 0;
}
