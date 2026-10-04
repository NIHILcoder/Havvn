import { describe, it, expect, vi } from 'vitest';
import type { ConfigField } from '../../../shared/types';
vi.mock('../../utils/i18nContext', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { validServerConfigValue } from './ServerConfigField';

const port: ConfigField = { key: 'port', t: 'int', labelKey: 'port', min: 1, max: 65535 };
describe('server settings numeric validation', () => {
  it('accepts the boundaries, but not out-of-range ports', () => {
    for (const value of ['1', '25565', '65535']) expect(validServerConfigValue(port, value)).toBe(true);
    for (const value of ['0', '-1', '65536']) expect(validServerConfigValue(port, value)).toBe(false);
  });
  it('rejects empty, fractional, nonnumeric and unsafe numbers', () => {
    for (const value of ['', ' ', '1.5', 'NaN', 'Infinity', 'abc', '9007199254740993'])
      expect(validServerConfigValue({ ...port, max: undefined }, value)).toBe(false);
  });
  it('respects an optional zero/negative range', () => {
    expect(validServerConfigValue({ ...port, min: -1, max: 0 }, '-1')).toBe(true);
    expect(validServerConfigValue({ ...port, min: -1, max: 0 }, '0')).toBe(true);
  });
  it('does not reinterpret text and select fields as numbers', () => {
    expect(validServerConfigValue({ key: 'motd', t: 'text', labelKey: 'motd' }, 'Hello')).toBe(true);
  });
});
