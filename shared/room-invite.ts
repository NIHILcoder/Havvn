/**
 * Invite-string helpers — no crypto. Shared by the Node engine and the
 * browser guest so a pasted/hashed invite always splits the same way.
 *
 * The speakable code is the KDF input. An optional "~<ownerId>" pin is NOT
 * part of the key: it only tells a joiner which identity to trust as owner.
 */

export const E2E_SUFFIX = '-e2e';
export const INVITE_SEP = '~';
const OWNER_ID_RE = /^[0-9a-f]{32}$/;

/** Normalize so trivial copy/paste differences still resolve to the same room. */
export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-');
}

/** True when the invite code marks its room end-to-end encrypted. */
export function codeIsE2E(code: string): boolean {
  return normalizeCode(code).endsWith(E2E_SUFFIX);
}

/** Build the shareable invite for a room, pinning the owner when known. */
export function buildInvite(code: string, ownerId?: string): string {
  const c = normalizeCode(code);
  return ownerId && OWNER_ID_RE.test(ownerId) ? c + INVITE_SEP + ownerId : c;
}

/** Split a pasted invite into its KDF code and (optional, validated) owner pin. */
export function parseInvite(raw: string): { code: string; ownerPin: string } {
  const s = (raw || '').trim();
  const i = s.indexOf(INVITE_SEP);
  if (i < 0) return { code: normalizeCode(s), ownerPin: '' };
  const pin = s.slice(i + 1).trim().toLowerCase();
  return { code: normalizeCode(s.slice(0, i)), ownerPin: OWNER_ID_RE.test(pin) ? pin : '' };
}
