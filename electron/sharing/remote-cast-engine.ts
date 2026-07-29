/**
 * Remote-cast engine — PRELOAD of a hidden BrowserWindow (Chromium WebRTC),
 * same pattern as share-seeder / room-engine.
 *
 * Lets you watch a torrent on a device that is NOT on your local network (a
 * friend's phone, your phone on mobile data). The desktop transcodes the file to
 * fragmented MP4 with ffmpeg and streams the bytes to the remote browser over a
 * WebRTC data channel; the browser feeds them into a MediaSource and plays. Peers
 * find each other through a bittorrent-tracker rendezvous on a random topic (the
 * same mechanism rooms use), so it works across NATs via STUN/TURN.
 *
 * Also the proper fix for "a shared movie won't preview in the browser": instead
 * of transferring the raw (undecodable mkv/avi) file, we send a transcoded H.264
 * stream the browser can always play.
 *
 * IPC:  main → here 'rcast-cmd' {type,reqId,...}; here → main 'rcast-res'/'rcast-log'.
 */

import { ipcRenderer } from 'electron';
import crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackerClient = require('bittorrent-tracker') as any;

import { STUN_SERVERS, RENDEZVOUS_TRACKERS } from './ice-servers';

const w = window as any;
const nativeWrtc = {
  RTCPeerConnection: w.RTCPeerConnection,
  RTCSessionDescription: w.RTCSessionDescription,
  RTCIceCandidate: w.RTCIceCandidate,
};

// H.264 main@4.0 + AAC-LC — covers up to 1080p and is widely MSE-compatible.
const VIDEO_MIME = 'video/mp4; codecs="avc1.4D4028, mp4a.40.2"';
const CHUNK = 16 * 1024;       // data-channel message size
const HIGH_WATER = 8 * 1024 * 1024;  // pause ffmpeg above this buffered
const LOW_WATER = 1 * 1024 * 1024;   // resume below this

interface Session {
  id: string;
  topic: string;
  peerId: string;
  contentPath: string;
  ffmpeg: string;
  tracker: any;
  procs: Set<ChildProcess>;
  peers: Set<any>;
}

const sessions = new Map<string, Session>();

function log(msg: string): void { try { ipcRenderer.send('rcast-log', msg); } catch { /* ignore */ } }

function topicFor(sessionId: string): string {
  return crypto.createHash('sha1').update('th-watch:v1:' + sessionId).digest('hex');
}

/** Pump ffmpeg's fragmented-MP4 output to one viewer, respecting backpressure. */
function streamTo(session: Session, peer: any): void {
  const args = [
    '-i', session.contentPath,
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '4.0', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
  let proc: ChildProcess;
  try { proc = spawn(session.ffmpeg, args, { windowsHide: true }); }
  catch (e) { log('ffmpeg spawn failed: ' + String(e)); return; }
  session.procs.add(proc);

  const ch = peer._channel as any; // RTCDataChannel (DOM type not in electron lib)
  try { if (ch) ch.bufferedAmountLowThreshold = LOW_WATER; } catch { /* ignore */ }

  const kill = () => { session.procs.delete(proc); try { proc.kill('SIGKILL'); } catch { /* ignore */ } };

  // Tell the receiver what to expect, then stream bytes.
  try { peer.send(JSON.stringify({ t: 'init', mime: VIDEO_MIME })); } catch { /* ignore */ }

  const onLow = () => { try { proc.stdout?.resume(); } catch { /* ignore */ } };

  proc.stdout?.on('data', (buf: Buffer) => {
    for (let i = 0; i < buf.length; i += CHUNK) {
      try { peer.send(buf.subarray(i, Math.min(i + CHUNK, buf.length))); }
      catch { kill(); return; }
    }
    if (ch && ch.bufferedAmount > HIGH_WATER) {
      try { proc.stdout?.pause(); ch.addEventListener('bufferedamountlow', onLow, { once: true }); }
      catch { setTimeout(() => { try { proc.stdout?.resume(); } catch { /* ignore */ } }, 120); }
    }
  });
  proc.stderr?.on('data', () => { /* discard */ });
  proc.on('error', (e) => { log('ffmpeg error: ' + String(e)); kill(); });
  proc.on('close', () => { try { peer.send(JSON.stringify({ t: 'end' })); } catch { /* ignore */ } session.procs.delete(proc); });
}

function attachViewer(session: Session, peer: any): void {
  if (session.peers.has(peer)) return;
  session.peers.add(peer);
  const begin = () => streamTo(session, peer);
  if (peer.connected) begin(); else peer.once('connect', begin);
  peer.on('close', () => { session.peers.delete(peer); });
  peer.on('error', () => { /* transient */ });
  log('Viewer connected to ' + session.id.slice(0, 8));
}

function startSession(p: { id: string; contentPath: string; ffmpeg: string; useTurn: boolean; turnServers?: any[]; trackers?: string[] }): { id: string; topic: string } {
  let session = sessions.get(p.id);
  if (session) return { id: session.id, topic: session.topic };

  const iceServers = p.useTurn && p.turnServers?.length ? STUN_SERVERS.concat(p.turnServers) : STUN_SERVERS.slice();
  const topic = topicFor(p.id);
  session = {
    id: p.id, topic, peerId: crypto.randomBytes(20).toString('hex'),
    contentPath: p.contentPath, ffmpeg: p.ffmpeg,
    tracker: null, procs: new Set(), peers: new Set(),
  };
  sessions.set(p.id, session);

  try {
    const tracker = new TrackerClient({
      infoHash: topic, peerId: session.peerId, announce: p.trackers?.length ? p.trackers : RENDEZVOUS_TRACKERS, port: 6881,
      rtcConfig: { iceServers }, wrtc: nativeWrtc,
    });
    session.tracker = tracker;
    tracker.on('peer', (peer: any) => attachViewer(session!, peer));
    tracker.on('warning', () => { /* noise */ });
    tracker.on('error', (e: any) => log('tracker error: ' + (e?.message || e)));
    tracker.start();
    log('Remote-cast session ' + p.id.slice(0, 8) + ' (topic ' + topic.slice(0, 8) + ')');
  } catch (e) {
    log('tracker start failed: ' + String(e));
  }
  return { id: session.id, topic };
}

function stopSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  for (const proc of session.procs) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
  for (const peer of session.peers) { try { peer.destroy(); } catch { /* ignore */ } }
  try { session.tracker?.stop(); session.tracker?.destroy(); } catch { /* ignore */ }
}

ipcRenderer.on('rcast-cmd', (_e, msg: any) => {
  const { type, reqId } = msg;
  try {
    let data: any;
    if (type === 'start') data = startSession(msg.payload);
    else if (type === 'stop') { stopSession(msg.id); data = { ok: true }; }
    else throw new Error('Unknown remote-cast command: ' + type);
    ipcRenderer.send('rcast-res', { reqId, ok: true, data });
  } catch (e: any) {
    ipcRenderer.send('rcast-res', { reqId, ok: false, error: e?.message || String(e) });
  }
});

ipcRenderer.send('rcast-ready');
