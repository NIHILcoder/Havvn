import { describe, it, expect } from 'vitest';
import {
  mapStatus, mapStats, mapFiles, mapPeers, mapTrackers, aggregateSwarmGeo,
  editTrackerList, normalizeTrackerUrl, stripTrackerSlash, buildBlocklistP2P, fileBeginPiece,
  mapTorrentInfo, complementIndices,
} from './map';
import { TrStatus, TrTorrent, TrPeer, TrTrackerStat } from './transmission-rpc';
import { TorrentError } from '../errors';
import type { Download } from '../../../shared/types';

const tr = (over: Partial<TrTorrent>): TrTorrent => ({
  id: 1, hashString: 'a'.repeat(40), name: 't', status: TrStatus.Downloading,
  percentDone: 0.5, recheckProgress: 0, totalSize: 100, sizeWhenDone: 100, leftUntilDone: 50,
  rateDownload: 1000, rateUpload: 200, downloadedEver: 50, uploadedEver: 10, uploadRatio: 0.2,
  eta: 60, peersConnected: 5, peersSendingToUs: 3, peersGettingFromUs: 1,
  error: 0, errorString: '', isFinished: false, downloadDir: 'D:/dl', magnetLink: '',
  metadataPercentComplete: 1,
  ...over,
});

const dl = (over: Partial<Download>): Download => ({
  id: 'id1', name: 'n', sourceType: 'magnet', sourceUri: 'magnet:?', torrentFilePath: null,
  savePath: 'D:/dl', status: 'downloading', progress: 0.4, downloadedBytes: 40, uploadedBytes: 4,
  downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0, totalSize: 100,
  priority: 1, category: null, createdAt: new Date(0), updatedAt: new Date(0), lastError: null,
  ...over,
});

describe('mapStatus', () => {
  it('maps daemon activity to app statuses', () => {
    expect(mapStatus(tr({ status: TrStatus.Downloading }), 'paused')).toBe('downloading');
    expect(mapStatus(tr({ status: TrStatus.DownloadWait }), 'paused')).toBe('downloading');
    expect(mapStatus(tr({ status: TrStatus.Seeding }), 'downloading')).toBe('seeding');
    expect(mapStatus(tr({ status: TrStatus.SeedWait }), 'downloading')).toBe('seeding');
  });
  it('splits Stopped into paused vs completed by wanted bytes', () => {
    expect(mapStatus(tr({ status: TrStatus.Stopped, percentDone: 0.3 }), 'downloading')).toBe('paused');
    expect(mapStatus(tr({ status: TrStatus.Stopped, percentDone: 1 }), 'seeding')).toBe('completed');
    expect(mapStatus(tr({ status: TrStatus.Stopped, percentDone: 0.3, isFinished: true }), 'seeding')).toBe('completed');
  });
  it('error flag wins over activity', () => {
    expect(mapStatus(tr({ status: TrStatus.Downloading, error: 3 }), 'downloading')).toBe('error');
  });
  it('checking keeps a seeding/completed face, else reads as downloading', () => {
    expect(mapStatus(tr({ status: TrStatus.Checking }), 'seeding')).toBe('seeding');
    expect(mapStatus(tr({ status: TrStatus.CheckWait }), 'completed')).toBe('completed');
    expect(mapStatus(tr({ status: TrStatus.Checking }), 'paused')).toBe('downloading');
  });
});

describe('mapStats', () => {
  it('uses live daemon numbers when present', () => {
    const s = mapStats(dl({}), tr({}));
    expect(s).toMatchObject({ id: 'id1', progress: 0.5, downSpeedBps: 1000, peers: 5, seeds: 3, etaSeconds: 60, status: 'downloading' });
  });
  it('falls back to the persisted snapshot with zero speeds when the torrent is not live', () => {
    const s = mapStats(dl({ status: 'paused', progress: 0.4 }), undefined);
    expect(s).toMatchObject({ progress: 0.4, downSpeedBps: 0, upSpeedBps: 0, peers: 0, seeds: 0, etaSeconds: null, status: 'paused' });
  });
  it('normalizes eta sentinels (-1/-2) to null', () => {
    expect(mapStats(dl({}), tr({ eta: -1 })).etaSeconds).toBeNull();
  });
});

