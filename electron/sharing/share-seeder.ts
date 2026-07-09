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
import WebTorrent from 'webtorrent';

// GitHub Pages receiver path. The repo was renamed TorrentHunt → Havvn, so Pages
// now serves at /Havvn/ and NEW links must use it. Links shared under the old
// /TorrentHunt/ path stop resolving once the rename lands (Pages project paths
// don't auto-redirect) — an accepted one-time cost of the rebrand.
const RECEIVER_BASE = 'https://nihilcoder.github.io/Havvn/share/';

// ICE servers + rendezvous trackers come from the shared module (see
// ice-servers.ts). This preload runs with sandbox:false, so require() works.
import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';

const SHARE_TRACKERS = RENDEZVOUS_TRACKERS;

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

function log(msg: string): void { try { ipcRenderer.send('share-log', msg); } catch { /* ignore */ } }

function ensureClient(useTurn: boolean, turnServers: any[] = []): any {
  if (!client) {
    clientUseTurn = useTurn;
    const iceServers = useTurn ? STUN_SERVERS.concat(turnServers) : STUN_SERVERS;
    client = new WebTorrent({
      utp: false,
      dht: false,
      tracker: { wrtc: nativeWrtc, rtcConfig: { iceServers } },
    } as any);
    client.on('error', (e: any) => log('share client error: ' + (e?.message || e)));
    log('Share client ready (Chromium WebRTC, TURN=' + useTurn + ')');
  }
  return client;
}

function toInfo(e: ShareEntry) {
  return { downloadId: e.downloadId, name: e.name, infoHash: e.infoHash, magnetURI: e.magnetURI, link: e.link, createdAt: e.createdAt };
}

function doShare(downloadId: string, contentPath: string, name: string, useTurn: boolean, turnServers: any[] = []): Promise<ShareEntry> {
  const existing = shares.get(downloadId);
  if (existing) return Promise.resolve(existing);
  if (!fs.existsSync(contentPath)) {
    return Promise.reject(new Error('File not found on disk — the download must be complete to share'));
  }
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
      c.seed(contentPath, { announce: SHARE_TRACKERS, name } as any, (torrent: any) => {
        if (settled) return; settled = true;
        c.removeListener('error', onError);
        torrent.on('error', (e: any) => log('torrent error: ' + (e?.message || e)));
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

function doStop(downloadId: string): void {
  const entry = shares.get(downloadId);
  if (!entry || !client) return;
  shares.delete(downloadId);
  try {
    const t = client.torrents.find((x: any) => x.infoHash === entry.infoHash);
    if (t) client.remove(t);
  } catch (e) { log('stop failed: ' + String(e)); }
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
    if (type === 'share') data = toInfo(await doShare(msg.downloadId, msg.contentPath, msg.name, msg.useTurn !== false, msg.turnServers || []));
    else if (type === 'stop') { doStop(msg.downloadId); data = { ok: true }; }
    else if (type === 'get') data = getInfo(msg.downloadId);
    else if (type === 'list') data = Array.from(shares.values()).map(toInfo).sort((a, b) => b.createdAt - a.createdAt);
    else throw new Error('Unknown command: ' + type);
    ipcRenderer.send('share-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('share-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('share-ready');
