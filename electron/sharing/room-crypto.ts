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

// Curated, easy-to-say wordlists. Kept short and unambiguous (no homophones,
// no easily-confused words). Code = adj-adj-noun-noun-NNNN → ~45 bits, enough
// for friend sharing where each brute-force guess is network-bound (tracker
// announce + WebRTC handshake + failed GCM decrypt).
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

/** Generate a fresh, speakable invite code, e.g. "swift-amber-otter-comet-4821". */
export function generateRoomCode(): string {
  const n = crypto.randomInt(1000, 10000); // 4 digits, no leading zero
  return [pick(ADJECTIVES), pick(ADJECTIVES), pick(NOUNS), pick(NOUNS), n].join('-');
}

/** Normalize so trivial copy/paste differences still resolve to the same room. */
export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-');
}

const SALT = Buffer.from('torrenthunt-room-v1');

/** 256-bit AES-GCM key derived from the code. */
export function deriveKey(code: string): Buffer {
  return crypto.pbkdf2Sync(normalizeCode(code), SALT, 150000, 32, 'sha256');
}

/** 20-byte tracker rendezvous topic (hex) derived from the code. */
export function topicHash(code: string): string {
  return crypto.createHash('sha1').update('th-room:v1:' + normalizeCode(code)).digest('hex');
}

/** A random 20-byte peer id (hex) for a tracker session. */
export function randomPeerId(): string {
  return crypto.randomBytes(20).toString('hex');
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
