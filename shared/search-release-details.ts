export interface ReleaseTextBlock { kind: 'paragraph' | 'heading' | 'code'; text: string }
export interface ReleasePreviewImage { id: string; label: string }
export interface ReleaseDetailSource { ref: string; providerId: string; name: string; supported: boolean }
export interface SearchReleaseDetails {
  source: ReleaseDetailSource;
  sources: ReleaseDetailSource[];
  title: string;
  url?: string;
  supported: boolean;
  blocks: ReleaseTextBlock[];
  poster?: ReleasePreviewImage;
  screenshots: ReleasePreviewImage[];
  fetchedAt?: number;
  truncated?: boolean;
  failure?: import('./provider-network').ProviderNetworkCode;
}
export interface RawReleaseDetails {
  available: boolean;
  title: string;
  blocks: ReleaseTextBlock[];
  images: Array<{ url: string; label: string; poster: boolean }>;
  truncated: boolean;
}

/** Images can be requested only after main registered them from a topic. */
export function releaseImageUrl(value: string): string | null {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.port && !['80', '443'].includes(url.port) || !host.includes('.')
      || /^[\d.]+$/.test(host) || host.includes(':')
      || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host)) return null;
    // Public image hosts use HTTPS; do not make tracker-authenticated HTTP calls.
    url.protocol = 'https:'; url.hash = ''; return url.href;
  } catch { return null; }
}
