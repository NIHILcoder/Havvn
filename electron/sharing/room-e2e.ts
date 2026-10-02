/**
 * Per-file end-to-end encryption for E2E rooms (experimental, opt-in).
 *
 * In an E2E room the WebTorrent swarm only ever carries ciphertext: a shared file
 * is encrypted with the room's content secret BEFORE seeding, and decrypted after
 * download. The infoHash is therefore the hash of the ciphertext and leaks
 * nothing about the content (beyond approximate size).
 *
 * Format (single-pass, self-describing — no out-of-band metadata needed):
 *   [ 12-byte IV ][ AES-256-GCM ciphertext … ][ 16-byte auth tag ]
 *
 * The key is the room's `secret` (32 random bytes, hex), distributed to members
 * over the encrypted gossip channel. It is intentionally SEPARATE from the gossip
 * key (which rotates on kick) so rekeys don't strand access to existing files.
 */

import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const IV_LEN = 12;
const TAG_LEN = 16;

/** A fresh 32-byte content secret (hex) — the AES-256 key for a room's files. */
export function generateRoomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

function keyOf(secretHex: string): Buffer {
  const key = Buffer.from(secretHex, 'hex');
  if (key.length !== 32) throw new Error('Invalid room secret (expected 32 bytes)');
  return key;
}

/** Encrypt `src` (plaintext) → `dst` (ciphertext). Streams; no full-file buffering. */
export async function encryptFile(src: string, dst: string, secretHex: string): Promise<void> {
  const key = keyOf(secretHex), iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let created = false;
  try {
    await fs.promises.writeFile(dst, iv, { flag: 'wx' });
    created = true;
    await pipeline(fs.createReadStream(src), cipher, fs.createWriteStream(dst, { flags: 'a' }));
    await fs.promises.appendFile(dst, cipher.getAuthTag());
  } catch (error) {
    if (created) await fs.promises.rm(dst, { force: true });
    throw error;
  }
}

/** Decrypt `src` (ciphertext) → `dst` (plaintext). Throws if the tag fails. */
export async function decryptFile(src: string, dst: string, secretHex: string,
  options: { isCurrent?: () => boolean; expectedSize?: number } = {}): Promise<void> {
  const key = keyOf(secretHex);
  const fd = await fs.promises.open(src, 'r');
  const tmp = dst + '.decrypt-' + crypto.randomUUID() + '.tmp';
  try {
    const stat = await fd.stat();
    if (stat.size < IV_LEN + TAG_LEN) throw new Error('Ciphertext too small to be valid');
    if (options.expectedSize !== undefined && stat.size !== options.expectedSize + IV_LEN + TAG_LEN) {
      throw new Error('Ciphertext size does not match the room file');
    }
    const iv = Buffer.alloc(IV_LEN), tag = Buffer.alloc(TAG_LEN);
    if ((await fd.read(iv, 0, IV_LEN, 0)).bytesRead !== IV_LEN
      || (await fd.read(tag, 0, TAG_LEN, stat.size - TAG_LEN)).bytesRead !== TAG_LEN) throw new Error('Truncated ciphertext');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const body = stat.size === IV_LEN + TAG_LEN ? Readable.from([])
      : fd.createReadStream({ start: IV_LEN, end: stat.size - TAG_LEN - 1, autoClose: false });
    // pipeline settles after streams close, including on authentication failure.
    await pipeline(body, decipher, fs.createWriteStream(tmp, { flags: 'wx' }));
    if (options.isCurrent && !options.isCurrent()) throw new Error('Room file operation canceled');
    // link publishes atomically and fails if dst already exists, on Windows too.
    // A rename could overwrite a user's file or another successful operation.
    await fs.promises.link(tmp, dst);
  } finally {
    await fd.close();
    await fs.promises.rm(tmp, { force: true });
  }
}
