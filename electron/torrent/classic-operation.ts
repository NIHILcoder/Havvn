import type { Download } from '../../shared/types';
import { downloadOperation } from '../../shared/download-operation';

interface ClassicActivity {
  metadata?: unknown;
  ready?: boolean;
  progress: number;
  numPeers: number;
  downloadSpeed: number;
}
export function classicDownloadOperation(download: Download, torrent?: ClassicActivity | null) {
  if (!torrent) return downloadOperation(download);
  return downloadOperation({ ...download, progress: torrent.progress }, {
    stage: !torrent.metadata ? 'metadata' : !torrent.ready ? 'checking' : 'transfer',
    // WebTorrent's verified-piece count counts valid pieces, not pieces checked.
    // Missing/corrupt pieces must not turn a completed scan into a partial scan.
    peers: torrent.numPeers, downSpeedBps: torrent.downloadSpeed,
  });
}
