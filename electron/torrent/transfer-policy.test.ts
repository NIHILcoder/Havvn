import { afterEach, expect, it } from 'vitest';
import { assertTransferCommandAllowed, assertTransfersAllowed, setTransferBlocks, transfersBlocked } from './transfer-policy';

afterEach(() => setTransferBlocks([]));
it('blocks every transfer activation entry while allowing pause/removal/settings', () => {
  setTransferBlocks(['vpn', 'disk']);
  for (const method of ['resumeDownload', 'resumeAllPaused', 'retryDownload', 'activateRestoredDownload', 'addDownload', 'addSeed', 'getTorrentInfo', 'getStreamUrl', 'prefetchEpisode']) expect(() => assertTransferCommandAllowed(method)).toThrow(/protection/);
  for (const method of ['pauseDownload', 'pauseAllActive', 'removeDownload', 'getDownloads', 'updateSettings']) expect(() => assertTransferCommandAllowed(method)).not.toThrow();
});
it('one remaining protection still blocks starts; recovery only opens the gate', () => {
  setTransferBlocks(['disk']); expect(transfersBlocked()).toBe(true); expect(assertTransfersAllowed).toThrow();
  setTransferBlocks([]); expect(transfersBlocked()).toBe(false); expect(assertTransfersAllowed).not.toThrow();
});
