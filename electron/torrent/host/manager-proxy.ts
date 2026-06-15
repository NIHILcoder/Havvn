/**
 * TorrentManagerProxy — the main-process stand-in for the TorrentManager that now
 * lives in the torrent-host utilityProcess. `getTorrentManager()` returns this, so
 * the 12 files that call `torrentManager.*` keep working unchanged.
 *
 * - Async methods forward over the port and resolve with the host's result.
 * - The four methods main calls SYNCHRONOUSLY (getStats / getListeningPort /
 *   isAltSpeedEnabled / ffmpegBinary) are served from a small mirror the host
 *   pushes via `state`/`stats` events.
 * - onStats/onComplete subscribers are kept locally and fed by relayed events.
 * - Host db requests are answered here against main's electron-store (single owner).
 */

import path from 'path';
import { utilityProcess, UtilityProcess } from 'electron';
import * as db from '../../db/store';
import { logger } from '../../utils';
import { getHostEnv } from './env';
import { FromHost, DbRequest, EventMsg } from './protocol';
import type { TorrentManager } from '../manager';
import type { CastServer } from '../cast-server';
import type { DownloadStats, CreateTorrentRequest, CreateTorrentResult, CreateTorrentProgress } from '../../../shared/types';

const log = logger.child('TorrentHostProxy');

type TM = TorrentManager;
type Cast = CastServer;
/** Forwarded method return: always a Promise of the (awaited) manager result. */
type Fwd<F extends (...a: never[]) => unknown> = Promise<Awaited<ReturnType<F>>>;

type StatsCb = (stats: DownloadStats[]) => void;
type CompleteCb = (info: { id: string; name: string }) => void;

