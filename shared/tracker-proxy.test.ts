import { describe, it, expect } from 'vitest';
import { formatProxyUrl, daemonProxyEnv } from './tracker-proxy';

const base = {
  proxyEnabled: true,
  proxyType: 'socks5' as const,
  proxyHost: '127.0.0.1',
  proxyPort: 9050,
  proxyUsername: '',
  proxyPassword: '',
};

describe('formatProxyUrl', () => {
  it('uses socks5h so tracker DNS goes through the proxy', () => {
    expect(formatProxyUrl(base)).toBe('socks5h://127.0.0.1:9050');
  });
  it('encodes userinfo and maps http/https schemes', () => {
    expect(formatProxyUrl({ ...base, proxyType: 'http', proxyPort: 8080, proxyUsername: 'a b', proxyPassword: 'x@y' }))
      .toBe('http://a%20b:x%40y@127.0.0.1:8080');
    expect(formatProxyUrl({ ...base, proxyType: 'https', proxyPort: 443 })).toBe('https://127.0.0.1:443');
  });
  it('rejects an empty host', () => {
    expect(formatProxyUrl({ ...base, proxyHost: '  ' })).toBeNull();
  });
});

describe('daemonProxyEnv', () => {
  it('blanks proxy vars when off so a parent HTTP_PROXY cannot leak in', () => {
    const env = daemonProxyEnv({ ...base, proxyEnabled: false });
    expect(env.ALL_PROXY).toBe('');
    expect(env.no_proxy).toBe('*');
  });
  it('sets curl vars when on', () => {
    const env = daemonProxyEnv(base);
    expect(env.ALL_PROXY).toBe('socks5h://127.0.0.1:9050');
    expect(env.no_proxy).toBeUndefined();
  });
});
