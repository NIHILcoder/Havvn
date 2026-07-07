/**
 * Pure mapping between transmission RPC shapes and the app's shared types
 * (DownloadStats / TorrentFile / PeerInfo / TrackerInfo). No I/O — unit-tested.
 */

import path from 'node:path';
import type { Download, DownloadStats, DownloadStatus, TorrentFile, PeerInfo, TrackerInfo, FilePriority, SwarmGeo, SwarmGeoPoint } from '../../../shared/types';
import { TrStatus, TrTorrent, TrPeer } from './transmission-rpc';
import { numToIp } from '../../../shared/ip-range';
import { TorrentError } from '../errors';

/** torrent-get fields the 750ms stats tick requests (request only what you read). */
export const ENGINE_STAT_FIELDS = [
  'hashString', 'name', 'status', 'percentDone', 'metadataPercentComplete',
  'rateDownload', 'rateUpload', 'peersConnected', 'peersSendingToUs',
  'sizeWhenDone', 'downloadedEver', 'uploadedEver', 'eta', 'isFinished',
  'error', 'errorString',
];

/**
 * Daemon activity → app DownloadStatus. `prev` (the persisted status) breaks the
 * ties the daemon can't express: a stopped torrent is 'completed' only when all
 * wanted bytes exist, and a checking torrent keeps its seeding/downloading face.
 */
export function mapStatus(t: TrTorrent, prev: DownloadStatus): DownloadStatus {
  if (t.error !== 0) return 'error';
  switch (t.status) {
    case TrStatus.Stopped:
      return t.isFinished || t.percentDone >= 1 ? 'completed' : 'paused';
    case TrStatus.Downloading:
    case TrStatus.DownloadWait:
      return 'downloading';
    case TrStatus.Seeding:
    case TrStatus.SeedWait:
      return 'seeding';
    case TrStatus.Checking:
    case TrStatus.CheckWait:
      return prev === 'seeding' || prev === 'completed' ? prev : 'downloading';
    default:
      return prev;
  }
}

/**
 * One stats row. `t` undefined = the torrent has no live daemon entry (paused /
 * completed / error rows kept only in the DB) → persisted snapshot, zero speeds,
 * mirroring the webtorrent manager's semantics.
 */
export function mapStats(d: Download, t?: TrTorrent): DownloadStats {
  if (!t) {
    return {
      id: d.id,
      progress: d.progress,
      downloadedBytes: d.downloadedBytes,
      uploadedBytes: d.uploadedBytes,
      downSpeedBps: 0,
      upSpeedBps: 0,
      etaSeconds: null,
      peers: 0,
      seeds: 0,
      status: d.status,
    };
  }
  return {
    id: d.id,
    progress: t.percentDone,
    downloadedBytes: t.downloadedEver,
    uploadedBytes: t.uploadedEver,
    downSpeedBps: t.rateDownload,
    upSpeedBps: t.rateUpload,
    etaSeconds: t.eta > 0 ? t.eta : null,
    peers: t.peersConnected,
    // Unlike webtorrent, transmission tells us who actually feeds us. While
    // seeding this is naturally 0 (we download nothing).
    seeds: t.peersSendingToUs,
    status: mapStatus(t, d.status),
  };
}

const TR_PRIORITY: Record<number, FilePriority> = { [-1]: 'low', 0: 'normal', 1: 'high' };

/** files + fileStats (parallel arrays) → the app's TorrentFile list. */
export function mapFiles(t: TrTorrent): TorrentFile[] {
  const files = t.files ?? [];
  const stats = t.fileStats ?? [];
  return files.map((f, i) => {
    const st = stats[i];
    return {
      index: i,
      name: path.basename(f.name),
      path: f.name, // torrent-relative, includes the root folder — same as webtorrent's file.path
      length: f.length,
      downloaded: f.bytesCompleted,
      progress: f.length > 0 ? f.bytesCompleted / f.length : 1,
      priority: st ? (st.wanted ? TR_PRIORITY[st.priority] ?? 'normal' : 'skip') : 'normal',
    };
  });
}

export function mapPeers(t: TrTorrent): PeerInfo[] {
  return (t.peers ?? []).map((p) => ({
    address: `${p.address}:${p.port}`,
    client: p.clientName || undefined,
    connType: p.isUTP ? (p.isIncoming ? 'utp-in' : 'utp-out') : (p.isIncoming ? 'tcp-in' : 'tcp-out'),
    downSpeed: p.rateToClient,
    upSpeed: p.rateToPeer,
    downloaded: p.bytesToClient ?? 0,
    uploaded: p.bytesToPeer ?? 0,
    progress: p.progress,
    // transmission naming: client* = our side of the link, peer* = theirs.
    flags: {
      interested: p.clientIsInterested,
      choking: p.peerIsChoked,
      peerInterested: p.peerIsInterested,
      peerChoking: p.clientIsChoked,
    },
  }));
}

