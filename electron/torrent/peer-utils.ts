/**
 * Pure helpers for decoding live WebTorrent wire data into the PeerInfo the UI
 * shows (client name, progress, speed, connection type). Extracted from
 * manager.ts so the engine file stays focused on lifecycle/state.
 */

import { PeerInfo } from '../../shared/types';

// Azureus-style peer-id prefixes → human client names.
const CLIENT_CODES: Record<string, string> = {
  QB: 'qBittorrent', UT: 'µTorrent', UM: 'µTorrent Mac', UE: 'µTorrent Embedded',
  TR: 'Transmission', DE: 'Deluge', LT: 'libtorrent', lt: 'libTorrent',
  TH: 'TorrentHunt', AZ: 'Azureus / Vuze', BT: 'BitTorrent', BC: 'BitComet',
  KT: 'KTorrent', FD: 'Free Download Manager', WW: 'WebTorrent', WD: 'WebTorrent',
  WT: 'BitTornado', TX: 'Tixati', RT: 'rTorrent', qB: 'qBittorrent',
};

// 256-entry popcount table for fast peer-progress from a BitField buffer.
const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
  return t;
})();

/** Decode a remote client name from the extended handshake or the peer id. */
export function clientFromWire(wire: any): string | undefined {
  const v = wire?.peerExtendedHandshake?.v;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return clientFromPeerId(wire?.peerId);
}

function clientFromPeerId(hex: unknown): string | undefined {
  if (typeof hex !== 'string' || !hex) return undefined;
  let ascii: string;
  try { ascii = Buffer.from(hex, 'hex').toString('latin1'); } catch { return undefined; }
  const m = ascii.match(/^-([A-Za-z]{2})(\d)(\d)(\d)(\d)-/);
  if (m) {
    const name = CLIENT_CODES[m[1]] || CLIENT_CODES[m[1].toUpperCase()] || m[1];
    return `${name} ${m[2]}.${m[3]}.${m[4]}`;
  }
  return undefined;
}

/** Peer's download progress (0..1) via popcount over its piece bitfield. */
export function peerProgress(wire: any, numPieces: number): number {
  if (!numPieces) return 0;
  const pp = wire?.peerPieces;
  if (!pp) return 0;
  const buf = pp.buffer as Uint8Array | undefined;
  if (buf && buf.length) {
    let bits = 0;
    for (let i = 0; i < buf.length; i++) bits += POPCOUNT[buf[i]];
    return Math.min(1, bits / numPieces);
  }
  // HaveAll/HaveNone bitfields expose no buffer — sample the ends.
  if (typeof pp.get === 'function') return pp.get(0) ? 1 : 0;
  return 0;
}

/** WebTorrent speedometer() → bytes/sec, defensively. */
export function safeSpeed(fn: unknown): number {
  try { return typeof fn === 'function' ? Math.max(0, Math.round((fn as () => number)())) : 0; }
  catch { return 0; }
}

/** Normalize WebTorrent's connection type to a small enum the UI understands. */
export function normalizeConnType(type: unknown): PeerInfo['connType'] {
  switch (type) {
    case 'tcpIncoming': return 'tcp-in';
    case 'tcpOutgoing': return 'tcp-out';
    case 'utpIncoming': return 'utp-in';
    case 'utpOutgoing': return 'utp-out';
    case 'webrtc': return 'webrtc';
    case 'webSeed': return 'web-seed';
    default: return 'other';
  }
}
