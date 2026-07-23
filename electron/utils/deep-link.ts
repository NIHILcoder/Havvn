// Parsing for havvn://join/<invite> deep links (M17).
//
// A deep link is UNTRUSTED input (it can come from any web page or message), so
// this module only EXTRACTS a candidate invite string and bounds its length —
// the renderer runs the authoritative shape check (INVITE_SHAPE_RE) and the user
// still confirms the join. Kept pure + dependency-free so it's unit-testable and
// can't reach app/window state.

/** True for a havvn:// (or bare havvn:) URL. */
export function isHavvnUrl(arg: unknown): arg is string {
  return typeof arg === 'string' && /^havvn:/i.test(arg.trim());
}

/**
 * Extract the invite code from a havvn://join/<invite> deep link. Lenient: also
 * accepts a bare havvn://<invite>, tolerates a trailing slash / query / hash, and
 * URL-decodes the payload. Returns null for anything that isn't a havvn URL or is
 * implausibly long (bounds what crosses IPC). Does NOT validate the invite shape.
 */
export function parseHavvnInvite(raw: unknown): string | null {
  if (!isHavvnUrl(raw)) return null;
  let rest = raw.trim()
    .replace(/^havvn:\/\//i, '')   // scheme with //
    .replace(/^havvn:/i, '')        // or bare scheme
    .replace(/^join\//i, '')        // optional join/ path segment
    .replace(/^\/+/, '');           // stray leading slashes
  rest = rest.split(/[?#]/)[0].replace(/\/+$/, '').trim(); // drop query/hash/trailing slash
  try { rest = decodeURIComponent(rest); } catch { /* keep raw if not %-encoded */ }
  rest = rest.trim();
  if (!rest || rest.length > 200) return null;
  return rest;
}
