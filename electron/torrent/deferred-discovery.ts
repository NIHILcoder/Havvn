/** WebTorrent starts discovery before ready even with paused:true. During undo,
 * disk verification must not announce the restored hash before current guards allow it. */
interface Discovery { complete(): void; destroy(callback: () => void): void; tracker?: unknown }
interface TorrentDiscovery {
  _startDiscovery(): void;
  discovery: Discovery | null;
  ready: boolean;
  destroyed: boolean;
  done: boolean;
}
export function deferTorrentDiscovery(torrent: TorrentDiscovery): () => void {
  const start = torrent._startDiscovery;
  const offline: Discovery = { complete: () => {}, destroy: callback => callback() };
  let deferred = true;
  torrent._startDiscovery = () => { if (deferred) torrent.discovery = offline; else start.call(torrent); };
  return () => {
    if (!deferred || torrent.destroyed) return;
    deferred = false;
    if (torrent.discovery === offline) torrent.discovery = null;
    torrent._startDiscovery = start;
    if (torrent.ready) { start.call(torrent); if (torrent.done) torrent.discovery?.complete(); }
  };
}
