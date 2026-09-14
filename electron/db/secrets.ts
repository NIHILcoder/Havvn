/**
 * Transparent at-rest encryption for sensitive string fields (proxy password,
 * search-provider API keys) using Electron's safeStorage — backed by the OS
 * keychain (macOS), DPAPI (Windows) or libsecret (Linux).
 *
 * Encrypted values are tagged with a prefix so we can tell them apart from
 * legacy plaintext and migrate on read. If encryption isn't available on the
 * platform, values are left as-is (we never silently pretend they're secure).
 */

import { safeStorage } from 'electron';

const PREFIX = 'enc:v1:';

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret for storage.
 * SECURITY: Throws if encryption is unavailable - we never store secrets in plaintext.
 */
export function encryptSecret(plain: string | undefined | null): string {
  if (!plain) return '';
  if (typeof plain !== 'string') return '';
  if (plain.startsWith(PREFIX)) return plain; // already encrypted

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
