import { describe, expect, it } from 'vitest';
import { httpMirrorTargets, httpProviderBase, httpResultUrl, rebaseProviderUrl } from './provider-mirrors';

describe('HTTP source aliases', () => {
  it('keeps custom search paths and encoded parameters under a mirror prefix', () => {
    const provider = { type: 'custom' as const, url: 'https://main.test/api/search?q={query}' };
    const targets = httpMirrorTargets(provider, 'https://main.test/api/search?q=a%2Bb&key=x%26y', { mirrors: ['https://copy.test/service'] });
    expect(targets.map(t => t.url)).toEqual(['https://main.test/api/search?q=a%2Bb&key=x%26y', 'https://copy.test/service/api/search?q=a%2Bb&key=x%26y']);
    expect(httpProviderBase(provider)).toBe('https://main.test');
  });
  it.each(['jackett', 'torznab'] as const)('replaces the service base of %s, not the API suffix', type => {
    const provider = { type, url: 'https://main.test/old/' };
    const targets = httpMirrorTargets(provider, 'https://main.test/old/api?t=caps&apikey=secret', { mirrors: ['https://copy.test/new'] });
    expect(targets[1].url).toBe('https://copy.test/new/api?t=caps&apikey=secret');
  });
  it('prefers the remembered mirror and deduplicates the primary address', () => {
    const targets = httpMirrorTargets({ type: 'custom', url: 'https://main.test/search' }, 'https://main.test/search?q=x', {
      mirrors: ['https://main.test', 'https://one.test', 'https://two.test'], lastWorkingMirror: 'https://two.test',
    });
    expect(targets.map(t => t.base)).toEqual(['https://two.test', 'https://main.test', 'https://one.test']);
  });
  it('maps a download from its original mirror even after the preferred mirror changes', () => {
    const targets = httpMirrorTargets({ type: 'torznab', url: 'https://main.test/api-root' }, 'https://one.test/copy/download?id=42', {
      mirrors: ['https://one.test/copy', 'https://two.test/new'], lastWorkingMirror: 'https://two.test/new',
    }, 'https://one.test/copy');
    expect(targets.map(t => t.url)).toEqual(['https://two.test/new/download?id=42', 'https://main.test/api-root/download?id=42', 'https://one.test/copy/download?id=42']);
  });
  it('does not rewrite another origin or a neighbouring service path', () => {
    expect(rebaseProviderUrl('https://main.test/api-other/download', 'https://main.test/api', 'https://copy.test')).toBeNull();
    expect(rebaseProviderUrl('https://main.test.evil.test/api/download', 'https://main.test/api', 'https://copy.test')).toBeNull();
    expect(httpMirrorTargets({ type: 'torznab', url: 'https://main.test/api' }, 'https://cdn.test/file.torrent', { mirrors: ['https://copy.test'] })).toEqual([{ url: 'https://cdn.test/file.torrent', base: null }]);
  });
  it('rejects insecure or credential-bearing mirror configurations', () => {
    for (const mirror of ['http://copy.test', 'https://user:password@copy.test', 'https://copy.test/?apikey=secret']) {
      expect(() => httpMirrorTargets({ type: 'custom', url: 'https://main.test/search' }, 'https://main.test/search', { mirrors: [mirror] })).toThrow();
    }
  });
  it('resolves relative links and moves advertised primary links, preserving third parties', () => {
    const args = ['https://copy.test/prefix/api/search?q=x', 'https://main.test', 'https://copy.test/prefix'] as const;
    expect(httpResultUrl('download?id=1', ...args)).toBe('https://copy.test/prefix/api/download?id=1');
    expect(httpResultUrl('https://main.test/download?passkey=x', ...args)).toBe('https://copy.test/prefix/download?passkey=x');
    expect(httpResultUrl('https://cdn.test/file.torrent', ...args)).toBe('https://cdn.test/file.torrent');
    expect(httpResultUrl('file:///secret', ...args)).toBeUndefined();
    expect(httpResultUrl('https://user:secret@copy.test/file', ...args)).toBeUndefined();
  });
});
