import { prefetchPieceRange, type EpisodePrefetchResult } from '../../shared/episode-prefetch';

interface Selection { from: number; to: number; notify?: () => void; isStreamSelection?: boolean }
export interface PrefetchTorrent {
  pieceLength: number;
  bitfield: { get(index: number): boolean };
  _selections: { _items: Selection[] };
  _select(start: number, end: number, priority: number, notify: () => void, stream: boolean): void;
  _updateSelections(): void;
}
interface Lease { token: string; file: number; torrent: PrefetchTorrent; selection: Selection; timer: NodeJS.Timeout }

/** Ephemeral selections only: no file priority, persistent setting or pause changes. */
export class EpisodePrefetcher {
  private leases = new Map<string, Lease>();
  supported(torrent: PrefetchTorrent): boolean {
    return typeof torrent._select === 'function' && Array.isArray(torrent._selections?._items);
  }
  start(id: string, token: string, torrent: PrefetchTorrent, file: number, offset: number, length: number, budget: number): EpisodePrefetchResult {
    const existing = this.leases.get(id);
    const range = prefetchPieceRange(offset, length, torrent.pieceLength, budget);
    if (!range || !this.supported(torrent)) { this.cancel(id); return { state: 'unsupported', bytes: 0 }; }
    if (existing && (existing.token !== token || existing.file !== file || existing.torrent !== torrent || existing.selection.from !== range.start || existing.selection.to !== range.end)) this.cancel(id);
    let complete = true;
    for (let i = range.start; i <= range.end; i++) if (!torrent.bitfield.get(i)) { complete = false; break; }
    if (complete) { this.cancel(id, token); return { state: 'ready', bytes: range.bytes }; }
    let lease = this.leases.get(id);
    if (!lease) {
      const notify = () => {};
      // Stream selections remain separate in WebTorrent 3.x. Priority 0.5 is
      // below current playback's range requests (1) and instant-play head (10).
      torrent._select(range.start, range.end, 0.5, notify, true);
      const selection = torrent._selections._items.find(item => item.notify === notify);
      if (!selection) throw new Error('Prefetch selection was not isolated');
      lease = { token, file, torrent, selection, timer: setTimeout(() => this.cancel(id, token), 5000) };
      this.leases.set(id, lease);
    } else {
      clearTimeout(lease.timer);
      lease.timer = setTimeout(() => this.cancel(id, token), 5000);
    }
    lease.timer.unref();
    return { state: 'active', bytes: range.bytes };
  }
  cancel(id: string, token?: string): void {
    const lease = this.leases.get(id);
    if (!lease || (token && token !== lease.token)) return;
    this.leases.delete(id);
    clearTimeout(lease.timer);
    // Remove the exact selection object, rather than deselect(range): a stream
    // or user selection with identical boundaries must remain untouched.
    const items = lease.torrent._selections?._items;
    const index = items?.indexOf(lease.selection) ?? -1;
    if (index >= 0) {
      items.splice(index, 1);
      try { lease.torrent._updateSelections(); } catch { /* torrent already destroyed */ }
    }
  }
  clear(): void { for (const id of this.leases.keys()) this.cancel(id); }
}