describe('mapFiles', () => {
  it('joins files with fileStats and maps skip/priority', () => {
    const t = tr({
      files: [
        { name: 'Show/ep1.mkv', length: 100, bytesCompleted: 50 },
        { name: 'Show/ep2.mkv', length: 100, bytesCompleted: 0 },
      ],
      fileStats: [
        { wanted: true, priority: 1, bytesCompleted: 50 },
        { wanted: false, priority: 0, bytesCompleted: 0 },
      ],
    });
    const files = mapFiles(t);
    expect(files[0]).toMatchObject({ index: 0, name: 'ep1.mkv', path: 'Show/ep1.mkv', progress: 0.5, priority: 'high' });
    expect(files[1].priority).toBe('skip');
  });
});

describe('mapTorrentInfo', () => {
  it('maps daemon files to the add-dialog preview shape', () => {
    const info = mapTorrentInfo(tr({
      name: 'Pack',
      totalSize: 30,
      files: [
        { name: 'Pack/a.mkv', length: 20, bytesCompleted: 0 },
        { name: 'Pack/sub/b.srt', length: 10, bytesCompleted: 0 },
      ],
    }));
    expect(info.name).toBe('Pack');
    expect(info.totalSize).toBe(30);
    expect(info.files).toEqual([
      { path: 'Pack/a.mkv', size: 20, index: 0 },
      { path: 'Pack/sub/b.srt', size: 10, index: 1 },
    ]);
  });

  it('falls back to summing files when totalSize is 0, and tolerates no files', () => {
    const info = mapTorrentInfo(tr({ totalSize: 0, files: [{ name: 'x', length: 7, bytesCompleted: 0 }] }));
    expect(info.totalSize).toBe(7);
    expect(mapTorrentInfo(tr({ files: undefined })).files).toEqual([]);
  });
});

describe('complementIndices', () => {
  it('returns the unwanted complement of a selection', () => {
    expect(complementIndices(4, [0, 2])).toEqual([1, 3]);
  });

  it('returns undefined when there is nothing to unwant', () => {
    expect(complementIndices(3, undefined)).toBeUndefined();
    expect(complementIndices(3, [])).toBeUndefined();
    expect(complementIndices(3, [0, 1, 2])).toBeUndefined();
    expect(complementIndices(0, [1])).toBeUndefined();
  });

  it('never unwants every file (out-of-range selection would brick the add)', () => {
    expect(complementIndices(2, [5])).toBeUndefined();
  });
});

describe('mapPeers', () => {
  it('maps transport, direction and choke semantics', () => {
    const peer: TrPeer = {
      address: '1.2.3.4', port: 51413, clientName: 'qBittorrent 5.0', isUTP: true, isEncrypted: true,
      isIncoming: false, rateToClient: 500, rateToPeer: 100, progress: 0.8, flagStr: 'DE',
      clientIsChoked: true, clientIsInterested: true, peerIsChoked: false, peerIsInterested: true,
      bytesToClient: 1234, bytesToPeer: 99,
    };
    const [p] = mapPeers(tr({ peers: [peer] }));
    expect(p).toMatchObject({
      address: '1.2.3.4:51413', connType: 'utp-out', downSpeed: 500, upSpeed: 100,
      downloaded: 1234, uploaded: 99,
      flags: { interested: true, choking: false, peerInterested: true, peerChoking: true },
    });
  });
});

describe('mapTrackers', () => {
  const stat = (over: Partial<TrTrackerStat>): TrTrackerStat => ({
    id: 0, host: 'tr.example', announce: 'udp://tr.example/announce', announceState: 1,
    lastAnnounceResult: '', lastAnnounceSucceeded: false, lastAnnounceTime: 0,
    lastAnnouncePeerCount: 0, seederCount: 0, leecherCount: 0, ...over,
  });
  it('classifies connected / error / updating', () => {
    const t = tr({
      trackerStats: [
        stat({ lastAnnounceSucceeded: true, lastAnnounceTime: 1000, lastAnnouncePeerCount: 7 }),
        stat({ lastAnnounceResult: 'Could not connect', lastAnnounceTime: 900 }),
        stat({}),
      ],
    });
    const [ok, err, fresh] = mapTrackers(t);
    expect(ok).toMatchObject({ status: 'connected', peers: 7, lastAnnounce: 1_000_000 });
    expect(err.status).toBe('error');
    expect(fresh.status).toBe('updating');
  });
});

