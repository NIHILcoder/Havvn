// getTorrentManager() returns the main-process proxy; the real TorrentManager +
// WebTorrent run in the torrent-host utilityProcess. TorrentManager is exported as
// a TYPE only (importing its value would pull WebTorrent into the main process).
export type { TorrentManager } from './manager';
export type { TorrentManagerProxy } from './host/manager-proxy';
export { getTorrentManager } from './host/manager-proxy';
export { TorrentError } from './errors';
// Torrent CREATION now runs in the host (via the proxy's createTorrentFile);
// only the lightweight tracker list is exported to main here. creator.ts (which
// imports WebTorrent) must not be value-imported by the main process.
export { getDefaultTrackers, DEFAULT_TRACKERS } from './trackers';
