export const ENGINE_FEATURES = ['boundedEpisodePrefetch', 'autoMoveCompleted', 'dnsOverHttps', 'vpnInterfaceBinding'] as const;
export type EngineFeature = typeof ENGINE_FEATURES[number];
export type DownloadEngine = 'native' | 'webtorrent';
export type EngineFeatureReason = 'available' | 'file-selection-only' | 'classic-only' | 'native-only';
export interface EngineCapabilities {
  schema: 1;
  engine: DownloadEngine;
  features: Record<EngineFeature, { supported: boolean; reason: EngineFeatureReason }>;
}
/** Implementation support, not engine health, an active setting or a measured network path. */
export function engineCapabilities(engine: DownloadEngine): EngineCapabilities {
  const classic = engine === 'webtorrent';
  return { schema: 1, engine, features: {
    boundedEpisodePrefetch: { supported: classic, reason: classic ? 'available' : 'file-selection-only' },
    autoMoveCompleted: { supported: classic, reason: classic ? 'available' : 'classic-only' },
    dnsOverHttps: { supported: classic, reason: classic ? 'available' : 'classic-only' },
    vpnInterfaceBinding: { supported: !classic, reason: classic ? 'native-only' : 'available' },
  } };
}
/** Unknown schemas, missing flags and malformed replies never enable a feature. */
export function readEngineCapabilities(raw: unknown): EngineCapabilities | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as EngineCapabilities;
  if (value.schema !== 1 || !['native', 'webtorrent'].includes(value.engine) || !value.features) return null;
  const features = {} as EngineCapabilities['features'];
  for (const feature of ENGINE_FEATURES) {
    const flag = value.features[feature];
    if (!flag || typeof flag.supported !== 'boolean' || !['available', 'file-selection-only', 'classic-only', 'native-only'].includes(flag.reason)) return null;
    features[feature] = { supported: flag.supported, reason: flag.reason };
  }
  return { schema: 1, engine: value.engine, features };
}
