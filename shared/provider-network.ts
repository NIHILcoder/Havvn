/** Transport contract for search only; never changes torrent engine networking. */
export type ProviderConnection =
  | { mode: 'direct' | 'system' }
  | { mode: 'proxy'; protocol: 'http' | 'socks5'; host: string; port: number };

export type ProviderNetworkCode = 'cancelled' | 'timeout' | 'dns' | 'proxy' | 'tls' | 'auth' | 'captcha' | 'invalid-response' | 'forbidden' | 'rate-limit' | 'server' | 'http' | 'redirect' | 'too-large' | 'invalid-url' | 'network';

/** Only structured, known codes cross the plugin diagnostic boundary. */
export function pluginNetworkError(stderr: string): ProviderNetworkError | null {
  const codes: ProviderNetworkCode[] = ['cancelled', 'timeout', 'dns', 'proxy', 'tls', 'auth', 'captcha', 'invalid-response', 'forbidden', 'rate-limit', 'server', 'http', 'redirect', 'too-large', 'invalid-url', 'network'];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith('HAVVN_DIAGNOSTIC ') || line.length > 256) continue;
    try {
      const value = JSON.parse(line.slice('HAVVN_DIAGNOSTIC '.length));
      if (codes.includes(value?.code)) return new ProviderNetworkError(value.code);
    } catch { /* Untrusted diagnostics are never executable or displayed as HTML. */ }
  }
  return null;
}
export class ProviderNetworkError extends Error {
  constructor(public readonly code: ProviderNetworkCode, public readonly status?: number) {
    super('Provider request failed: ' + code + (status ? ' (HTTP ' + status + ')' : ''));
    this.name = 'ProviderNetworkError';
  }
}

/** Reject proxy-rule injection and unsupported options at the IPC boundary. */
export function parseProviderConnection(value: unknown): ProviderConnection {
  if (!value || typeof value !== 'object') throw new Error('Invalid search connection');
  const v = value as Record<string, unknown>;
  if (v.mode === 'direct' || v.mode === 'system') return { mode: v.mode };
  if (v.mode !== 'proxy' || (v.protocol !== 'http' && v.protocol !== 'socks5') ||
      typeof v.host !== 'string' || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(v.host) ||
      v.host !== v.host.trim() || v.host.length > 253 || !Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535) {
    throw new Error('Invalid search proxy: specify a host and a port from 1 to 65535');
  }
  // Credentials need a separately tested adapter; do not silently discard them.
  if (v.username || v.password) throw new Error('Authenticated search proxies are not supported yet');
  return { mode: 'proxy', protocol: v.protocol, host: v.host, port: Number(v.port) };
}

export function providerProxyConfig(connection: ProviderConnection) {
  if (connection.mode !== 'proxy') return { mode: connection.mode };
  return { mode: 'fixed_servers' as const,
    proxyRules: connection.protocol + '://' + connection.host + ':' + connection.port,
    // Chromium otherwise silently bypasses loopback even in fixed proxy mode.
    proxyBypassRules: '<-loopback>',
  };
}

export function providerUrl(value: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderNetworkError('invalid-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProviderNetworkError('invalid-url');
  if (!allowedOrigins.includes(url.origin)) throw new ProviderNetworkError('redirect');
  return url;
}

export function networkError(error: unknown): ProviderNetworkError {
  if (error instanceof ProviderNetworkError) return error;
  const message = error instanceof Error ? error.message : '';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(message)) return new ProviderNetworkError('dns');
  if (/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS/.test(message)) return new ProviderNetworkError('proxy');
  if (/ERR_CERT|ERR_SSL/.test(message)) return new ProviderNetworkError('tls');
  if (/TIMED_OUT|ETIMEDOUT/.test(message)) return new ProviderNetworkError('timeout');
  return new ProviderNetworkError('network'); // raw errors may contain secret URLs
}

export function httpNetworkError(status: number): ProviderNetworkError {
  return new ProviderNetworkError(status === 401 ? 'auth' : status === 407 ? 'proxy' :
    status === 403 ? 'forbidden' : status === 429 ? 'rate-limit' : status >= 500 ? 'server' : 'http', status);
}

export interface SearchNetworkProfile { id: string; name: string; connection: ProviderConnection }
export interface ProviderAccess { profileId: string; origins: string[]; mirrors?: string[]; lastWorkingMirror?: string }
export interface SearchNetworkSettings { profiles: SearchNetworkProfile[]; access: Record<string, ProviderAccess> }
