import { sharePieceCache } from '../torrent/piece-cache';
import { useChromiumWebRTC as configureChromiumWebRTC } from './chromium-webrtc';
/**
 * Share seeder — runs as the PRELOAD of a hidden BrowserWindow.
 *
 * Why a hidden window? The native WebRTC module (@roamhq/wrtc) crashes under
 * Electron when establishing a connection. A renderer, however, has Chromium's
 * own battle-tested WebRTC (the same stack the browser receiver uses). So we run
 * the node build of WebTorrent here (it can seed a file straight from a disk
 * path, no in-memory copy) and hand it the window's native WebRTC. Best of both.
 *
 * Talks to the main process over ipcRenderer:
 *   main → here:  'share-cmd'  { type, reqId, ... }
 *   here → main:  'share-res'  { reqId, ok, data|error }  and  'share-log'
 */

import { ipcRenderer } from 'electron';
import fs from 'fs';
// Required (not bundled), so this resolves WebTorrent's NODE build — which can
// seed from a path — while WebRTC comes from the window below.
import type WebTorrentType from 'webtorrent';
let WebTorrent: typeof WebTorrentType;
let ShareChunkStore: ReturnType<typeof sharePieceCache.store>;

// GitHub Pages receiver path. The repo was renamed TorrentHunt → Havvn, so Pages
// now serves at /Havvn/ and NEW links must use it. Links shared under the old
// /TorrentHunt/ path stop resolving once the rename lands (Pages project paths
// don't auto-redirect) — an accepted one-time cost of the rebrand.
const RECEIVER_BASE = 'https://nihilcoder.github.io/Havvn/share/';

// ICE servers + rendezvous trackers come from the shared module (see
// ice-servers.ts). This preload runs with sandbox:false, so require() works.
import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';

const w = window as any;
const nativeWrtc = {
  RTCPeerConnection: w.RTCPeerConnection,
  RTCSessionDescription: w.RTCSessionDescription,
  RTCIceCandidate: w.RTCIceCandidate,
};

interface ShareEntry {
  downloadId: string; name: string; infoHash: string; magnetURI: string; link: string; createdAt: number;
}

let client: any = null;
let clientUseTurn = true;
const shares = new Map<string, ShareEntry>();
const shareJobs = new Map<string, Promise<ShareEntry>>();
const shareEpochs = new Map<string, number>();
function releaseEmptyClient(): void {
  if (shares.size || shareJobs.size || !client) return;
  const old = client; client = null;
  try { old.destroy(); } catch (error) { log('share client cleanup failed: ' + String(error)); }
}
function doShare(downloadId: string, contentPath: string, name: string, useTurn: boolean,
  turnServers: any[] = [], trackers: string[] = RENDEZVOUS_TRACKERS): Promise<ShareEntry> {
  const pending = shareJobs.get(downloadId);
  if (pending) return pending;
  const epoch = shareEpochs.get(downloadId) ?? 0;
  const job = seedShare(downloadId, contentPath, name, useTurn, turnServers, trackers, epoch)
    .finally(() => {
      if (shareJobs.get(downloadId) === job) { shareJobs.delete(downloadId); shareEpochs.delete(downloadId); }
      releaseEmptyClient();
    });
  shareJobs.set(downloadId, job);
  return job;
}

function log(msg: string): void { try { ipcRenderer.send('share-log', msg); } catch { /* ignore */ } }

function ensureClient(useTurn: boolean, turnServers: any[] = []): any {
  if (!client) {
    clientUseTurn = useTurn;
    const iceServers = useTurn ? STUN_SERVERS.concat(turnServers) : STUN_SERVERS;
    client = new WebTorrent({
      natUpnp: false, natPmp: false,
      utp: false,
      dht: false,
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers } },
    } as any);
    const owned = client;
    client.on('error', (e: any) => {
      log('share client error: ' + (e?.message || e));
      if (client === owned && owned.destroyed) {
        client = null; shares.clear();
        try { ipcRenderer.send('share-count', shareJobs.size); } catch { /* shutting down */ }
      }
    });
    log('Share client ready (Chromium WebRTC, TURN=' + useTurn + ')');
  }
  return client;
}

function toInfo(e: ShareEntry) {
  return { downloadId: e.downloadId, name: e.name, infoHash: e.infoHash, magnetURI: e.magnetURI, link: e.link, createdAt: e.createdAt };
}

