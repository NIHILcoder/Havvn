import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ available: true, fail: false, backend: 'gnome_libsecret' }));
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => state.available,
  getSelectedStorageBackend: () => state.backend,
  encryptString: (text: string) => { if (state.fail) throw new Error('keychain failed'); return Buffer.from('protected:' + text); },
  decryptString: (bytes: Buffer) => bytes.toString().slice('protected:'.length),
} }));
import { encryptSecret, decryptSecret, decryptSecretStrict, isEncryptionAvailable } from './secrets';
beforeEach(() => { state.available = true; state.fail = false; });
describe('encrypting arbitrary chat text', () => {
  it('round-trips text beginning with the encrypted-storage prefix without treating it as a ciphertext', () => {
    const text = 'enc:v1:a literal message';
    const saved = encryptSecret(text, false);
    expect(saved).not.toBe(text); expect(decryptSecret(saved)).toBe(text);
    expect(encryptSecret(saved)).toBe(saved); // existing secrets retain idempotent migration behavior
  });
  it('rejects unavailable encryption or encryption failures for arbitrary text', () => {
    state.available = false; expect(() => encryptSecret('enc:v1:text', false)).toThrow(/unavailable/);
    state.available = true; state.fail = true; expect(() => encryptSecret('text', false)).toThrow(/keychain failed/);
  });
});


describe('strict system-secret access', () => {
  it('does not count the Linux basic_text backend as OS protection', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    state.backend = 'basic_text'; expect(isEncryptionAvailable()).toBe(false); expect(() => encryptSecret('secret')).toThrow(/unavailable/);
    state.backend = 'gnome_libsecret'; expect(isEncryptionAvailable()).toBe(true); platform.mockRestore();
  });
  it('requires canonical protected bytes and distinguishes unavailability from an empty secret', () => {
    const stored = encryptSecret('secret'); expect(decryptSecretStrict(stored)).toBe('secret');
    for (const value of ['', 'plaintext', 'enc:v1:', 'enc:v1:not valid base64']) expect(() => decryptSecretStrict(value)).toThrow();
    state.available = false; expect(() => decryptSecretStrict(stored)).toThrow(/unavailable/);
  });
});
