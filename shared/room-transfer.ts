import type { RoomFile, RoomTransfer } from './types';

/** The file row's actions must follow plaintext readiness, not torrent percent. */
export function roomTransferView(file: Pick<RoomFile, 'enc'>, tr: RoomTransfer | undefined, autoFetch: boolean) {
  const phase = tr?.phase ?? (tr?.status === 'error' ? 'error' : tr?.haveLocally ? 'ready' : tr?.status === 'downloading' ? 'downloading' : 'queued');
  const busy = phase === 'verifying' || phase === 'decrypting';
  const ready = !!tr?.haveLocally && phase === 'ready';
  const retryDecrypt = !!file.enc && !!tr?.cipherReady && !ready && !busy;
  const fetch = phase === 'paused' || (!ready && !busy && !retryDecrypt && phase !== 'downloading' && tr?.queuePosition === undefined && (!autoFetch || phase === 'error'));
  return { phase, ready, busy, retryDecrypt, fetch, downloading: phase === 'downloading' };
}
