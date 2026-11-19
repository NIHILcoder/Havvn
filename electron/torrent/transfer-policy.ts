import type { TransferBlock } from '../../shared/effective-settings';
import { TorrentError } from './errors';

// Main owns the policy; the host receives it at init and on each change.
let blocks: TransferBlock[] = [];
const blockedListeners = new Set<() => void>();
export function setTransferBlocks(next: readonly TransferBlock[]): void {
  blocks = [...new Set(next)];
  if (blocks.length) for (const listener of blockedListeners) listener();
}
/** Temporary metadata clients are not part of the managed download list. */
export function onTransfersBlocked(listener: () => void): () => void {
  blockedListeners.add(listener);
  return () => { blockedListeners.delete(listener); };
}
export function transfersBlocked(): boolean { return blocks.length > 0; }
export function assertTransfersAllowed(): void {
  if (blocks.length) throw new TorrentError(`Transfers paused by protection: ${blocks.join(', ')}`, 'TRANSFER_BLOCKED');
}
export function assertTransferCommandAllowed(method: string): void {
  if (['resumeDownload', 'resumeAllPaused', 'retryDownload', 'activateRestoredDownload', 'addDownload', 'addSeed', 'getTorrentInfo', 'getStreamUrl', 'prefetchEpisode'].includes(method)) assertTransfersAllowed();
}
