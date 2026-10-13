/**
 * RemoteCastManager — main-process proxy for "Watch anywhere" (remote streaming
 * over WebRTC). Owns a hidden BrowserWindow whose preload (remote-cast-engine)
 * runs the WebRTC rendezvous + ffmpeg transcode, and hands back a public link
 * (GitHub Pages receiver + a random session id) that plays the stream in any
 * browser, on any network.
 */

import path from 'path';
import { HiddenEngine } from './hidden-engine';
import crypto from 'crypto';
import { logger } from '../utils';
import * as db from '../db/store';
import { getTorrentManager } from '../torrent';

const log = logger.child('RemoteCast');

// Post-rebrand GitHub Pages URL (repo renamed to Havvn) — see share-seeder.ts RECEIVER_BASE.
const RECEIVER_BASE = 'https://nihilcoder.github.io/Havvn/watch/';
import { customTurnToIce, resolveTrackers } from './ice-servers';

export class RemoteCastManager {
  // Re-publishing the same file reuses its live session.
  private active = new Map<string, string>();
  private starts = new Map<string, Promise<{ url: string; sessionId: string }>>();
  private generation = 0;
  private engine = new HiddenEngine('rcast', path.join(__dirname, 'remote-cast-engine.js'),
    () => this.active.clear(), message => log.info('Engine', { msg: message }));

  /** Publish a file for remote viewing; returns the shareable watch link. */
  start(downloadId: string, fileIndex: number): Promise<{ url: string; sessionId: string }> {
    const key = `${downloadId}/${fileIndex}`, existing = this.starts.get(key);
    if (existing) return existing;
    const promise = this.startOnce(downloadId, fileIndex).finally(() => {
      if (this.starts.get(key) === promise) this.starts.delete(key);
    });
    this.starts.set(key, promise); return promise;
  }
  private async startOnce(downloadId: string, fileIndex: number): Promise<{ url: string; sessionId: string }> {
    const generation = this.generation;
    const info = await getTorrentManager().getCastFileInfo(downloadId, fileIndex);
    if (!info) throw new Error('File not available');
    if (info.kind === 'other') throw new Error('This file is not a playable media file');
    const ffmpeg = getTorrentManager().ffmpegBinary;
    if (!ffmpeg) throw new Error('Remote streaming needs the bundled ffmpeg, which is unavailable');

    const key = `${downloadId}/${fileIndex}`;
    let useTurn = true;
    let turnServers: ReturnType<typeof customTurnToIce> = [];
    let trackers = resolveTrackers();
    try {
      const s = await db.getSettings();
      useTurn = s.shareUseTurn !== false;
      turnServers = customTurnToIce(s.customTurnUrl, s.customTurnUsername, s.customTurnCredential);
      trackers = resolveTrackers(s.customTrackers);
    } catch { /* default on, no custom TURN, public trackers */ }

    // Choose the session after asynchronous settings lookup: an idle engine
    // may have been retired while those settings were loading.
    if (generation !== this.generation) throw new Error('Remote streaming was canceled');
    const previousSession = this.active.get(key);
    const sessionId = previousSession ?? crypto.randomBytes(16).toString('hex');
    this.active.set(key, sessionId);
    try {
      await this.engine.call('start', { payload: { id: sessionId, contentPath: info.diskPath, ffmpeg, useTurn, turnServers, trackers } }, 15000);
      if (!this.engine.hasWindow) throw new Error('Remote streaming engine closed');
    } catch (error) {
      if (this.active.get(key) === sessionId) this.active.delete(key);
      if (!previousSession && this.engine.hasWindow) {
        try { await this.engine.call('stop', { id: sessionId }); } catch { /* engine already closed */ }
      }
      throw error;
    }
    const url = RECEIVER_BASE + '#' + sessionId + (useTurn ? '' : '|nt');
    return { url, sessionId };
  }

  async stop(sessionId: string): Promise<{ ok: boolean }> {
    for (const [k, v] of this.active) if (v === sessionId) this.active.delete(k);
    if (this.engine.hasWindow) try { await this.engine.call('stop', { id: sessionId }); } catch { /* engine may be down */ }
    return { ok: true };
  }

  destroy(): void { this.generation++; this.engine.destroy(); this.active.clear(); this.starts.clear(); log.info('RemoteCastManager destroyed'); }
}

let remoteCastManager: RemoteCastManager | null = null;
export function getRemoteCastManager(): RemoteCastManager {
  if (!remoteCastManager) remoteCastManager = new RemoteCastManager();
  return remoteCastManager;
}
