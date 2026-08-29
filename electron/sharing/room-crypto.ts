/**
 * Room crypto — everything derived from the human-readable invite code.
 *
 * The code is the ONLY secret. From it we derive:
 *   • a 256-bit AES-GCM key (PBKDF2) that encrypts all gossip messages, so only
 *     someone with the code can read/forge the manifest — this is the membership
 *     proof (a wrong key fails the GCM auth tag on decrypt).
 *   • a 20-byte "topic" hash used purely as a tracker rendezvous id, so members
 *     find each other on the WSS trackers without leaking the code itself.
 *
 * Used from both the main process (code generation, persistence) and the hidden
 * room-engine window (encrypt/decrypt over WebRTC). Pure Node crypto, no deps.
 */

import crypto from 'crypto';
import { normalizeCode, codeIsE2E, buildInvite, parseInvite, E2E_SUFFIX } from '../../shared/room-invite';

export { normalizeCode, codeIsE2E, buildInvite, parseInvite };

// Curated, easy-to-say wordlists. Kept short and unambiguous (no homophones,
// no easily-confused words). Code = adj-adj-noun-noun-NNNN: 32·32·32·32·9000 ≈
// 2^33 of entropy. Modest in absolute terms, but a remote guess is network-bound
// (tracker announce + WebRTC handshake + a failed GCM decrypt per attempt), so
// online brute force is impractical for friend-scale sharing. Chat messages are
// additionally Ed25519-signed and bound to a member identity, so even a code
// holder cannot post as someone else.
const ADJECTIVES = [
  'swift', 'brave', 'calm', 'clever', 'cosmic', 'bright', 'bold', 'lucky',
  'quiet', 'mighty', 'nimble', 'royal', 'silent', 'sunny', 'velvet', 'witty',
  'amber', 'azure', 'crimson', 'golden', 'jade', 'scarlet', 'silver', 'violet',
  'autumn', 'crystal', 'frosty', 'misty', 'stormy', 'wild', 'noble', 'rapid',
];
const NOUNS = [
  'otter', 'falcon', 'tiger', 'panda', 'lynx', 'heron', 'badger', 'marten',
  'raven', 'wolf', 'fox', 'owl', 'hawk', 'bear', 'seal', 'crane',
  'comet', 'nova', 'quartz', 'cedar', 'maple', 'willow', 'harbor', 'meadow',
  'canyon', 'glacier', 'summit', 'lagoon', 'ember', 'beacon', 'anchor', 'pixel',
];

function pick<T>(arr: T[]): T {
  // Rejection-free unbiased pick for power-of-two-ish lists (len 32 here).
  const max = Math.floor(256 / arr.length) * arr.length;
  let b: number;
  do { b = crypto.randomBytes(1)[0]; } while (b >= max);
  return arr[b % arr.length];
}

/** Generate a fresh, speakable invite code, e.g. "swift-amber-otter-comet-4821"
 *  ("…-4821-e2e" for an end-to-end encrypted room). */
export function generateRoomCode(e2e = false): string {
  const n = crypto.randomInt(1000, 10000); // 4 digits, no leading zero
  const base = [pick(ADJECTIVES), pick(ADJECTIVES), pick(NOUNS), pick(NOUNS), n].join('-');
  return e2e ? base + E2E_SUFFIX : base;
}

// COMPATIBILITY-CRITICAL: the KDF salt keeps the pre-rebrand value on purpose.
// Changing it would make Havvn builds derive different keys from the same room
// code — old and new versions could never join each other's rooms.
const SALT = Buffer.from('torrenthunt-room-v1');

/** 256-bit AES-GCM key derived from the code. */
export function deriveKey(code: string): Buffer {
  return crypto.pbkdf2Sync(normalizeCode(code), SALT, 150000, 32, 'sha256');
}

/**
 * Internal domain separator (20-byte hex) bound into every Ed25519 signature
 * (chat / E2E config) so a signature can't be replayed into another room. It is
 * NEVER transmitted or announced — only mixed into signed byte strings — so a
 * fast hash of the code is fine here (an attacker never sees it). Kept as the
 * historical value so persisted signatures still verify across the topicHash
 * split below; do not change it.
 */
export function topicHash(code: string): string {
  return crypto.createHash('sha1').update('th-room:v1:' + normalizeCode(code)).digest('hex');
}

/**
 * Public tracker RENDEZVOUS id (20-byte hex) — the ONE room value that goes on
 * the public WSS trackers. Derived from the SLOW PBKDF2 key, NOT a fast hash of
 * the low-entropy code: the old `sha1(code)` topic let any tracker operator
 * brute-force the ~2^33 code space offline in seconds (one sha1 per guess) and
 * recover the room key. Binding the rendezvous to the PBKDF2 key makes reversing
 * it cost 2^33 × 150k PBKDF2 rounds — the same as attacking the encrypted gossip
 * directly, so the tracker is no longer a cheaper oracle. Takes the already-
 * derived key so joining doesn't pay a second PBKDF2.
 */
export function rendezvousId(key: Buffer): string {
  return crypto.createHmac('sha1', key).update('th-room-rv:v1').digest('hex');
}

/** A random 20-byte peer id (hex) for a tracker session. */
export function randomPeerId(): string {
  return crypto.randomBytes(20).toString('hex');
}

/**
 * A member's id is the hash of its Ed25519 public key — NOT a random UUID. This
 * cryptographically binds identity: to claim a given memberId (e.g. the owner's)
 * you must present a pubkey that hashes to it, which is a 128-bit preimage — so a
 * member can no longer assert someone else's memberId with its own key to forge
 * owner commands or poison another peer's TOFU binding. Peers reject any
 * (memberId, pub) pair where memberId !== deriveMemberId(pub). 32 hex chars keeps
 * the historical id length; the security rests on the full sha256 preimage.
 */
export function deriveMemberId(pub: string): string {
  return crypto.createHash('sha256').update(pub, 'utf8').digest('hex').slice(0, 32);
}

/** Encrypt a JSON-serializable object → compact base64 token (iv|tag|cipher). */
export function encrypt(key: Buffer, obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Decrypt a token produced by encrypt(). Throws if the key/tag is wrong. */
export function decrypt<T = unknown>(key: Buffer, token: string): T {
  const buf = Buffer.from(token, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString('utf8')) as T;
}
