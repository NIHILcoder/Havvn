/**
 * ShareManager — "Instant Share Links" (Phase 2 of the P2P hub).
 *
 * Re-seeds a completed download from disk on a DEDICATED WebTorrent client that
 * has WebRTC enabled (@roamhq/wrtc) and announces to public WebSocket trackers.
 * A browser opening the share link runs WebTorrent in-page, meets this peer at
 * the same wss tracker, and pulls the file over WebRTC — no install, no cloud.
 *
 * Kept separate from the main download client so normal torrents are unaffected.
 */

import path from 'path';
import fs from 'fs';
import WebTorrent from 'webtorrent';
import { logger } from '../utils';

const log = logger.child('ShareManager');

// Public WebRTC (WebSocket) trackers used for browser ↔ desktop signalling.
// Several for redundancy — availability varies.
const SHARE_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.files.fm:7073/announce',
];

// Static receiver page (GitHub Pages). The magnet travels in the URL hash, so
// it never hits a server and works on a purely static host.
const RECEIVER_BASE = 'https://nihilcoder.github.io/TorrentHunt/share/';

export interface ActiveShare {
  downloadId: string;
  name: string;
  infoHash: string;
  magnetURI: string;
  link: string;
  createdAt: number;
}

export class ShareManager {
  private client: WebTorrent.Instance | null = null;
  private shares: Map<string, ActiveShare> = new Map(); // keyed by downloadId

  private ensureClient(): WebTorrent.Instance {
    if (!this.client) {
      // Lazy require so the native module only loads if sharing is ever used.
      const wrtc = require('@roamhq/wrtc');
      this.client = new WebTorrent({ tracker: { wrtc } } as any);
      this.client.on('error', (err: string | Error) => {
        log.error('Share client error', { error: err instanceof Error ? err.message : String(err) });
      });
      log.info('Share client created (WebRTC enabled)');
    }
    return this.client;
  }

  /**
   * Start sharing the content of a completed download. Returns the share link.
   * Re-shares return the existing link (idempotent per download).
   */
  async share(downloadId: string, contentPath: string, name: string): Promise<ActiveShare> {
    const existing = this.shares.get(downloadId);
    if (existing) return existing;

    if (!fs.existsSync(contentPath)) {
      throw new Error('File not found on disk — the download must be complete to share');
    }

    const client = this.ensureClient();

    return new Promise<ActiveShare>((resolve, reject) => {
      let settled = false;
      const onError = (err: string | Error) => {
        if (settled) return;
        settled = true;
        client.removeListener('error', onError);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      client.once('error', onError);

      try {
        client.seed(contentPath, { announce: SHARE_TRACKERS, name } as any, (torrent: any) => {
          if (settled) return;
          settled = true;
          client.removeListener('error', onError);

          const link = RECEIVER_BASE + '#' + encodeURIComponent(torrent.magnetURI);
          const share: ActiveShare = {
            downloadId,
            name,
            infoHash: torrent.infoHash,
            magnetURI: torrent.magnetURI,
            link,
            createdAt: Date.now(),
          };
          this.shares.set(downloadId, share);
          log.info('Sharing started', { downloadId, name, infoHash: torrent.infoHash });
          resolve(share);
        });
      } catch (e) {
        onError(e as Error);
      }
    });
  }

  /** Stop sharing a download (removes it from the share swarm). */
  async stop(downloadId: string): Promise<void> {
    const share = this.shares.get(downloadId);
    if (!share || !this.client) return;
    this.shares.delete(downloadId);
    try {
      const torrent = this.client.torrents.find((t: any) => t.infoHash === share.infoHash);
      if (torrent) this.client.remove(torrent);
      log.info('Sharing stopped', { downloadId, infoHash: share.infoHash });
    } catch (e) {
      log.warn('Failed to stop share', { downloadId, error: String(e) });
    }
  }

  getForDownload(downloadId: string): ActiveShare | null {
    return this.shares.get(downloadId) || null;
  }

  list(): ActiveShare[] {
    return Array.from(this.shares.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Peer count currently connected to a share (rough "is anyone downloading" signal). */
  getPeers(downloadId: string): number {
    const share = this.shares.get(downloadId);
    if (!share || !this.client) return 0;
    const torrent = this.client.torrents.find((t: any) => t.infoHash === share.infoHash);
    return torrent ? (torrent as any).numPeers || 0 : 0;
  }

  destroy(): void {
    this.shares.clear();
    if (this.client) {
      try { this.client.destroy(); } catch { /* ignore */ }
      this.client = null;
    }
    log.info('ShareManager destroyed');
  }
}

let shareManager: ShareManager | null = null;
export function getShareManager(): ShareManager {
  if (!shareManager) shareManager = new ShareManager();
  return shareManager;
}

/** Helper: absolute path to a download's content on disk. */
export function downloadContentPath(savePath: string, name: string): string {
  return path.join(savePath, name);
}
