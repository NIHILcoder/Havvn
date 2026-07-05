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

/**
 * Serialize a rejected RPC preserving the error identity (message + code + name +
 * downloadId). Without the code, every downstream `err.code === 'DUPLICATE'` /
 * `'NO_SPACE'` check in main (IPC wrapHandler, watch-folder, RSS) silently fails.
 * Duck-typed so the host stays decoupled from the TorrentError class.
 */
function errPayload(err: unknown): { error: string; code?: string; name?: string; downloadId?: string } {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; downloadId?: unknown };
    return {
      error: e.message,
      code: typeof e.code === 'string' ? e.code : undefined,
      name: e.name,
      downloadId: typeof e.downloadId === 'string' ? e.downloadId : undefined,
    };
  }
  return { error: String(err) };
}

// The experimental µTP transport (and other native socket ops) can emit transient
// errors under load — notably WSAENOBUFS/ENOBUFS/EMFILE on Windows. Those used to
// crash the MAIN process; now they surface here in the isolated host. Swallow the
// transient ones so µTP doesn't tear the engine down; anything else is logged and
// the host exits cleanly so the proxy respawns it (crash recovery).
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  const code = err?.code || '';
  const transient = /ENOBUFS|EMFILE|ECONNRESET|EPIPE/i.test(code) || /no buffer space/i.test(err?.message || '');
  if (transient) {
    console.error('[host] swallowed transient socket error:', code || err?.message);
    return;
  }
  console.error('[host] fatal uncaughtException:', err?.stack || err?.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[host] unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
});

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
      // A throw anywhere in setup (constructor, cast wiring) would otherwise leave
      // the proxy's readiness promise unresolved forever — hanging app startup with
      // no error. Exit instead so the proxy's 'exit' handler rejects and can respawn.
      try {
        setHostEnv(msg.env);
        wireDbBridge((req) => post(req));
        manager = new TorrentManager();
        setCastManager(manager);
        manager.onStats((stats) => post({ kind: 'event', event: 'stats', payload: stats }));
        manager.onComplete((info) => post({ kind: 'event', event: 'complete', payload: info }));
        // Re-push state when the TCP pool actually binds — the port isn't known
        // yet at the postState() below, so main's mirror would otherwise keep 0.
        manager.onListening(() => postState());
        try { await manager.initialize(); } catch { /* manager logs + recovers per-torrent */ }
        postState();
        post({ kind: 'ready' });
      } catch (err) {
        console.error('[host] fatal init error:', err instanceof Error ? err.stack : String(err));
        process.exit(1);
      }
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
        post({ kind: 'rpc-res', id, ok: false, ...errPayload(err) });
      }
    }
  } catch (err) {
    // Never let a message handler throw uncaught (would kill the host).
    if (msg && (msg as { kind?: string }).kind === 'rpc') {
      post({ kind: 'rpc-res', id: (msg as { id: number }).id, ok: false, ...errPayload(err) });
    }
  }
});

// If main disconnects, stop waiting on db round-trips.
port.on?.('close', () => failAllDbRequests('main disconnected'));