async function seedShare(downloadId: string, contentPath: string, name: string, useTurn: boolean, turnServers: any[], trackers: string[], epoch: number): Promise<ShareEntry> {
  const existing = shares.get(downloadId);
  if (existing) return Promise.resolve(existing);
  if (!fs.existsSync(contentPath)) {
    return Promise.reject(new Error('File not found on disk — the download must be complete to share'));
  }
  configureChromiumWebRTC();
  WebTorrent ??= (await import('webtorrent')).default;
  ShareChunkStore ??= sharePieceCache.store((await import('fs-chunk-store')).default);
  if ((shareEpochs.get(downloadId) ?? 0) !== epoch) throw new Error('Sharing was canceled');
  const c = ensureClient(useTurn, turnServers);
  return new Promise<ShareEntry>((resolve, reject) => {
    let settled = false;
    const onError = (err: any) => {
      if (settled) return; settled = true;
      c.removeListener('error', onError);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    c.once('error', onError);
    try {
      c.seed(contentPath, { announce: trackers, name, store: ShareChunkStore, storeCacheSlots: 0 } as any, (torrent: any) => {
        if (settled) return; settled = true;
        c.removeListener('error', onError);
        if ((shareEpochs.get(downloadId) ?? 0) !== epoch) {
          if (![...shares.values()].some(entry => entry.infoHash === torrent.infoHash)) void Promise.resolve(c.remove(torrent)).catch(() => {});
          reject(new Error('Sharing was canceled')); return;
        }
        torrent.on('error', (e: any) => {
          log('torrent error: ' + (e?.message || e));
          if (client !== c) return;
          for (const [id, entry] of shares) if (entry.infoHash === torrent.infoHash) shares.delete(id);
          releaseEmptyClient();
          try { ipcRenderer.send('share-count', shares.size + shareJobs.size); } catch { /* shutting down */ }
        });
        torrent.on('warning', () => { /* tracker/peer noise */ });
        const entry: ShareEntry = {
          downloadId, name,
          infoHash: torrent.infoHash,
          magnetURI: torrent.magnetURI,
          // Short, name-independent link: just the infoHash. The receiver page
          // reconstructs the magnet with its (matching) tracker list. When TURN
          // is off we tag the link ("|nt") so the receiver also skips TURN —
          // otherwise the receiver could still pull us onto a relay.
          link: RECEIVER_BASE + '#' + torrent.infoHash + (clientUseTurn ? '' : '|nt'),
          createdAt: Date.now(),
        };
        shares.set(downloadId, entry);
        log('Sharing started: ' + name);
        resolve(entry);
      });
    } catch (e) { onError(e); }
  });
}

async function doStop(downloadId: string): Promise<void> {
  if (shareJobs.has(downloadId)) shareEpochs.set(downloadId, (shareEpochs.get(downloadId) ?? 0) + 1);
  const entry = shares.get(downloadId), c = client;
  if (!entry || !c) { releaseEmptyClient(); return; }
  shares.delete(downloadId);
  try {
    // Different download entries can refer to the same swarm.
    if (![...shares.values()].some(other => other.infoHash === entry.infoHash)) {
      const torrent = c.torrents.find((t: any) => t.infoHash === entry.infoHash);
      if (torrent) await new Promise<void>((resolve, reject) => {
        void Promise.resolve(c.remove(torrent, (error?: Error) => error ? reject(error) : resolve())).catch(reject);
      });
    }
  } finally { releaseEmptyClient(); }
}

function getInfo(downloadId: string): any {
  const entry = shares.get(downloadId);
  if (!entry) return null;
  let peers = 0;
  if (client) {
    const t = client.torrents.find((x: any) => x.infoHash === entry.infoHash);
    peers = t ? (t.numPeers || 0) : 0;
  }
  return { ...toInfo(entry), peers };
}

ipcRenderer.on('share-cmd', async (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'share') data = toInfo(await doShare(msg.downloadId, msg.contentPath, msg.name, msg.useTurn !== false, msg.turnServers || [], msg.trackers?.length ? msg.trackers : RENDEZVOUS_TRACKERS));
    else if (type === 'stop') { await doStop(msg.downloadId); data = { ok: true }; }
    else if (type === 'get') data = getInfo(msg.downloadId);
    else if (type === 'list') data = Array.from(shares.values()).map(toInfo).sort((a, b) => b.createdAt - a.createdAt);
    else throw new Error('Unknown command: ' + type);
    ipcRenderer.send('share-res', { reqId, ok: true, data, activeCount: shares.size + shareJobs.size });
  } catch (e: any) {
    ipcRenderer.send('share-res', { reqId, ok: false, error: e?.message || String(e), activeCount: shares.size + shareJobs.size });
  }
});

ipcRenderer.send('share-ready');
