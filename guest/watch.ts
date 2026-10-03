/**
 * WebTorrent playback for a guest. Non-E2E, browser-native containers only.
 * Together-sync is applied by the UI against GuestRoom.sendSync / onSync.
 */

import { PUBLIC_STUN_SERVERS } from '../shared/room-guest-url';

export interface WatchHandle {
  fileId: string;
  destroy(): void;
}

interface WtFile {
  name: string;
  renderTo?(el: HTMLMediaElement, opts?: { autoplay?: boolean; controls?: boolean }): void;
  getBlobURL(cb: (err: Error | null, url: string) => void): void;
}

interface WtTorrent {
  files?: WtFile[];
}

interface WtClient {
  add(magnet: string, opts: unknown, cb: (t: WtTorrent) => void): void;
  remove(t: WtTorrent): void;
  destroy(): void;
}

declare const WebTorrent: { new (opts?: unknown): WtClient; WEBRTC_SUPPORT?: boolean } | undefined;

export function webtorrentOk(): boolean {
  return typeof WebTorrent !== 'undefined' && WebTorrent.WEBRTC_SUPPORT !== false;
}

export function playMagnet(
  magnetURI: string,
  fileId: string,
  fileName: string,
  media: HTMLMediaElement,
  trackers: string[],
): WatchHandle {
  if (typeof WebTorrent === 'undefined') throw new Error('no-wt');
  const client = new WebTorrent({
    tracker: { rtcConfig: { iceServers: [...PUBLIC_STUN_SERVERS] } },
  });
  let torrent: WtTorrent | null = null;
  let destroyed = false;
  let blobUrl: string | undefined;
  client.add(magnetURI, { announce: trackers }, (t) => {
    if (destroyed) return;
    torrent = t;
    const files = t.files || [];
    const file = files.find((f) => f.name === fileName) || files[0];
    if (!file) return;
    if (typeof file.renderTo === 'function') {
      file.renderTo(media, { autoplay: false, controls: true });
    } else {
      file.getBlobURL((err, url) => {
        if (err || !url) return;
        if (destroyed) { URL.revokeObjectURL(url); return; }
        blobUrl = url;
        media.src = url;
      });
    }
  });
  return {
    fileId,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try { if (torrent) client.remove(torrent); } catch { /* ignore */ }
      try { client.destroy(); } catch { /* ignore */ }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    },
  };
}