class TorrentManagerProxy {
  private child: UtilityProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private statsCbs = new Set<StatsCb>();
  private completeCbs = new Set<CompleteCb>();
  private createProgressCbs = new Set<(p: CreateTorrentProgress) => void>();
  // Mirror of host state for the synchronous getters main relies on.
  private lastStats: DownloadStats[] = [];
  private listeningPort = 0;
  private altSpeed = false;
  private ffmpeg: string | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  initialize(): Promise<void> { return this.ensureReady(); }

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((res) => { this.resolveReady = res; });
      this.spawn();
    }
    return this.readyPromise;
  }

  private spawn(): void {
    const modulePath = path.join(__dirname, 'torrent-host.js');
    const child = utilityProcess.fork(modulePath, [], { stdio: 'pipe' });
    this.child = child;
    child.on('spawn', () => { try { child.postMessage({ kind: 'init', env: getHostEnv() }); } catch { /* ignore */ } });
    child.on('message', (m: FromHost) => this.onMessage(m));
    child.stdout?.on('data', (d) => log.info('host', { out: String(d).trim() }));
    child.stderr?.on('data', (d) => log.warn('host', { err: String(d).trim() }));
    child.on('exit', (code) => {
      log.warn('Torrent host exited', { code });
      this.failAll('torrent host stopped');
      this.child = null;
      this.readyPromise = null; // next call re-spawns (crash recovery)
      this.resolveReady = null;
    });
  }

  private failAll(message: string): void {
    for (const [, p] of this.pending) p.reject(new Error(message));
    this.pending.clear();
  }

  private onMessage(msg: FromHost): void {
    switch (msg.kind) {
      case 'ready': this.resolveReady?.(); break;
      case 'rpc-res': {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'host error')); }
        break;
      }
      case 'db': void this.handleDb(msg); break;
      case 'event': this.handleEvent(msg); break;
    }
  }

  private async handleDb(msg: DbRequest): Promise<void> {
    try {
      const fn = (db as unknown as Record<string, (...a: unknown[]) => unknown>)[msg.fn];
      const result = await fn(...msg.args);
      this.child?.postMessage({ kind: 'db-res', id: msg.id, ok: true, result });
    } catch (e) {
      this.child?.postMessage({ kind: 'db-res', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private handleEvent(msg: EventMsg): void {
    if (msg.event === 'stats') {
      this.lastStats = msg.payload as DownloadStats[];
      for (const cb of this.statsCbs) { try { cb(this.lastStats); } catch { /* ignore */ } }
    } else if (msg.event === 'complete') {
      for (const cb of this.completeCbs) { try { cb(msg.payload as { id: string; name: string }); } catch { /* ignore */ } }
    } else if (msg.event === 'state') {
      const s = msg.payload as { ffmpeg: string | null; listeningPort: number; altSpeedEnabled: boolean };
      this.ffmpeg = s.ffmpeg; this.listeningPort = s.listeningPort; this.altSpeed = s.altSpeedEnabled;
    } else if (msg.event === 'create-progress') {
      for (const cb of this.createProgressCbs) { try { cb(msg.payload as CreateTorrentProgress); } catch { /* ignore */ } }
    }
  }

  private async rpc<T>(method: string, args: unknown[]): Promise<T> {
    await this.ensureReady();
    if (!this.child) throw new Error('torrent host not running');
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child!.postMessage({ kind: 'rpc', id, method, args });
    });
  }

  async destroy(): Promise<void> {
    if (this.child) {
      try { await this.rpc('destroy', []); } catch { /* host may be down */ }
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
    this.readyPromise = null; this.resolveReady = null;
  }

  // ── Event subscriptions (local) ──────────────────────────────────────────
  onStats(cb: StatsCb): () => void { this.statsCbs.add(cb); return () => this.statsCbs.delete(cb); }
  onComplete(cb: CompleteCb): () => void { this.completeCbs.add(cb); return () => this.completeCbs.delete(cb); }
  onCreateProgress(cb: (p: CreateTorrentProgress) => void): () => void { this.createProgressCbs.add(cb); return () => this.createProgressCbs.delete(cb); }

  /** Create a .torrent in the host (off the main thread); progress via onCreateProgress. */
  createTorrentFile(request: CreateTorrentRequest): Promise<CreateTorrentResult> {
    return this.rpc('createTorrentFile', [request]);
  }

  // ── Synchronous getters (served from the mirror) ───────────────────────────
  getStats(): DownloadStats[] { return this.lastStats; }
  getListeningPort(): number { return this.listeningPort; }
  isAltSpeedEnabled(): boolean { return this.altSpeed; }
  get ffmpegBinary(): string | null { return this.ffmpeg; }

  // ── Forwarded manager methods (signatures track the real manager) ──────────
  addDownload(...a: Parameters<TM['addDownload']>): Fwd<TM['addDownload']> { return this.rpc('addDownload', a); }
  addSeed(...a: Parameters<TM['addSeed']>): Fwd<TM['addSeed']> { return this.rpc('addSeed', a); }
  addTracker(...a: Parameters<TM['addTracker']>): Fwd<TM['addTracker']> { return this.rpc('addTracker', a); }
  removeTracker(...a: Parameters<TM['removeTracker']>): Fwd<TM['removeTracker']> { return this.rpc('removeTracker', a); }
  getDownloads(...a: Parameters<TM['getDownloads']>): Fwd<TM['getDownloads']> { return this.rpc('getDownloads', a); }
  getFiles(...a: Parameters<TM['getFiles']>): Fwd<TM['getFiles']> { return this.rpc('getFiles', a); }
  getPeers(...a: Parameters<TM['getPeers']>): Fwd<TM['getPeers']> { return this.rpc('getPeers', a); }
  getTrackers(...a: Parameters<TM['getTrackers']>): Fwd<TM['getTrackers']> { return this.rpc('getTrackers', a); }
  getCastFileInfo(...a: Parameters<TM['getCastFileInfo']>): Fwd<TM['getCastFileInfo']> { return this.rpc('getCastFileInfo', a); }
  getStreamUrl(...a: Parameters<TM['getStreamUrl']>): Fwd<TM['getStreamUrl']> { return this.rpc('getStreamUrl', a); }
  getSubtitleTracks(...a: Parameters<TM['getSubtitleTracks']>): Fwd<TM['getSubtitleTracks']> { return this.rpc('getSubtitleTracks', a); }
  getSubtitleVtt(...a: Parameters<TM['getSubtitleVtt']>): Fwd<TM['getSubtitleVtt']> { return this.rpc('getSubtitleVtt', a); }
  getTorrentInfo(...a: Parameters<TM['getTorrentInfo']>): Fwd<TM['getTorrentInfo']> { return this.rpc('getTorrentInfo', a); }
  pauseDownload(...a: Parameters<TM['pauseDownload']>): Fwd<TM['pauseDownload']> { return this.rpc('pauseDownload', a); }
  resumeDownload(...a: Parameters<TM['resumeDownload']>): Fwd<TM['resumeDownload']> { return this.rpc('resumeDownload', a); }
  removeDownload(...a: Parameters<TM['removeDownload']>): Fwd<TM['removeDownload']> { return this.rpc('removeDownload', a); }
  recheckDownload(...a: Parameters<TM['recheckDownload']>): Fwd<TM['recheckDownload']> { return this.rpc('recheckDownload', a); }
  retryDownload(...a: Parameters<TM['retryDownload']>): Fwd<TM['retryDownload']> { return this.rpc('retryDownload', a); }
  stopSeeding(...a: Parameters<TM['stopSeeding']>): Fwd<TM['stopSeeding']> { return this.rpc('stopSeeding', a); }
  pauseAllActive(...a: Parameters<TM['pauseAllActive']>): Fwd<TM['pauseAllActive']> { return this.rpc('pauseAllActive', a); }
  resumeAllPaused(...a: Parameters<TM['resumeAllPaused']>): Fwd<TM['resumeAllPaused']> { return this.rpc('resumeAllPaused', a); }
  setFilePriority(...a: Parameters<TM['setFilePriority']>): Fwd<TM['setFilePriority']> { return this.rpc('setFilePriority', a); }
  setSeedRatioLimit(...a: Parameters<TM['setSeedRatioLimit']>): Fwd<TM['setSeedRatioLimit']> { return this.rpc('setSeedRatioLimit', a); }
  setSeedTimeLimit(...a: Parameters<TM['setSeedTimeLimit']>): Fwd<TM['setSeedTimeLimit']> { return this.rpc('setSeedTimeLimit', a); }
  setSequentialDownload(...a: Parameters<TM['setSequentialDownload']>): Fwd<TM['setSequentialDownload']> { return this.rpc('setSequentialDownload', a); }
  setTorrentSpeedLimits(...a: Parameters<TM['setTorrentSpeedLimits']>): Fwd<TM['setTorrentSpeedLimits']> { return this.rpc('setTorrentSpeedLimits', a); }
  updateSettings(...a: Parameters<TM['updateSettings']>): Fwd<TM['updateSettings']> { return this.rpc('updateSettings', a); }
  applyIpBlocklist(...a: Parameters<TM['applyIpBlocklist']>): Promise<void> { return this.rpc('applyIpBlocklist', a); }

  setAltSpeed(...a: Parameters<TM['setAltSpeed']>): Fwd<TM['setAltSpeed']> {
    if (typeof a[0] === 'boolean') this.altSpeed = a[0]; // optimistic mirror for the tray
    return this.rpc('setAltSpeed', a);
  }

  // ── Cast server (runs in the host; its resolver is synchronous there) ──────
  castPublish(...a: Parameters<Cast['publish']>): Fwd<Cast['publish']> { return this.rpc('castPublish', a); }
  castUnpublish(...a: Parameters<Cast['unpublish']>): Promise<void> { return this.rpc('castUnpublish', a); }
  castTvMedia(...a: Parameters<Cast['tvMedia']>): Fwd<Cast['tvMedia']> { return this.rpc('castTvMedia', a); }
  castPublishDiskFile(...a: Parameters<Cast['publishDiskFile']>): Fwd<Cast['publishDiskFile']> { return this.rpc('castPublishDiskFile', a); }
}

let proxy: TorrentManagerProxy | null = null;
export function getTorrentManager(): TorrentManagerProxy {
  if (!proxy) proxy = new TorrentManagerProxy();
  return proxy;
}
export type { TorrentManagerProxy };
