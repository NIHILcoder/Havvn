import { describe, it, expect } from 'vitest';
import { normalizeProtocolEncryption, encryptionToSettingsInt } from './protocol-encryption';

describe('normalizeProtocolEncryption', () => {
  it('keeps the three daemon modes and defaults the rest to preferred', () => {
    expect(normalizeProtocolEncryption('required')).toBe('required');
    expect(normalizeProtocolEncryption('tolerated')).toBe('tolerated');
    expect(normalizeProtocolEncryption('preferred')).toBe('preferred');
    expect(normalizeProtocolEncryption('allowed')).toBe('preferred');
    expect(normalizeProtocolEncryption(undefined)).toBe('preferred');
    expect(normalizeProtocolEncryption(1)).toBe('preferred');
  });
});

describe('encryptionToSettingsInt', () => {
  it('matches transmission settings.json (0 tolerated / 1 preferred / 2 required)', () => {
    expect(encryptionToSettingsInt('tolerated')).toBe(0);
    expect(encryptionToSettingsInt('preferred')).toBe(1);
    expect(encryptionToSettingsInt('required')).toBe(2);
  });
});
