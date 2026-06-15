/**
 * torrent-host — the entry point of the WebTorrent utilityProcess.
 *
 * Runs the real TorrentManager + WebTorrent + the in-app stream/transcode servers
 * (manager-internal) + the LAN cast server, all OFF the main thread so hashing /
 * verification / piece I/O never freeze the UI. Talks to main over parentPort:
 * answers `rpc` method calls, asks main to run `db` ops (single store owner),
 * and posts `stats`/`complete`/`state` events.
 */

import { setHostEnv } from './env';
import { wireDbBridge, resolveDbResponse, failAllDbRequests } from './db-bridge';
import { ToHost, FromHost } from './protocol';
import { TorrentManager } from '../manager';
import { setCastManager, getCastServer } from '../cast-server';
import { createTorrentFile } from '../creator';
import type { CreateTorrentProgress } from '../../../shared/types';

// parentPort is the MessagePortMain to the main process (utilityProcess).
const port = (process as unknown as { parentPort: { on(ev: string, cb: (e: { data: ToHost }) => void): void; postMessage(m: FromHost): void } }).parentPort;

function post(msg: FromHost): void {
  try { port.postMessage(msg); } catch { /* main gone */ }
}

let manager: TorrentManager | null = null;

// cast* method names are served by the cast server, not the manager.
const CAST_METHODS: Record<string, 'publish' | 'unpublish' | 'tvMedia' | 'publishDiskFile'> = {
  castPublish: 'publish',
  castUnpublish: 'unpublish',
  castTvMedia: 'tvMedia',
  castPublishDiskFile: 'publishDiskFile',
};

/** Push the values main mirrors for its synchronous getters. */
function postState(): void {
  if (!manager) return;
  post({
    kind: 'event',
    event: 'state',
    payload: {
      ffmpeg: manager.ffmpegBinary,
      listeningPort: manager.getListeningPort(),
      altSpeedEnabled: manager.isAltSpeedEnabled(),
    },
  });
}

port.on('message', async (e) => {
  const msg = e.data;
  try {
    if (msg.kind === 'init') {
      setHostEnv(msg.env);
      wireDbBridge((req) => post(req));
      manager = new TorrentManager();
      setCastManager(manager);
      manager.onStats((stats) => post({ kind: 'event', event: 'stats', payload: stats }));
      manager.onComplete((info) => post({ kind: 'event', event: 'complete', payload: info }));
      try { await manager.initialize(); } catch { /* manager logs + recovers per-torrent */ }
      postState();
      post({ kind: 'ready' });
      return;
    }

    if (msg.kind === 'db-res') {
      resolveDbResponse(msg.id, msg.ok, msg.result, msg.error);
      return;
    }

    if (msg.kind === 'rpc') {
      const { id, method, args } = msg;
      if (!manager) { post({ kind: 'rpc-res', id, ok: false, error: 'host not initialized' }); return; }
      try {
        let result: unknown;
        const cast = CAST_METHODS[method];
        if (method === 'createTorrentFile') {
          // Standalone creator fn — relay its hashing progress as an event.
          result = await createTorrentFile(args[0] as Parameters<typeof createTorrentFile>[0], (p: CreateTorrentProgress) => {
            post({ kind: 'event', event: 'create-progress', payload: p });
          });
        } else if (cast) {
          result = await (getCastServer() as unknown as Record<string, (...a: unknown[]) => unknown>)[cast](...args);
        } else {
          result = await (manager as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
        }
        post({ kind: 'rpc-res', id, ok: true, result });
        // Speed/port/alt-speed may have changed — refresh main's mirror.
        if (method === 'setAltSpeed' || method === 'updateSettings' || method === 'initialize') postState();
      } catch (err) {
        post({ kind: 'rpc-res', id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    // Never let a message handler throw uncaught (would kill the host).
    if (msg && (msg as { kind?: string }).kind === 'rpc') {
      post({ kind: 'rpc-res', id: (msg as { id: number }).id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// If main disconnects, stop waiting on db round-trips.
port.on?.('close', () => failAllDbRequests('main disconnected'));
