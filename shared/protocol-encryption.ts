/**
 * BitTorrent protocol encryption (MSE/PE) as the native daemon speaks it.
 * WebTorrent has no MSE — the setting is stored for both engines but only
 * transmission honours it.
 */

export type ProtocolEncryption = 'required' | 'preferred' | 'tolerated';

const MODES: ReadonlySet<string> = new Set(['required', 'preferred', 'tolerated']);

export function normalizeProtocolEncryption(value: unknown): ProtocolEncryption {
  return typeof value === 'string' && MODES.has(value) ? (value as ProtocolEncryption) : 'preferred';
}

/** settings.json integer: 0 tolerated, 1 preferred, 2 required. */
export function encryptionToSettingsInt(mode: ProtocolEncryption): 0 | 1 | 2 {
  if (mode === 'tolerated') return 0;
  if (mode === 'required') return 2;
  return 1;
}
