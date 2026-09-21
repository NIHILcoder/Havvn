import { normalizeCode } from './room-invite';

// Parameters are part of the room protocol, including tracker discovery.
export const ROOM_KDF_SALT = 'torrenthunt-room-v1';
export const ROOM_KDF_LEGACY_ITERATIONS = 150_000;

/** Historical generated invites have four words and four digits. */
export function roomKdfIterations(code: string): number {
  return /^(?:[a-z]+-){4}\d{4}(?:-e2e)?$/.test(normalizeCode(code))
    ? ROOM_KDF_LEGACY_ITERATIONS
    : 600_000;
}
