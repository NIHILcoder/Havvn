/**
 * Transparent at-rest encryption for sensitive string fields (proxy password,
 * search-provider API keys) using Electron's safeStorage — backed by the OS
 * keychain (macOS), DPAPI (Windows) or libsecret (Linux).
 *
 * Encrypted values are tagged with a prefix so we can tell them apart from
 * legacy plaintext and migrate on read. New writes fail closed if OS protection
 * is unavailable; callers must preserve the original record for recovery.
 */

import { safeStorage } from 'electron';

const PREFIX = 'enc:v1:';

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
      && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret for storage.
 * SECURITY: Throws if encryption is unavailable - we never store secrets in plaintext.
 */
export function encryptSecret(plain: string | undefined | null, preserveEncrypted = true): string {
  if (!plain) return '';
  if (typeof plain !== 'string') return '';
  // User-generated chat may literally start with the storage prefix. Such text
  // must always be encrypted, rather than mistaken for an existing ciphertext.
  if (preserveEncrypted && plain.startsWith(PREFIX)) return plain;

  // CRITICAL: Never store secrets without encryption
  if (!isEncryptionAvailable()) {
    throw new Error(
      'Cannot store secret: system encryption is unavailable. ' +
      'Havvn requires OS-level encryption (Windows DPAPI, macOS Keychain, or Linux libsecret) to run securely.'
    );
  }

  try {
    const buf = safeStorage.encryptString(plain);
    return PREFIX + buf.toString('base64');
  } catch (error) {
    throw new Error(`Failed to encrypt secret: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Decrypt a stored secret back to plaintext. Plaintext passes through unchanged. */
export function decryptSecret(stored: string | undefined | null): string {
  if (!stored || typeof stored !== 'string') return '';
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

/** True if the value is already an encrypted blob. */
export function isEncrypted(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Room records must distinguish a locked/corrupt ciphertext from an empty value. */
export function decryptSecretStrict(stored: string): string {
  if (!isEncrypted(stored)) throw new Error('Invalid protected secret');
  if (!isEncryptionAvailable()) throw new Error('System secret storage is unavailable');
  const encoded = stored.slice(PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || Buffer.from(encoded, 'base64').toString('base64') !== encoded) {
    throw new Error('Invalid protected secret');
  }
  try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); }
  catch { throw new Error('Cannot decrypt protected room secrets; restore system storage access and retry'); }
}
