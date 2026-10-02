import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOM_BACKUP_MAX_BYTES = 48 * 1024 * 1024;
const AAD = Buffer.from('havvn-room-backup:v1:scrypt-65536-8-1:aes-256-gcm');
export function validateBackupPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Backup password must contain 12–1024 characters');
}
function keyFor(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function sealRoomBackup(bundle: unknown, password: unknown): Promise<string> {
  validateBackupPassword(password);
  const plain = Buffer.from(JSON.stringify(bundle));
  if (plain.length > 32 * 1024 * 1024) throw new Error('Room backup is too large');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = await keyFor(password, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ format: 'havvn-room-backup', version: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') });
  } finally { key.fill(0); plain.fill(0); }
}
export async function openRoomBackup(content: string, password: unknown): Promise<unknown> {
  validateBackupPassword(password);
  if (Buffer.byteLength(content) > ROOM_BACKUP_MAX_BYTES) throw new Error('Room backup is too large');
  const value = JSON.parse(content);
  if (!value || value.format !== 'havvn-room-backup' || value.version !== 1
    || Object.keys(value).some(k => !['format', 'version', 'salt', 'iv', 'tag', 'data'].includes(k))
    || typeof value.salt !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt)
    || typeof value.iv !== 'string' || !/^[a-f0-9]{24}$/.test(value.iv)
    || typeof value.tag !== 'string' || !/^[a-f0-9]{32}$/.test(value.tag)
    || typeof value.data !== 'string' || !value.data || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('Unsupported or damaged encrypted room backup');
  const data = Buffer.from(value.data, 'base64');
  if (data.toString('base64') !== value.data) throw new Error('Invalid backup encoding');
  if (data.length > 32 * 1024 * 1024) throw new Error('Room backup is too large');
  const key = await keyFor(password, Buffer.from(value.salt, 'hex'));
  let plain: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex')); decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    try { plain = Buffer.concat([decipher.update(data), decipher.final()]); }
    catch { throw new Error('Incorrect password or damaged room backup'); }
    return JSON.parse(plain.toString('utf8'));
  } finally { key.fill(0); plain?.fill(0); }
}
/** Write ciphertext only; incomplete saves never replace an existing backup. */
export async function writeRoomBackup(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
