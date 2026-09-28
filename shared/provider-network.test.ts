import { describe, expect, it } from 'vitest';
import { parseProviderConnection, providerProxyConfig, providerUrl, networkError, httpNetworkError } from './provider-network';

describe('provider network policy', () => {
  it('keeps system and direct distinct', () => {
    expect(providerProxyConfig(parseProviderConnection({ mode: 'system' }))).toEqual({ mode: 'system' });
    expect(providerProxyConfig(parseProviderConnection({ mode: 'direct' }))).toEqual({ mode: 'direct' });
  });
  it('uses one mandatory proxy, including loopback, with no DIRECT fallback', () => {
    expect(providerProxyConfig(parseProviderConnection({ mode: 'proxy', protocol: 'socks5', host: '[::1]', port: 1080 })))
      .toEqual({ mode: 'fixed_servers', proxyRules: 'socks5://[::1]:1080', proxyBypassRules: '<-loopback>' });
  });
  it.each(['host;direct://', 'host/path', 'user@host', 'host:80', '', 'a b', 'a\n'])('rejects unsafe proxy hosts: %j', host => {
    expect(() => parseProviderConnection({ mode: 'proxy', protocol: 'http', host, port: 80 })).toThrow();
  });
  it.each([0, 65536, -1, 1.2, '80', undefined])('rejects invalid ports: %j', port => {
    expect(() => parseProviderConnection({ mode: 'proxy', protocol: 'http', host: 'localhost', port })).toThrow();
  });
  it('does not silently accept unsupported proxy credentials', () => {
    expect(() => parseProviderConnection({ mode: 'proxy', protocol: 'socks5', host: 'localhost', port: 1080, username: 'u' })).toThrow('Authenticated');
  });
  it('permits configured local indexers but no redirect to other local services', () => {
    expect(providerUrl('http://localhost:9117/api', ['http://localhost:9117']).hostname).toBe('localhost');
    expect(() => providerUrl('http://localhost:9222/json', ['http://localhost:9117'])).toThrow();
  });
  it.each(['file:///C:/secret', 'https://user:password@example.com/', 'data:text/plain,secret'])('rejects non-HTTP URLs and embedded credentials', url => {
    expect(() => providerUrl(url, ['https://example.com'])).toThrow();
  });
  it('sanitizes raw network errors that may contain credentials', () => {
    const result = networkError(new Error('ERR_PROXY_CONNECTION_FAILED https://site/?apikey=secret'));
    expect(result.code).toBe('proxy');
    expect(result.message).not.toContain('secret');
  });
  it('does not claim that HTTP 403 proves an ISP block', () => {
    expect(httpNetworkError(403).code).toBe('forbidden');
    expect(httpNetworkError(401).code).toBe('auth');
    expect(httpNetworkError(429).code).toBe('rate-limit');
  });
});
