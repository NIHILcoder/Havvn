import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron-store', () => ({ default: class {
  data = { profiles: [], access: {} };
  get(key: keyof typeof this.data) { return structuredClone(this.data[key]); }
  set(key: keyof typeof this.data, value: never) { this.data[key] = structuredClone(value); }
  clear() { this.data = { profiles: [], access: {} }; }
} }));
import { saveSearchNetworkProfile, setProviderAccess, getProviderRoute, getSearchNetworkSettings, rememberProviderMirror, clearSearchNetworkSettings } from './provider-network-store';
beforeEach(clearSearchNetworkSettings);
describe('search connection settings', () => {
  it('clears a stale mirror preference after recovery of the primary', () => {
    setProviderAccess('source', { profileId: 'system', origins: [], mirrors: ['https://copy.test'] });
    rememberProviderMirror('source', 'https://copy.test');
    rememberProviderMirror('source', null);
    expect(getSearchNetworkSettings().access.source.lastWorkingMirror).toBeUndefined();
  });
  it('keeps a working mirror across saves and forgets a removed mirror', () => {
    const input = { profileId: 'system', origins: [], mirrors: ['https://one.test/forum', 'https://two.test/forum'] };
    setProviderAccess('source', input);
    rememberProviderMirror('source', input.mirrors[1]);
    setProviderAccess('source', input);
    expect(getProviderRoute('source')?.mirrors[0]).toBe(input.mirrors[1]);
    setProviderAccess('source', { ...input, mirrors: [input.mirrors[0]] });
    expect(getSearchNetworkSettings().access.source.lastWorkingMirror).toBeUndefined();
  });
  it('retains a working mirror after saving and forgets it when removed', () => {
    const input = { profileId: 'system', origins: [], mirrors: ['https://one.test/forum', 'https://two.test/forum'] };
    setProviderAccess('source', input);
    rememberProviderMirror('source', input.mirrors[1]);
    setProviderAccess('source', input);
    expect(getProviderRoute('source')?.mirrors[0]).toBe(input.mirrors[1]);
    setProviderAccess('source', { ...input, mirrors: [input.mirrors[0]] });
    expect(getSearchNetworkSettings().access.source.lastWorkingMirror).toBeUndefined();
  });
  it('preserves legacy connections until the user opts in', () => {
    expect(getProviderRoute('old')).toBeNull();
    setProviderAccess('old', { profileId: 'system', origins: [] });
    expect(getProviderRoute('old')?.connection).toEqual({ mode: 'system' });
    setProviderAccess('old', null);
    expect(getProviderRoute('old')).toBeNull();
  });
  it('reuses a named proxy profile across providers', () => {
    const profile = saveSearchNetworkProfile({ name: 'Local', connection: { mode: 'proxy', protocol: 'http', host: 'localhost', port: 8888 } });
    for (const id of ['one', 'two']) setProviderAccess(id, { profileId: profile.id, origins: [] });
    saveSearchNetworkProfile({ ...profile, connection: { mode: 'proxy', protocol: 'socks5', host: 'localhost', port: 1080 } });
    for (const id of ['one', 'two']) expect(getProviderRoute(id)?.connection).toMatchObject({ protocol: 'socks5', port: 1080 });
  });
  it('remembers only a configured mirror and adds its origin to the allowlist', () => {
    setProviderAccess('one', { profileId: 'direct', origins: [], mirrors: ['https://one.test/forum', 'https://two.test/forum'] });
    rememberProviderMirror('one', 'https://evil.test');
    expect(getSearchNetworkSettings().access.one.lastWorkingMirror).toBeUndefined();
    rememberProviderMirror('one', 'https://two.test/forum');
    expect(getProviderRoute('one')?.mirrors[0]).toBe('https://two.test/forum');
    expect(getProviderRoute('one')?.origins).toContain('https://two.test');
  });
  it.each(['file:///C:/secret', 'https://user:pass@site.test', 'https://site.test/?apikey=secret'])('rejects unsafe mirrors: %s', mirror => {
    expect(() => setProviderAccess('one', { profileId: 'direct', origins: [], mirrors: [mirror] })).toThrow();
  });
  it('rejects unknown profiles rather than switching to direct', () => {
    expect(() => setProviderAccess('one', { profileId: 'missing', origins: [] })).toThrow('Connection not found');
  });
});