describe('aggregateSwarmGeo', () => {
  const peer = (over: Partial<TrPeer>): TrPeer => ({
    address: '1.2.3.4', port: 1, clientName: '', isUTP: false, isEncrypted: false, isIncoming: false,
    rateToClient: 0, rateToPeer: 0, progress: 0, flagStr: '', clientIsChoked: false, clientIsInterested: false,
    peerIsChoked: false, peerIsInterested: false, bytesToClient: 0, bytesToPeer: 0, ...over,
  });
  it('aggregates by country with a stubbed lookup; counts seeds at progress≈1', () => {
    const lookup = (ip: string): string | null => (ip.startsWith('9.') ? null : ip.startsWith('1.') ? 'US' : 'DE');
    const geo = aggregateSwarmGeo([
      [peer({ address: '1.1.1.1', rateToClient: 100, rateToPeer: 10, progress: 1, isUTP: true, isEncrypted: true }),
       peer({ address: '2.2.2.2', rateToClient: 50, rateToPeer: 5, progress: 0.5 })],
      [peer({ address: '1.9.9.9', rateToClient: 20, rateToPeer: 2, progress: 1, isEncrypted: true }),
       peer({ address: '9.9.9.9', progress: 1 })], // 9.* unresolved
    ], lookup);
    expect(geo.totalConns).toBe(4);
    expect(geo.resolved).toBe(3);
    expect(geo.torrents).toBe(2);
    const us = geo.points.find((p) => p.country === 'US')!;
    expect(us).toMatchObject({ count: 2, downBps: 120, upBps: 12, seeds: 2 });
    expect(geo.points.find((p) => p.country === 'DE')).toMatchObject({ count: 1, seeds: 0 });
    expect(geo.points[0].count).toBeGreaterThanOrEqual(geo.points[geo.points.length - 1].count); // sorted desc
    // Transport counts EVERY connection, resolved or not.
    expect(geo.transport).toEqual({ total: 4, utp: 1, tcp: 3, webrtc: 0, encrypted: 2 });
  });
  it('returns the zeroed shape for no peers', () => {
    expect(aggregateSwarmGeo([[], []], () => 'US')).toEqual({
      points: [], totalConns: 0, resolved: 0, torrents: 0,
      transport: { total: 0, utp: 0, tcp: 0, webrtc: 0, encrypted: 0 },
    });
  });
});

describe('tracker list editing', () => {
  it('normalizeTrackerUrl validates protocol and strips a trailing slash', () => {
    expect(normalizeTrackerUrl('udp://t.example:80/announce/')).toBe('udp://t.example:80/announce');
    expect(() => normalizeTrackerUrl('')).toThrow(TorrentError);
    expect(() => normalizeTrackerUrl('ftp://nope')).toThrow(/protocol/);
    expect(() => normalizeTrackerUrl('not a url')).toThrow(/Invalid/);
  });
  it('stripTrackerSlash removes at most one trailing slash', () => {
    expect(stripTrackerSlash('http://x/a/')).toBe('http://x/a');
    expect(stripTrackerSlash('http://x/a')).toBe('http://x/a');
  });
  it('editTrackerList adds if absent, dedupes, and joins one-per-tier', () => {
    const out = editTrackerList('udp://a/announce\n\nudp://b/announce', { add: ['udp://c/announce', 'udp://a/announce'] });
    expect(out).toBe('udp://a/announce\n\nudp://b/announce\n\nudp://c/announce');
  });
  it('editTrackerList removes by normalized compare (trailing slash tolerant)', () => {
    const out = editTrackerList('udp://a/announce\nudp://b/announce', { remove: ['udp://a/announce/'] });
    expect(out).toBe('udp://b/announce');
  });
  it('editTrackerList tolerates CRLF/blank lines and can clear to empty', () => {
    expect(editTrackerList('udp://a\r\n\r\nudp://b', { remove: ['udp://a', 'udp://b'] })).toBe('');
  });
});

describe('buildBlocklistP2P', () => {
  it('emits label:start-end dotted-quad lines', () => {
    // 1.2.3.4 = 0x01020304, 1.2.3.10 = 0x0102030a
    expect(buildBlocklistP2P([[0x01020304, 0x0102030a], [0x0a000000, 0x0a0000ff]]))
      .toBe('havvn:1.2.3.4-1.2.3.10\nhavvn:10.0.0.0-10.0.0.255');
  });
  it('is empty for no ranges', () => {
    expect(buildBlocklistP2P([])).toBe('');
  });
});

describe('fileBeginPiece', () => {
  it('computes the first piece of a file from prior file lengths', () => {
    expect(fileBeginPiece([1000, 2000, 3000], 0, 512)).toBe(0);
    expect(fileBeginPiece([1000, 2000, 3000], 1, 512)).toBe(Math.floor(1000 / 512)); // 1
    expect(fileBeginPiece([1000, 2000, 3000], 2, 512)).toBe(Math.floor(3000 / 512)); // 5
  });
  it('is 0 for a non-positive piece size', () => {
    expect(fileBeginPiece([1000], 0, 0)).toBe(0);
  });
});
