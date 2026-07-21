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
export function encryptFile(src: string, dst: string, secretHex: string): Promise<void> {
  const key = keyOf(secretHex);
  return new Promise<void>((resolve, reject) => {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    const fail = (e: unknown) => { try { rs.destroy(); } catch { /* ignore */ } try { ws.destroy(); } catch { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); };
    rs.on('error', fail);
    ws.on('error', fail);
    cipher.on('error', fail);
    ws.write(iv); // IV first so the reader can recover it without metadata
    cipher.on('end', () => {
      // GCM tag is only known once all data has been processed.
      try { ws.end(cipher.getAuthTag(), () => resolve()); } catch (e) { fail(e); }
    });
    rs.pipe(cipher).pipe(ws, { end: false });
  });
}

/** Decrypt `src` (ciphertext) → `dst` (plaintext). Throws if the tag fails. */
export async function decryptFile(src: string, dst: string, secretHex: string): Promise<void> {
  const key = keyOf(secretHex);
  const stat = await fs.promises.stat(src);
  if (stat.size < IV_LEN + TAG_LEN) throw new Error('Ciphertext too small to be valid');

  const fd = await fs.promises.open(src, 'r');
  try {
    const iv = Buffer.alloc(IV_LEN);
    await fd.read(iv, 0, IV_LEN, 0);
    const tag = Buffer.alloc(TAG_LEN);
    await fd.read(tag, 0, TAG_LEN, stat.size - TAG_LEN);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    // The ciphertext body sits between the IV and the trailing tag (end inclusive).
    // Decrypt into a sibling temp file and rename only after the GCM tag
    // verifies — a wrong key (routine now that the keyring makes multi-key
    // attempts normal) must never leave unauthenticated garbage at the real
    // path, nor collide with a concurrent attempt's stream.
    const tmp = dst + '.decrypt-tmp';
    const rs = fs.createReadStream(src, { start: IV_LEN, end: stat.size - TAG_LEN - 1 });
    const ws = fs.createWriteStream(tmp);
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (e: unknown) => { try { rs.destroy(); } catch { /* ignore */ } try { ws.destroy(); } catch { /* ignore */ } reject(e instanceof Error ? e : new Error(String(e))); };
        rs.on('error', fail);
        ws.on('error', fail);
        decipher.on('error', fail);
        ws.on('finish', () => resolve());
        rs.pipe(decipher).pipe(ws);
      });
      fs.renameSync(tmp, dst);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  } finally {
    await fd.close();
  }
}
