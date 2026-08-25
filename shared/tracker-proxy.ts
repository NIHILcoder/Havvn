/**
 * libcurl proxy environment for the transmission sidecar.
 *
 * Transmission 4 dropped in-app proxy knobs. Peer sockets (TCP/µTP/DHT) never
 * go through this — only HTTP(S) tracker announces, via the daemon's curl.
 * Empty values when disabled so a parent-process HTTP_PROXY cannot leak in.
 */

export interface TrackerProxySettings {
  proxyEnabled: boolean;
  proxyType: 'http' | 'https' | 'socks5';
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
}

const CLEARED: Record<string, string> = {
  http_proxy: '',
  https_proxy: '',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  all_proxy: '',
  no_proxy: '*',
  NO_PROXY: '*',
};

export function formatProxyUrl(s: TrackerProxySettings): string | null {
  const host = s.proxyHost.trim();
  if (!host) return null;
  const port = Number.isFinite(s.proxyPort) && s.proxyPort > 0 && s.proxyPort <= 65535
    ? Math.round(s.proxyPort)
    : (s.proxyType === 'socks5' ? 1080 : 8080);
  const scheme = s.proxyType === 'socks5' ? 'socks5h' : s.proxyType;
  const auth = (s.proxyUsername || s.proxyPassword)
    ? `${encodeURIComponent(s.proxyUsername)}:${encodeURIComponent(s.proxyPassword)}@`
    : '';
  return `${scheme}://${auth}${host}:${port}`;
}

export function daemonProxyEnv(s: TrackerProxySettings): Record<string, string> {
  if (!s.proxyEnabled) return { ...CLEARED };
  const url = formatProxyUrl(s);
  if (!url) return { ...CLEARED };
  return {
    http_proxy: url,
    https_proxy: url,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    all_proxy: url,
  };
}