export function mapTrackers(t: TrTorrent): TrackerInfo[] {
  return (t.trackerStats ?? []).map((s) => ({
    url: s.announce,
    status: s.lastAnnounceSucceeded
      ? 'connected'
      : s.lastAnnounceTime > 0 || s.lastAnnounceResult
        ? 'error'
        : 'updating',
    peers: Math.max(0, s.lastAnnouncePeerCount || s.seederCount + s.leecherCount || 0),
    lastAnnounce: s.lastAnnounceTime > 0 ? s.lastAnnounceTime * 1000 : undefined,
  }));
}

/**
 * Aggregate connected peers across all torrents into the swarm-map shape.
 * Pure: the caller injects `lookupCountry` (ip → ISO-2 or null) so ip3country
 * init stays out of this function. transmission peer `address` is a bare IP (no
 * port), unlike webtorrent's ip:port. A peer counts as a seed at progress≈1.
 */
export function aggregateSwarmGeo(peerLists: TrPeer[][], lookupCountry: (ip: string) => string | null): SwarmGeo {
  const byCountry = new Map<string, { count: number; downBps: number; upBps: number; seeds: number }>();
  let totalConns = 0;
  let resolved = 0;
  let torrents = 0;
  for (const peers of peerLists) {
    if (peers.length > 0) torrents++;
    for (const p of peers) {
      totalConns++;
      const cc = lookupCountry(p.address);
      if (!cc) continue;
      resolved++;
      const e = byCountry.get(cc) ?? { count: 0, downBps: 0, upBps: 0, seeds: 0 };
      e.count++;
      e.downBps += p.rateToClient;
      e.upBps += p.rateToPeer;
      if (p.progress >= 0.999) e.seeds++;
      byCountry.set(cc, e);
    }
  }
  const points: SwarmGeoPoint[] = [];
  for (const [country, e] of byCountry) points.push({ country, ...e });
  points.sort((a, b) => b.count - a.count);
  return { points, totalConns, resolved, torrents };
}

// ── Trackers (torrent-set trackerList is the 4.0+ replacement for trackerAdd/Remove) ──

/** Drop a single trailing slash so tracker URLs compare/dedupe consistently. */
export function stripTrackerSlash(url: string): string {
  const s = String(url || '').trim();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Validate + normalize a tracker URL, or throw INVALID_INPUT (parity with webtorrent). */
export function normalizeTrackerUrl(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) throw new TorrentError('Tracker URL is empty', 'INVALID_INPUT');
  let proto: string;
  try { proto = new URL(url).protocol; } catch { throw new TorrentError('Invalid tracker URL', 'INVALID_INPUT'); }
  if (!['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(proto)) {
    throw new TorrentError('Unsupported tracker protocol (use http/https/udp/ws)', 'INVALID_INPUT');
  }
  return stripTrackerSlash(url);
}

/**
 * Read-modify-write of transmission's `trackerList` string. Splits the current
 * list into announce URLs, applies removes (by normalized compare) then adds
 * (append-if-absent), and rejoins one-URL-per-tier ('\n\n'). Empty result = all
 * trackers cleared (legitimate only when removing the last one).
 */
export function editTrackerList(current: string | undefined, opts: { add?: string[]; remove?: string[] }): string {
  const removeSet = new Set((opts.remove ?? []).map(stripTrackerSlash));
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (url: string) => {
    const u = String(url || '').trim();
    if (!u) return;
    const key = stripTrackerSlash(u);
    if (removeSet.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };
  for (const line of String(current ?? '').split(/\r?\n/)) push(line);
  for (const url of opts.add ?? []) push(url);
  return out.join('\n\n');
}

// ── IP blocklist (transmission P2P-plaintext format) ──

/**
 * Build a transmission P2P-plaintext blocklist from merged [startInt,endInt]
 * IPv4 ranges. One `label:A.B.C.D-E.F.G.H` line per range (range form required
 * even for a single IP).
 */
export function buildBlocklistP2P(ranges: ReadonlyArray<readonly [number, number]>): string {
  return ranges.map(([s, e]) => `havvn:${numToIp(s)}-${numToIp(e)}`).join('\n');
}

/** Byte offset of file `fileIndex`'s first piece → piece index (sequential head). */
export function fileBeginPiece(fileLengths: number[], fileIndex: number, pieceSize: number): number {
  if (pieceSize <= 0) return 0;
  let offset = 0;
  for (let i = 0; i < fileIndex && i < fileLengths.length; i++) offset += fileLengths[i];
  return Math.floor(offset / pieceSize);
}
