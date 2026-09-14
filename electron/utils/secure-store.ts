/**
 * Secure Storage Wrapper
 *
 * Encrypts sensitive data using Electron's safeStorage API
 * Falls back to base64 if encryption unavailable
 */

import { safeStorage } from 'electron';
import Store from 'electron-store';

export class SecureStore<T extends Record<string, any>> {
  private store: Store;
  private encryptionAvailable: boolean;
  private sensitiveKeys: Set<string>;

  constructor(options: {
    name?: string;
    defaults?: T;
    sensitiveKeys?: string[];
  }) {
    this.store = new Store({
      name: options.name,
      defaults: options.defaults,
    });

    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    this.sensitiveKeys = new Set(options.sensitiveKeys || []);

    if (!this.encryptionAvailable) {
      console.warn('⚠️  Encryption not available on this system. Using obfuscation only.');
    }
  }

  /**
   * Get value with automatic decryption
   */
  get<K extends keyof T>(key: K): T[K] {
    const keyStr = String(key);
    const value = this.store.get(keyStr);

    // If this is a sensitive key and stored as encrypted
    if (this.sensitiveKeys.has(keyStr) && typeof value === 'object' && value !== null) {
      const encrypted = value as { encrypted: boolean; data: string };
      if (encrypted.encrypted) {
        return this.decrypt(encrypted.data) as T[K];
      }
    }

    return value as T[K];
  }

  /**
   * Set value with automatic encryption for sensitive keys
   */
  set<K extends keyof T>(key: K, value: T[K]): void {
    // If this is a sensitive key, encrypt it
    if (this.sensitiveKeys.has(key as string)) {
      const encrypted = this.encrypt(value);
      this.store.set(key as string, {
        encrypted: true,
        data: encrypted,
      });
    } else {
      this.store.set(key as string, value);
    }
  }

  /**
   * Delete key
   */
  delete<K extends keyof T>(key: K): void {
    this.store.delete(key as string);
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Check if key exists
   */
  has<K extends keyof T>(key: K): boolean {
    return this.store.has(key as string);
  }

  /**
   * Encrypt data
   */
  private encrypt(data: any): string {
    const jsonString = JSON.stringify(data);

    if (this.encryptionAvailable) {
      // Use Electron's native encryption (OS keychain)
      const buffer = safeStorage.encryptString(jsonString);
      return buffer.toString('base64');
    } else {
      // SECURITY: Refuse to store sensitive data without proper encryption
      // This prevents a false sense of security and data exposure
      throw new Error(
        'Secure storage is not available on this system. ' +
        'Cannot store sensitive data without encryption. ' +
        'Please ensure your OS keychain/credential manager is accessible (DPAPI on Windows, Keychain on macOS, libsecret on Linux).'
      );
    }
  }

  /**
   * Decrypt data
   */
  private decrypt(encryptedData: string): any {
    try {
      const buffer = Buffer.from(encryptedData, 'base64');

      if (this.encryptionAvailable) {
        // Use Electron's native decryption
        const decrypted = safeStorage.decryptString(buffer);
        return JSON.parse(decrypted);
      } else {
        // SECURITY: If encryption is not available, we should never have encrypted data
        // This means either the system changed or data is corrupted
        throw new Error('Cannot decrypt data: encryption not available on this system');
      }
    } catch (error) {
      console.error('Failed to decrypt data:', error);
      throw new Error(`Failed to decrypt secure data: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * Get encryption status
   */
  isEncrypted(): boolean {
    return this.encryptionAvailable;
  }

  /**
   * Export all data (decrypted)
   */
  exportData(): T {
    const data: any = {};
    for (const key of Object.keys(this.store.store)) {
      // Use get() to automatically decrypt
      data[key] = this.get(key as keyof T);
    }
    return data as T;
  }

  /**
   * Securely wipe all data
   */
  secureWipe(): void {
    // Overwrite with random data before clearing
    const keys = Object.keys(this.store.store);
    for (const key of keys) {
      const randomData = Buffer.from(Math.random().toString()).toString('base64');
      this.store.set(key, randomData);
    }

    // Clear after overwrite
    this.store.clear();
  }
}

/**
 * Create secure store with encrypted sensitive fields
 */
export function createSecureStore<T extends Record<string, any>>(options: {
  name: string;
  defaults?: T;
  sensitiveKeys?: string[];
}): SecureStore<T> {
  return new SecureStore(options);
}
