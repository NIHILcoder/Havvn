import WebTorrent, { Torrent } from 'webtorrent';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { getHostEnv } from './host/env';
import { TorrentError } from './errors';
import { ipToNum, ipInRanges } from '../../shared/ip-range';
import { clientFromWire, peerProgress, safeSpeed, normalizeConnType } from './peer-utils';
import {
  Download,
  DownloadStatus,
  DownloadStats,
  SourceType,
  TorrentFile,
  FilePriority,
  TrackerInfo,
  PeerInfo,
  NetworkHealth,
  SwarmGeo,
  SwarmGeoPoint,
} from '../../shared/types';
import {
  isValidTransition,
  InvalidStateTransitionError,
  canPause,
  canResume,
  canRecheck,
  isActiveState,
  isFinished,
} from '../../shared/state-machine';
import * as db from './host/db-bridge';
import { logger, checkDiskSpace, formatBytes } from '../utils';
import { classifyMediaKind, isDirectlyPlayable } from '../../shared/media';
import { extractInfoHashFromMagnet } from '../../shared/magnet';
import { shouldStopSeeding } from '../../shared/seeding-limits';
import { planRestore } from '../../shared/restore-plan';
import { peekCastServer } from './cast-server';
import { spawn, ChildProcess } from 'child_process';
import { AdaptiveThrottle } from './adaptive-throttle';
import { installDohLookup, configureDoh } from './host/doh-lookup';
import { resolveActiveDohUrl, DohTemplate } from '../../shared/types';
import { DEFAULT_TRACKERS } from './trackers';
// Tiny (<300KB) offline IP→country lookup (IP2Location LITE, country-level only).
// Deliberately NOT a city-level DB — keeps the installer lean; the swarm map
// places peers at their country. IPv4-only; IPv6/unknown peers are unresolved.
import ip3country = require('ip3country');

// ffmpeg-static ships a platform binary; in a packaged app it lives in
// app.asar.unpacked (it can't execute from inside the asar archive).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStaticPath = require('ffmpeg-static') as string | null;
function resolveFfmpegPath(): string | null {
  if (!ffmpegStaticPath) return null;
  return getHostEnv().isPackaged
    ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStaticPath;
}

const log = logger.child('TorrentManager');

interface ManagedTorrent {
  id: string;
  torrent: Torrent | null;
  download: Download;
  infoHash: string | null;
  selectedFiles?: number[];
  // True once this torrent has reached WebTorrent's 'ready' event at least once
  // (in this process's lifetime). processQueue() passes isNew=true for every
  // torrent it starts — including resumes — so that flag alone can't tell a
  // genuinely-new add from a resume/recheck re-add; this can. Used to persist
  // totalSize/name to the DB only the first time we actually learn them, so a
  // resume can't re-stamp it from a transient mid-reattach reading.
  everReady?: boolean;
  // Set by recheckDownload when re-verifying an already-FINISHED torrent
  // (seeding/completed). recheck re-adds via the queue, which briefly flips the
  // status to 'downloading', so the immediate 'done' on re-verify would otherwise
  // masquerade as a fresh completion — re-firing the "download complete"
  // notification and resetting the seed-time clock. This remembers the status to
  // restore silently instead. Cleared as soon as it's consumed by 'done'.
  recheckReturnStatus?: DownloadStatus | null;
  // WebTorrent's torrent.downloaded/uploaded count only the CURRENT session and
  // reset to 0 every time the torrent instance is recreated (pause/resume/
  // recheck/auto-move/restart). To keep lifetime totals — and a stable share
  // ratio — we snapshot the persisted totals when a live instance is attached
  // and report baseline + live session bytes.
  sessionBaseDownloaded?: number;
  sessionBaseUploaded?: number;
  // Per-tracker scrape data (seeders/leechers + last-announce time), captured
  // from the tracker client's 'update'/'scrape' events and keyed by announce
  // URL. WebTorrent exposes no per-tracker peer counts otherwise.
  trackerStats?: Map<string, { complete: number; incomplete: number; lastAnnounce: number }>;
  // The tracker client we've attached listeners to. Torrents are recreated on
  // pause/resume, so we re-hook when the client instance changes.
  trackerHookedClient?: unknown;
  // Lazily-created per-torrent HTTP server used for in-app streaming. Bound to
  // the specific torrent instance it was created for (torrents are recreated on
  // pause/resume), so we can tell when it has gone stale.
  streamServer?: { server: any; port: number; torrent: Torrent } | null;
  // Active "instant-play" head prioritization for the file currently being
  // streamed: a high-priority piece selection over the head of the file. Undone
  // in closeStreamServer() so a normal (non-streaming) download reverts to its
  // rarest-first, swarm-healthy picking.
  streamHead?: { fileIndex: number; startPiece: number; endPiece: number } | null;
  // True while streaming has forced a sequential strategy on this torrent, so
  // closeStreamServer() knows to revert to the user's persisted setting.
  streamStrategyOverridden?: boolean;
}

// Instant-play streaming ("zero-wait"): how much of the head of a file to fetch
// at high priority so playback starts immediately, and the selection priority to
// use. The priority must beat WebTorrent's own FileStream range priority (1) and
// the default whole-torrent/whole-file selections (0) so the watched head wins.
const STREAM_HEAD_BYTES = 16 * 1024 * 1024;
const STREAM_HEAD_PRIORITY = 10;

// Per-file download priorities mapped to webtorrent selection priorities. All are
// >0 so the file still downloads (the default whole-torrent selection is 0), and
// the picker fetches higher-priority files first (it sorts _selections desc).
// Kept below STREAM_HEAD_PRIORITY so an actively-streamed head still wins.
const FILE_PRIORITY_LOW = 1;
const FILE_PRIORITY_NORMAL = 3;
const FILE_PRIORITY_HIGH = 6;

// True for IPv4 addresses that must never be geo-located: private (RFC1918),
// loopback, link-local, CGNAT (100.64/10), and 0.0.0.0/8. Keeps LAN/relay peers
// off the world map instead of mislocating them.
function isPrivateOrReservedIPv4(addr: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m) return true; // not a dotted-quad → don't try to locate it
  const a = +m[1], b = +m[2];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;      // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

type StatsCallback = (stats: DownloadStats[]) => void;
type CompletionCallback = (info: { id: string; name: string }) => void;


/**
 * TorrentManager wraps WebTorrent and provides:
 * - Strict state machine for status transitions
 * - Duplicate detection via infoHash
 * - Add/pause/resume/remove functionality
 * - Concurrency limiting (max active downloads)
 * - Periodic stats broadcasting
 * - Persistence integration
 * - Comprehensive logging
 */
export class TorrentManager {
  // Created in initialize() so client options (DHT, max connections, listening
  // port, speed limits) can come from the persisted settings.
  private client!: WebTorrent.Instance;
  private managedTorrents: Map<string, ManagedTorrent> = new Map();
  private infoHashIndex: Map<string, string> = new Map();
  // Creation options for "start seeding" entries, used the first time they seed
  // so the infoHash matches the .torrent the user just created.
  private seedOptionsCache: Map<string, { announceList?: string[][]; pieceLength?: number }> = new Map();
  // Shared on-the-fly transcoding server (ffmpeg → fragmented MP4) for formats
  // Chromium can't play directly (avi, mkv, HEVC, …). Started lazily.
  private transcodeServer: http.Server | null = null;
  private transcodePort = 0;
  // In-flight ensureTranscodeServer() promise. Memoized so two concurrent first
  // stream requests don't each bind their own server and leak all but the last.
  private transcodeServerPromise: Promise<number> | null = null;
  private activeTranscodes: Set<ChildProcess> = new Set();
  private readonly ffmpegPath: string | null = resolveFfmpegPath();
    private addingTorrents: Set<string> = new Set();
  private statsInterval: NodeJS.Timeout | null = null;
  // Stats are broadcast to the UI every tick, but persisted to disk only every
  // PERSIST_INTERVAL_MS to avoid serializing the whole store many times a second.
  private lastPersistAt = 0;
  private static readonly PERSIST_INTERVAL_MS = 5000;
  // How long to wait for torrent metadata (magnet with no peers) before
  // failing the add instead of hanging forever.
  private static readonly METADATA_TIMEOUT_MS = 120_000;
  private statsCallbacks: Set<StatsCallback> = new Set();
  private completionCallbacks: Set<CompletionCallback> = new Set();
  // Fired when the WebTorrent TCP pool actually binds its listening port, so the
  // host can re-push the real port to main's mirror (see onListening).
  private listeningCallbacks: Set<() => void> = new Set();
  private maxActiveDownloads = 3;
  private maxDownKbps = 0;
  private maxUpKbps = 0;
  // Connection limits. maxConnections is the per-torrent ceiling; maxConnectionsGlobal
  // is the total budget across all live torrents. The effective per-torrent limit
  // (client.maxConns, read live by WebTorrent on every connect) is scaled down as
  // more torrents run so the total never exceeds the global budget.
  // Per-torrent ceiling raised 55→100: a SINGLE active torrent was capped at 55
  // peers, low for big swarms. Safe to raise now because the slow-start ramp +
  // adaptive throttle (below) keep the router protected regardless, and the
  // global budget still bounds the multi-torrent total.
  private maxConnections = 100;
  private maxConnectionsGlobal = 300;
  private static readonly MIN_CONNS_PER_TORRENT = 20;
  // Connection slow-start: after the client comes up we ramp the per-torrent
  // connection ceiling from a low floor to its full value over RAMP_DURATION_MS,
  // instead of opening a burst of sockets the instant torrents go live. That
  // burst is what floods a cheap router's NAT table on startup (the classic
  // "torrents kill my whole internet for the first minute"). 0 = ramp finished.
  private connRampStartAt = 0;
  private static readonly RAMP_START_CONNS = 20;
  private static readonly RAMP_DURATION_MS = 45_000;
  // Adaptive upload throttle (bufferbloat protection). Opt-in. When enabled it
  // watches WAN latency and dynamically lowers the upload ceiling so seeding
  // never strangles the rest of the connection. adaptiveUpBytes is its current
  // ceiling (-1 = no adaptive cap); it's merged with the manual limit, most
  // restrictive winning, in currentUpBytes().
  private adaptiveUploadEnabled = false;
  private adaptiveUpBytes = -1;
  private adaptive: AdaptiveThrottle | null = null;
  // DNS-over-HTTPS: resolve tracker/peer hostnames through an encrypted resolver
  // instead of the OS/router DNS. State mirrors the relevant settings so live
  // changes (toggle / template / custom list) can be re-applied without restart.
  private dohEnabled = false;
  private dohTemplateId = 'cloudflare';
  private dohCustomTemplates: DohTemplate[] = [];
  // IP blocklist filtering runs here (where the WebTorrent client lives). Main
  // ships the merged, sorted ranges via applyIpBlocklist(); wires are hooked once.
  private blockedRanges: Array<[number, number]> = [];
  private blocklistHooked = false;
  // Whether the offline country DB (ip3country) has been initialized. Lazy so a
  // user who never opens the swarm map never pays its init cost.
  private geoReady = false;
  // Alternative ("turbo"/turtle) speed limits and whether they're active.
  private altSpeedEnabled = false;
  private altDownKbps = 0;
  private altUpKbps = 0;
  // Auto-move completed downloads to this folder, then re-seed from there.
  private autoMoveEnabled = false;
  private autoMovePath = '';
  // Guards re-entrant auto-move while a torrent is being relocated.
  private movingIds: Set<string> = new Set();
  // Resolves when an in-flight auto-move for this id finishes. remove/stopSeeding/
  // recheck await this so they never act on the stale savePath mid-move (which
  // would delete the already-emptied source and orphan the moved copy).
  private movingPromises: Map<string, Promise<void>> = new Map();
  // The TCP port the engine listens on for incoming peers (from settings.portMin;
  // 0 = OS-chosen). Used by the UPnP port-forwarding service.
  private configuredPort = 0;
  private defaultSeedRatioLimit = 0;
  private defaultSeedTimeLimitMinutes = 0;
  
  // Resolves once initialize() has restored all torrents. Public mutators
  // await this so the window can be created (and the UI used) while the
  // potentially slow restore/verification still runs in the background.
  private initDone: Promise<void>;
  private resolveInitDone!: () => void;

  constructor() {
    this.initDone = new Promise<void>((res) => { this.resolveInitDone = res; });
    log.debug('TorrentManager instance created');
  }

  /** Wait until initialize() has finished (no-op afterwards). */
  private whenReady(): Promise<void> {
    return this.initDone;
  }

  /**
   * Generate a BitTorrent peer ID in Azureus-style format: -TH1810-<random>.
   * Version digits are derived from package.json so they never go stale.
   * 20 bytes total, no machine-identifying data; rotates every launch.
   */
  private generateEphemeralPeerId(): Buffer {
    const digits = getHostEnv().version.replace(/\D/g, '').padEnd(4, '0').slice(0, 4);
    const prefix = `-TH${digits}-`;
    const random = crypto.randomBytes(20 - prefix.length).toString('hex').slice(0, 20 - prefix.length);
    return Buffer.from(prefix + random);
  }

  /**
   * Initialize the manager - restore state from database
   */
  async initialize(): Promise<void> {
    log.info('Initializing TorrentManager');

    // Load settings
    const settings = await db.getSettings();
    this.maxActiveDownloads = settings.maxActiveDownloads;
    this.maxDownKbps = settings.maxDownKbps;
    this.maxUpKbps = settings.maxUpKbps;
    this.altSpeedEnabled = settings.altSpeedEnabled ?? false;
    this.altDownKbps = settings.altDownKbps ?? 0;
    this.altUpKbps = settings.altUpKbps ?? 0;
    this.autoMoveEnabled = settings.autoMoveEnabled ?? false;
    this.autoMovePath = settings.autoMovePath ?? '';
    this.defaultSeedRatioLimit = settings.defaultSeedRatioLimit ?? 0;
    this.defaultSeedTimeLimitMinutes = settings.defaultSeedTimeLimitMinutes ?? 0;
    this.maxConnections = settings.maxConnections > 0 ? settings.maxConnections : 100;
    this.maxConnectionsGlobal = settings.maxConnectionsGlobal > 0 ? settings.maxConnectionsGlobal : 300;
    this.adaptiveUploadEnabled = settings.adaptiveUpload === true;
    this.dohEnabled = settings.dohEnabled === true;
    this.dohTemplateId = settings.dohTemplateId || 'cloudflare';
    this.dohCustomTemplates = Array.isArray(settings.dohCustomTemplates) ? settings.dohCustomTemplates : [];
    // Install the DoH-aware dns.lookup once and apply the current config. The
    // patch is a transparent passthrough while disabled, so this is safe even
    // when the user hasn't opted in.
    installDohLookup();
    this.applyDohConfig();

    log.debug('Settings loaded', {
      maxActiveDownloads: this.maxActiveDownloads,
      maxDownKbps: this.maxDownKbps,
      maxUpKbps: this.maxUpKbps,
    });

    // Use an ephemeral, non-identifying BitTorrent peer ID. It carries the
    // TorrentHunt client prefix (-TH<version>-) followed by random bytes that
    // rotate every launch, so peers can't correlate sessions long-term.
    //
    // µTP transport reaches µTP-only peers that TCP misses, but the native
    // utp-native module historically threw uncaught WSAENOBUFS on Windows under
    // load. It's now an EXPERIMENTAL opt-in (Settings → Advanced), default OFF on
    // Windows and ON elsewhere, and the engine runs in an auto-restarting utility
    // process so a transient native crash is recovered, not fatal to the app.
    //
    // dht / maxConns / torrentPort / download+uploadLimit come from Settings →
    // Advanced. (PEX can't be toggled in WebTorrent; LSD isn't implemented.)
    // µTP only engages if the optional native module is actually installed —
    // otherwise stay TCP-only instead of risking a load error.
    let enableUtp = settings.enableUtp ?? (process.platform !== 'win32');
    if (enableUtp) {
      try { require.resolve('utp-native'); }
      catch { enableUtp = false; log.warn('µTP requested but utp-native is not installed — staying TCP-only'); }
    }
    log.info('Transport', { utp: enableUtp });
    this.configuredPort = settings.portMin > 0 ? settings.portMin : 0;
    this.client = new WebTorrent({
      peerId: this.generateEphemeralPeerId(),
      utp: enableUtp,
      dht: settings.enableDHT !== false,
      // Start at the per-torrent ceiling; applyConnectionLimit() scales it down
      // live as more torrents go active (WebTorrent reads client.maxConns on every
      // connection attempt, so changing it throttles all torrents immediately).
      maxConns: this.maxConnections,
      torrentPort: this.configuredPort,
      // -1 = unlimited (0 would mean "0 bytes/sec" and stall all traffic).
      // Effective limits honour the alternative-speed toggle + adaptive throttle.
      downloadLimit: this.currentDownBytes(),
      uploadLimit: this.currentUpBytes(),
    } as any);

    this.client.on('error', (err: string | Error) => {
      log.error('WebTorrent client error', { error: err });
    });

    // The TCP pool binds asynchronously — client.torrentPort is only real once
    // 'listening' fires, which is typically AFTER initialize() resolves. Notify
    // listeners then so the main-process mirror (and UPnP port-forwarding) picks
    // up the actual OS-assigned port instead of a stale 0 / configuredPort.
    (this.client as unknown as NodeJS.EventEmitter).on('listening', () => {
      log.info('WebTorrent listening', { port: this.getListeningPort() });
      for (const cb of this.listeningCallbacks) { try { cb(); } catch { /* ignore */ } }
    });

    // Begin connection slow-start immediately, before any torrent is restored,
    // so the very first wave of peer connections is rate-limited too.
    this.connRampStartAt = Date.now();
    this.applyConnectionLimit();

    // Bring up the adaptive upload throttle if the user opted in.
    if (this.adaptiveUploadEnabled) this.startAdaptiveThrottle();

    // Load all downloads; permanently purge any stale 'removed' records left by older
    // app versions that used markAsRemoved instead of deleteDownload. This prevents
    // deleted torrents from resurrecting on the next launch.
    const allDownloads = await db.getAllDownloads();
    const activeDownloads: typeof allDownloads = [];
    for (const d of allDownloads) {
      if (d.status === 'removed') {
        try { await db.deleteDownload(d.id); } catch (_) { /* ignore */ }
        log.debug('Purged stale removed record', { id: d.id });
      } else {
        activeDownloads.push(d);
      }
    }

    log.info(`Restoring ${activeDownloads.length} downloads from database`);

    // Populate the managed map synchronously first so getDownloads()/getStats()
    // see every torrent immediately.
    for (const download of activeDownloads) {
      this.managedTorrents.set(download.id, {
        id: download.id,
        torrent: null,
        download,
        infoHash: null,
        selectedFiles: download.selectedFiles,
      });
    }

    // Decide which torrents to bring live now, honouring maxActiveDownloads.
    // Only 'downloading' counts against the limit (see ACTIVE_STATES); seeding
    // torrents always resume since they don't occupy a download slot. Without
    // this cap, EVERY restored torrent was added to WebTorrent at once, so all
    // of them hash-checked their on-disk data and read/wrote pieces at the same
    // time — the source of the startup disk thrash and UI lag. Downloads beyond
    // the limit are re-queued so processQueue() starts them as slots free, just
    // like a freshly-added download.
    // Partitioning extracted to shared/restore-plan (pure + unit-tested).
    const { live: toRestore, requeue } = planRestore(activeDownloads, this.maxActiveDownloads);
    for (const download of requeue) {
      // Exceeds the active-download limit — defer to the queue rather than
      // starting it live now and overloading the disk.
      await this.transitionStatus(download.id, 'queued').catch((err) => {
        log.warn('Failed to re-queue download during restore', { id: download.id, error: String(err) });
      });
    }

    // Re-add the chosen torrents in parallel. Doing this serially meant a single
    // magnet with no peers blocked the whole restore for up to METADATA_TIMEOUT_MS
    // (and N dead magnets blocked it N×). restoreTorrent never rejects (it logs
    // and transitions to 'error' on its own), so allSettled bounds the wait to
    // the single slowest torrent instead of their sum.
    await Promise.allSettled(toRestore.map((download) => this.restoreTorrent(download)));

    // Start stats broadcasting
    this.startStatsBroadcast();

    // Process queue
    await this.processQueue();

    // Balance the connection budget across whatever restored live.
    this.applyConnectionLimit();

    this.resolveInitDone();
    log.info('TorrentManager initialized successfully');
  }
  
  /**
   * Restore a torrent from saved state
   */
  private async restoreTorrent(download: Download): Promise<void> {
    log.debug('Restoring torrent', { id: download.id, name: download.name });

    try {
      let source: string;
      
      if (download.sourceType === 'torrent_file' && download.torrentFilePath) {
        if (fs.existsSync(download.torrentFilePath)) {
          source = download.torrentFilePath;
        } else {
          throw new TorrentError('Torrent file not found', 'FILE_NOT_FOUND', download.id);
        }
      } else {
        source = download.sourceUri;
      }
      
      await this.addTorrentInternal(download.id, source, download.savePath, false, download.selectedFiles);
      log.debug('Torrent restored successfully', { id: download.id });
    } catch (error) {
      log.error('Failed to restore torrent', {
        id: download.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.transitionStatus(
        download.id,
        'error',
        error instanceof Error ? error.message : 'Failed to restore'
      );
    }
  }
  
  /**
   * Transition a download to a new status with validation
   */
  private async transitionStatus(
    id: string,
    newStatus: DownloadStatus,
    errorMessage?: string
  ): Promise<void> {
    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }

    const currentStatus = managed.download.status;
    
    if (!isValidTransition(currentStatus, newStatus)) {
      const error = new InvalidStateTransitionError(currentStatus, newStatus, id);
      log.warn('Invalid state transition attempted', {
        id,
        from: currentStatus,
        to: newStatus,
      });
      throw error;
    }

    log.debug('Status transition', { id, from: currentStatus, to: newStatus });
    
    await db.updateDownloadStatus(id, newStatus, errorMessage);
    // Update local state immediately so stats broadcast reflects new status
    managed.download.status = newStatus;
    if (errorMessage) {
      managed.download.lastError = errorMessage;
    } else if (newStatus !== 'error') {
      // Clear error message when transitioning out of error state
      managed.download.lastError = null;
    }
    // The set of live torrents may have changed — rebalance the connection budget.
    this.applyConnectionLimit();
  }

  /**
   * Check for duplicate torrent by infoHash
   */
  private getDuplicateByInfoHash(infoHash: string, excludeId?: string): string | null {
    const existingId = this.infoHashIndex.get(infoHash);
    if (existingId && existingId !== excludeId) {
      const existing = this.managedTorrents.get(existingId);
      if (existing && existing.download.status !== 'removed') {
        return existingId;
      }
    }
    return null;
  }

  /**
   * Find an existing (non-removed) download holding this infoHash. Checks the
   * live index first, then scans all records — INCLUDING magnet records whose
   * torrent never reached 'ready' (their hash lives only in the source URI;
   * after a restart such stuck/failed rows are absent from infoHashIndex,
   * which used to let the very same torrent be added a second time).
   */
  private findDuplicateDownload(infoHash: string): string | null {
    const hash = infoHash.toLowerCase();
    const indexed = this.getDuplicateByInfoHash(hash) || this.getDuplicateByInfoHash(infoHash);
    if (indexed) return indexed;
    for (const [existingId, managed] of this.managedTorrents.entries()) {
      if (managed.download.status === 'removed') continue;
      let candidate = managed.infoHash;
      if (!candidate && managed.download.sourceType === 'magnet') {
        candidate = extractInfoHashFromMagnet(managed.download.sourceUri);
      }
      if (candidate && candidate.toLowerCase() === hash) return existingId;
    }
    return null;
  }

  /** Copy a .torrent (local path or fetched temp) into app data so restarts survive the source file moving. */
  private copyTorrentIntoAppData(localTorrentPath: string): string {
    const appDataDir = path.join(getHostEnv().userDataDir, 'torrents');
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }
    const dest = path.join(appDataDir, `${Date.now()}_${path.basename(localTorrentPath)}`);
    fs.copyFileSync(localTorrentPath, dest);
    return dest;
  }

  /**
   * Extract infoHash from a magnet URI, normalized to lowercase hex.
   * Magnets may carry the hash as 40-char hex OR 32-char base32 — WebTorrent
   * normalizes to hex internally, so we must too or duplicate detection misses.
   */
  /**
   * Parse torrent file to extract infoHash without adding to WebTorrent
   * Uses parse-torrent library (version 11 - CommonJS)
   */
  private async extractInfoHashFromFile(filePath: string): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const parseTorrent = require('parse-torrent');
      const buffer = fs.readFileSync(filePath);
      const parsed = await parseTorrent(buffer);
      
      if (parsed && parsed.infoHash) {
        log.debug('Successfully extracted infoHash from torrent file', { filePath, hash: parsed.infoHash });
        return parsed.infoHash.toLowerCase();
      }
      
      log.warn('No infoHash in parsed torrent', { filePath });
      return null;
    } catch (err) {
      log.warn('Failed to parse torrent file for infoHash', { filePath, error: err });
      return null;
    }
  }

  /**
   * Get torrent file list before adding (for selective file download)
   */
  async getTorrentInfo(params: {
    torrentPath?: string;
    magnetUri?: string;
  }): Promise<{
    name: string;
    files: { path: string; size: number; index: number }[];
    totalSize: number;
  }> {
    log.info('Getting torrent info', params);

    return new Promise((resolve, reject) => {
      const tempClient = new WebTorrent({ utp: false } as any);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          tempClient.destroy();
          reject(new TorrentError('Timeout loading torrent information', 'TIMEOUT'));
        }
      }, 30000); // 30 second timeout

      try {
        const sourceUri = params.torrentPath || params.magnetUri;
        if (!sourceUri) {
          reject(new TorrentError('No torrent path or magnet URI provided', 'INVALID_INPUT'));
          return;
        }

        let sourceInput: string | Buffer = sourceUri;
        if (params.torrentPath && fs.existsSync(params.torrentPath)) {
          sourceInput = fs.readFileSync(params.torrentPath);
        }

        tempClient.add(sourceInput, { path: getHostEnv().tempDir }, (torrent) => {
          if (resolved) return;
          
          clearTimeout(timeout);
          resolved = true;

          const files = torrent.files.map((file, index) => ({
            path: file.path,
            size: file.length,
            index,
          }));

          const totalSize = files.reduce((sum, f) => sum + f.size, 0);

          const result = {
            name: torrent.name,
            files,
            totalSize,
          };

          log.info('Torrent info loaded', { 
            name: result.name, 
            fileCount: files.length,
            totalSize: formatBytes(totalSize)
          });

          // Cleanup
          tempClient.remove(torrent.infoHash, { destroyStore: true }, () => {
            tempClient.destroy();
          });

          resolve(result);
        });

        tempClient.on('error', (err) => {
          if (resolved) return;
          
          clearTimeout(timeout);
          resolved = true;
          tempClient.destroy();
          
          log.error('Error loading torrent info', { error: err });
          reject(new TorrentError(
            `Failed to load torrent: ${err instanceof Error ? err.message : String(err)}`,
            'LOAD_ERROR'
          ));
        });
      } catch (err) {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          tempClient.destroy();
          reject(err);
        }
      }
    });
  }

  /**
   * Add a new download with duplicate prevention
   */
  /**
   * Download a remote .torrent file to a temp path so the rest of the add flow
   * (infoHash extraction, copy into app data) can treat it like a local file.
   * Reads the body as binary and follows redirects (archive.org/download/...
   * redirects to a CDN host). Used for search/RSS results that expose an HTTP
   * .torrent URL rather than a magnet link.
   */
  private downloadTorrentToTemp(url: string): Promise<string> {
    // .torrent files are tiny (KBs); anything past this is not a torrent file
    // and would only balloon memory since the body is buffered in full.
    const MAX_TORRENT_BYTES = 10 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const get = (current: string, redirects: number): void => {
        if (redirects > 5) {
          reject(new Error('Too many redirects fetching .torrent'));
          return;
        }
        const parsed = new URL(current);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(current, {
          headers: { 'User-Agent': `TorrentHunt/${getHostEnv().version}`, 'Accept': 'application/x-bittorrent, */*' },
          timeout: 30000,
        }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, current).toString(), redirects + 1);
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} fetching .torrent file`));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (c: Buffer) => {
            received += c.length;
            if (received > MAX_TORRENT_BYTES) {
              res.destroy();
              reject(new Error('Downloaded file is too large to be a .torrent'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            try {
              const buf = Buffer.concat(chunks);
              // Bencoded .torrent files start with 'd' (a dictionary)
              if (buf.length === 0 || buf[0] !== 0x64) {
                reject(new Error('Downloaded file is not a valid .torrent'));
                return;
              }
              let base = path.basename(parsed.pathname) || 'download.torrent';
              if (!base.toLowerCase().endsWith('.torrent')) base += '.torrent';
              const file = path.join(os.tmpdir(), `th_${Date.now()}_${base}`);
              fs.writeFileSync(file, buf);
              resolve(file);
            } catch (e) {
              reject(e);
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout fetching .torrent file')); });
      };
      get(url, 0);
    });
  }

  async addDownload(params: {
    sourceType: SourceType;
    sourceUri: string;
    savePath?: string;
    name?: string;
    selectedFiles?: number[];
  }): Promise<Download> {
    await this.whenReady();
    log.info('Adding new download', { sourceType: params.sourceType, name: params.name });

    // For torrent files given as an HTTP(S) URL (search/RSS results), fetch the
    // .torrent to a temp file first so the rest of the flow can read it locally.
    let localTorrentPath = params.sourceUri;
    let tempTorrentToCleanup: string | null = null;
    if (params.sourceType === 'torrent_file' && /^https?:\/\//i.test(params.sourceUri)) {
      localTorrentPath = await this.downloadTorrentToTemp(params.sourceUri);
      tempTorrentToCleanup = localTorrentPath;
      log.debug('Fetched remote .torrent to temp', { url: params.sourceUri, temp: localTorrentPath });
    }

    // 1. Extract infoHash early to check for duplicates BEFORE adding
    let infoHashToCheck: string | null = null;

    if (params.sourceType === 'magnet') {
      infoHashToCheck = extractInfoHashFromMagnet(params.sourceUri);
      log.debug('Extracted infoHash from magnet', { infoHash: infoHashToCheck });
    } else if (params.sourceType === 'torrent_file') {
      infoHashToCheck = await this.extractInfoHashFromFile(localTorrentPath);
      log.debug('Extracted infoHash from torrent file', { infoHash: infoHashToCheck, filePath: localTorrentPath });
    }
    
    log.info('Checking for duplicates', { 
      infoHashToCheck, 
      indexSize: this.infoHashIndex.size,
      managedCount: this.managedTorrents.size 
    });

    // 2. Check for duplicates by infoHash - check BOTH index and all managed torrents
    if (infoHashToCheck) {
      // Check if already being added (race condition protection)
      if (this.addingTorrents.has(infoHashToCheck)) {
        const errorMessage = 'This torrent is already being added, please wait';
        log.warn('Duplicate torrent rejected (currently being added)', {
          infoHash: infoHashToCheck
        });
        throw new TorrentError(errorMessage, 'DUPLICATE');
      }

      // Mark as being added
      this.addingTorrents.add(infoHashToCheck);
      log.debug('Marked torrent as being added', { infoHash: infoHashToCheck });
    }

    try {
      // Continue with duplicate checks
      if (infoHashToCheck) {
        const dupId = this.findDuplicateDownload(infoHashToCheck);
        if (dupId) {
          const existing = this.managedTorrents.get(dupId)!;
          if (existing.download.status === 'error') {
            // Re-adding something that previously FAILED (typically a magnet
            // whose metadata timed out, leaving a stuck "Loading..." row).
            // Creating a second record here used to be possible — failed magnet
            // rows aren't in infoHashIndex after a restart — and two records
            // over one torrent meant removing one visually killed both. Retry
            // the existing record instead of duplicating it.
            log.info('Re-add of a failed download — retrying existing record', {
              existingId: dupId,
              infoHash: infoHashToCheck,
            });
            if (params.selectedFiles && params.selectedFiles.length > 0) {
              existing.selectedFiles = params.selectedFiles;
              existing.download.selectedFiles = params.selectedFiles;
              await db.updateDownloadField(dupId, 'selectedFiles', params.selectedFiles);
            }
            // A .torrent source is strictly better than a magnet (instant
            // metadata) — upgrade the record's source if we were handed one.
            if (params.sourceType === 'torrent_file') {
              const upgradedPath = this.copyTorrentIntoAppData(localTorrentPath);
              existing.download.sourceType = 'torrent_file';
              existing.download.sourceUri = params.sourceUri;
              existing.download.torrentFilePath = upgradedPath;
              await db.updateDownloadField(dupId, 'sourceType', 'torrent_file');
              await db.updateDownloadField(dupId, 'sourceUri', params.sourceUri);
              await db.updateDownloadField(dupId, 'torrentFilePath', upgradedPath);
            }
            await this.transitionStatus(dupId, 'queued');
            this.processQueue().catch((e) => log.error('Queue processing after retry-add failed', { error: String(e) }));
            return existing.download;
          }
          const errorMessage = `This torrent is already in downloads: "${existing.download.name}"`;
          log.warn('Duplicate torrent rejected', {
            infoHash: infoHashToCheck,
            existingId: dupId,
            existingName: existing.download.name,
          });
          throw new TorrentError(errorMessage, 'DUPLICATE');
        }
      }

      // 3. Fallback: check by source URI (for cases where infoHash couldn't be extracted)
      for (const [existingId, managed] of this.managedTorrents.entries()) {
        if (managed.download.status === 'removed') continue;

        if (params.sourceType === 'magnet' && managed.download.sourceType === 'magnet') {
          if (managed.download.sourceUri === params.sourceUri) {
            const errorMessage = `This torrent is already in downloads: "${managed.download.name}"`;
            log.warn('Duplicate torrent rejected (by magnet URI)', {
              existingId,
              existingName: managed.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }
      }

      // Note: we intentionally do NOT reject by display name. Two genuinely
      // different torrents can share a name (different releases/repacks), and
      // the infoHash checks above already catch true duplicates of the same
      // content — which is the only thing that would actually collide on disk.

      // Engine-level guard: the WebTorrent client may still hold this infoHash
      // even when our managed map doesn't (e.g. a soft-'removed' download whose
      // torrent wasn't destroyed, or a map/engine desync). Re-adding it makes
      // WebTorrent throw "Cannot add duplicate torrent" — which previously leaked
      // to the UI as a raw "downloads:add" error. Catch it here with a clear one.
      if (infoHashToCheck && this.client.get(infoHashToCheck)) {
        log.warn('Duplicate torrent rejected (already present in the engine)', { infoHash: infoHashToCheck });
        throw new TorrentError('This torrent is already in your downloads.', 'DUPLICATE');
      }

      const settings = await db.getSettings();
      const savePath = params.savePath || settings.defaultDownloadDir;

      // Ensure save directory exists
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      // Check available disk space
      const availableSpace = await checkDiskSpace(savePath);
      let minimumRequired = 100 * 1024 * 1024; // 100 MB floor

      // When the payload size is known up front (a .torrent file), require space
      // for the actual content — not just a fixed floor. Otherwise a 50 GB torrent
      // starts happily on a 500 MB drive and only errors out mid-write. Magnets
      // have no metadata yet, so they keep the floor. Best-effort: any parse
      // failure falls back to the floor rather than blocking the add.
      if (params.sourceType === 'torrent_file' && fs.existsSync(localTorrentPath)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const parseTorrent = require('parse-torrent');
          const parsed = await parseTorrent(fs.readFileSync(localTorrentPath));
          const files: Array<{ length: number }> = parsed.files || [];
          let payload = 0;
          if (params.selectedFiles && params.selectedFiles.length > 0 && files.length > 0) {
            for (const idx of params.selectedFiles) payload += files[idx]?.length || 0;
          } else {
            payload = parsed.length || files.reduce((s, f) => s + (f.length || 0), 0);
          }
          if (payload > minimumRequired) minimumRequired = payload;
        } catch (e) {
          log.debug('Could not determine torrent size for disk-space check', { error: String(e) });
        }
      }

      if (availableSpace !== null && availableSpace < minimumRequired) {
        const errorMessage = `Not enough disk space. Available: ${formatBytes(availableSpace)}, required: ${formatBytes(minimumRequired)}`;
        log.error('Insufficient disk space', {
          savePath,
          available: availableSpace,
          required: minimumRequired,
          formatted: formatBytes(availableSpace)
        });
        throw new TorrentError(errorMessage, 'NO_SPACE');
      }

      if (availableSpace !== null) {
        log.info('Disk space check passed', {
          savePath,
          available: formatBytes(availableSpace)
        });
      } else {
        log.warn('Could not verify disk space', { savePath });
      }

      let torrentFilePath: string | undefined;
      const sourceUri = params.sourceUri;

      // If it's a torrent file, copy it (local path or freshly-fetched temp) to app data
      if (params.sourceType === 'torrent_file') {
        torrentFilePath = this.copyTorrentIntoAppData(localTorrentPath);
        log.debug('Torrent file copied', { from: localTorrentPath, to: torrentFilePath });
      }

      // Create database record
      const download = await db.createDownload({
        name: params.name || 'Loading...',
        sourceType: params.sourceType,
        sourceUri,
        torrentFilePath,
        savePath,
        status: 'queued',
        selectedFiles: params.selectedFiles,
      });

      log.info('Download record created', { id: download.id });

      // Add to managed torrents
      this.managedTorrents.set(download.id, {
        id: download.id,
        torrent: null,
        download,
        infoHash: infoHashToCheck,
        selectedFiles: params.selectedFiles,
      });

      // Register infoHash immediately to prevent race conditions with duplicate detection
      if (infoHashToCheck) {
        this.infoHashIndex.set(infoHashToCheck, download.id);
        log.debug('InfoHash registered early', { id: download.id, infoHash: infoHashToCheck });
      }

      // Kick the queue but do NOT await it: for magnets, processQueue waits on
      // metadata (up to 120s), and awaiting here kept the renderer's add dialog
      // frozen for the whole fetch — users clicked "Download" again, hit the
      // duplicate guard, and got a confusing "already being added" error. The
      // record exists and is visible; metadata resolves in the background and
      // failures land on the row itself (status 'error' + message).
      this.processQueue().catch((e) => log.error('Queue processing after add failed', { error: String(e) }));

      return download;
    } finally {
      // Always clean up the adding marker, even if an error occurred
      if (infoHashToCheck) {
        this.addingTorrents.delete(infoHashToCheck);
        log.debug('Removed torrent from adding set', { infoHash: infoHashToCheck });
      }
      // Remove the temp .torrent we fetched (it's been copied into app data)
      if (tempTorrentToCleanup) {
        try {
          fs.unlinkSync(tempTorrentToCleanup);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  /**
   * Add a "start seeding" entry for a freshly-created torrent. Seeds the actual
   * source files from disk (client.seed) so a custom torrent name can't break
   * the content mapping (which would leave it stuck at 0%).
   */
  async addSeed(params: {
    sourcePaths: string[];
    name?: string;
    announceList?: string[][];
    pieceLength?: number;
    torrentFilePath?: string;
  }): Promise<Download> {
    await this.whenReady();
    const sourceFolder = path.dirname(params.sourcePaths[0]);
    const download = await db.createDownload({
      name: params.name || path.basename(params.sourcePaths[0]),
      sourceType: 'torrent_file',
      sourceUri: params.sourcePaths[0],
      torrentFilePath: params.torrentFilePath,
      savePath: sourceFolder,
      status: 'queued',
      seedPaths: params.sourcePaths,
    });

    this.managedTorrents.set(download.id, {
      id: download.id,
      torrent: null,
      download,
      infoHash: null,
    });
    this.seedOptionsCache.set(download.id, {
      announceList: params.announceList,
      pieceLength: params.pieceLength,
    });

    await this.processQueue();
    return download;
  }

  /**
   * Seed existing files from disk (used by "start seeding"). The torrent is
   * complete on arrival, so it goes straight to the seeding state.
   */
  private async addSeedInternal(id: string, paths: string[], _savePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const managed = this.managedTorrents.get(id);
      if (!managed) { reject(new TorrentError('Download not found', 'NOT_FOUND', id)); return; }

      const opts = this.seedOptionsCache.get(id) || {};
      const seedOpts: any = { name: managed.download.name };
      if (opts.announceList && opts.announceList.length) seedOpts.announceList = opts.announceList;
      if (opts.pieceLength) seedOpts.pieceLength = opts.pieceLength;

      let settled = false;
      const fail = (e: any) => {
        if (settled) return; settled = true;
        this.client.removeListener('error', fail);
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      try {
        this.client.seed(paths, seedOpts, async (torrent: any) => {
          if (settled) return; settled = true;
          this.client.removeListener('error', fail);
          try {
            managed.torrent = torrent;
            // Snapshot lifetime totals (a re-seeded entry may already have an
            // upload history we must not reset to 0).
            managed.sessionBaseDownloaded = managed.download.downloadedBytes || 0;
            managed.sessionBaseUploaded = managed.download.uploadedBytes || 0;
            const infoHash = torrent.infoHash;

            const duplicateId = this.getDuplicateByInfoHash(infoHash, id);
            if (duplicateId) {
              try { this.client.remove(torrent); } catch { /* ignore */ }
              managed.torrent = null;
              await db.deleteDownload(id);
              this.managedTorrents.delete(id);
              this.seedOptionsCache.delete(id); // terminal outcome — don't leak the cache entry
              reject(new TorrentError('This torrent is already added', 'DUPLICATE', id));
              return;
            }

            managed.infoHash = infoHash;
            this.infoHashIndex.set(infoHash, id);
            managed.download.name = torrent.name || managed.download.name;
            managed.download.totalSize = torrent.length || 0;

            (torrent as unknown as NodeJS.EventEmitter).on('error', (err: Error) => {
              log.error('Seed torrent error', { id, error: err?.message || String(err) });
            });

            // Already complete: queued → downloading → seeding.
            await this.transitionStatus(id, 'downloading').catch(() => {});
            await this.transitionStatus(id, 'seeding').catch(() => {});
            await db.updateDownloadField(id, 'seedingStartedAt', Date.now());
            managed.download.seedingStartedAt = Date.now();
            await db.updateDownloadProgress(id, {
              progress: 1,
              downloadedBytes: torrent.length || 0,
              uploadedBytes: 0,
              downSpeedBps: 0,
              upSpeedBps: 0,
              etaSeconds: null,
              peers: torrent.numPeers || 0,
              seeds: 0,
              name: torrent.name,
              totalSize: torrent.length || 0,
            });

            this.seedOptionsCache.delete(id);
            log.info('Seeding created torrent', { id, infoHash, name: torrent.name });
            resolve();
          } catch (e) {
            fail(e);
          }
        });
        this.client.once('error', fail);
      } catch (e) {
        fail(e);
      }
    });
  }

  /**
   * Internal method to add torrent to WebTorrent client
   */
  private async addTorrentInternal(
    id: string,
    source: string,
    savePath: string,
    isNew: boolean,
    selectedFiles?: number[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const managed = this.managedTorrents.get(id);
      if (!managed) {
        reject(new TorrentError('Download not found', 'NOT_FOUND', id));
        return;
      }
      
      // Prepare torrent input
      let torrentInput: string | Buffer = source;
      if (source.endsWith('.torrent') && fs.existsSync(source)) {
        torrentInput = fs.readFileSync(source);
      }
      
      // Add torrent with options
      const addOptions: any = {
        path: savePath,
      };

      // Merge any user-added trackers into the announce list (webtorrent unions
      // them with the torrent's own trackers). User-removed ones are pruned from
      // the live client once it's built (see the 'ready' handler).
      const customTrackers = managed.download.customTrackers || [];
      // For MAGNET sources (always public swarms) also union our curated default
      // trackers, so a trackerless/thin magnet gets tracker-based peers instead of
      // relying on DHT/PEX alone. NEVER for .torrent files — they may be from a
      // PRIVATE tracker, where injecting public trackers can get the user banned.
      const isMagnet = typeof source === 'string' && source.startsWith('magnet:');
      if (isMagnet) {
        addOptions.announce = Array.from(new Set([...customTrackers, ...DEFAULT_TRACKERS.flat()]));
      } else if (customTrackers.length > 0) {
        addOptions.announce = customTrackers;
      }

      // If selectedFiles is provided, configure file selection
      if (selectedFiles && selectedFiles.length > 0) {
        log.info('Adding torrent with selective file download', {
          id,
          selectedCount: selectedFiles.length,
        });
      }

      // client.add can throw synchronously — most often "Cannot add duplicate
      // torrent <hash>" when the engine already holds this infoHash. Translate it
      // into a clear, typed error instead of letting the raw message surface.
      let torrent: Torrent;
      try {
        torrent = this.client.add(torrentInput, addOptions);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/duplicate torrent/i.test(msg)) {
          reject(new TorrentError('This torrent is already in your downloads.', 'DUPLICATE', id));
        } else {
          reject(new TorrentError(msg || 'Failed to add torrent to the engine', 'ADD_FAILED', id));
        }
        return;
      }

      managed.torrent = torrent;
      // Snapshot lifetime totals so this session's bytes add onto them rather
      // than overwriting them (see ManagedTorrent.sessionBase* docs).
      managed.sessionBaseDownloaded = managed.download.downloadedBytes || 0;
      managed.sessionBaseUploaded = managed.download.uploadedBytes || 0;

      // Recheck bookkeeping: recheckReturnStatus assumes the re-verify completes
      // silently from intact on-disk data (no network transfer). If this instance
      // pulls ANY real bytes from a peer, the re-verify found the data incomplete
      // and this is effectively a fresh re-download — so a later 'done' must be
      // treated as a GENUINE completion (notify + auto-move), not a silent
      // restore. The 'download' event fires only on network bytes (disk
      // verification never emits it), so clearing the flag on it is exact.
      if (managed.recheckReturnStatus) {
        (torrent as unknown as NodeJS.EventEmitter).once('download', () => {
          if (managed.recheckReturnStatus) {
            log.debug('Recheck re-verify pulled network data — treating completion as genuine', { id });
            managed.recheckReturnStatus = null;
          }
        });
      }

      // Guard against magnets that never find peers: without metadata 'ready'
      // never fires and this promise would hang forever (blocking the IPC add
      // call and the queue). Time out, surface a clear error, allow retry.
      let settled = false;
      const metadataTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        log.warn('Metadata fetch timed out', { id });
        this.closeStreamServer(managed);
        try { managed.torrent?.destroy({ destroyStore: false } as any); } catch (_) { /* ignore */ }
        managed.torrent = null;
        this.transitionStatus(id, 'error', 'Timed out fetching torrent metadata (no peers found). Retry later.')
          .catch(() => { /* may already be in error state */ });
        reject(new TorrentError('Timed out fetching torrent metadata', 'METADATA_TIMEOUT', id));
      }, TorrentManager.METADATA_TIMEOUT_MS);
      
      // Transition to downloading only if not already in a terminal/active state
      // When restoring, we preserve the existing state (e.g., seeding, completed)
      const currentStatus = managed.download.status;
      if (isNew || currentStatus === 'queued' || currentStatus === 'paused') {
        // Only transition for new downloads or resuming from queued/paused
        this.transitionStatus(id, 'downloading').catch((err) => {
          log.error('Failed to transition to downloading', { id, error: err });
        });
      } else {
        log.debug('Preserving existing state during restore', { id, status: currentStatus });
      }
      
      torrent.on('ready', async () => {
        if (settled) return;
        settled = true;
        clearTimeout(metadataTimeout);
        // See the ManagedTorrent.everReady doc comment: this is the reliable
        // "have we actually learned totalSize/name before" signal, independent
        // of the isNew param (processQueue always passes isNew=true).
        const firstTimeReady = !managed.everReady;
        managed.everReady = true;
        // Drop any trackers the user removed (their announce client is built now).
        this.pruneRemovedTrackersLive(managed);
        // Apply file selection after torrent is ready
        if (selectedFiles && selectedFiles.length > 0) {
          try {
            // Deselect all files first
            torrent.files.forEach((file) => file.deselect());
            
            // Select only chosen files
            selectedFiles.forEach((index) => {
              if (index < torrent.files.length) {
                torrent.files[index].select();
                log.debug('Selected file for download', { 
                  id, 
                  index, 
                  path: torrent.files[index].path 
                });
              }
            });
            
            log.info('Applied selective file download', {
              id,
              totalFiles: torrent.files.length,
              selectedFiles: selectedFiles.length,
            });
          } catch (err) {
            log.error('Failed to apply file selection', { id, error: err });
          }
        }
        // Restore the piece-picking strategy from the persisted flag (WebTorrent
        // defaults new instances to 'sequential', so always set it explicitly).
        this.applyStrategy(torrent, managed.download.sequentialDownload === true);
        // If the user paused while metadata was still being fetched, the
        // selections applied above would start the download despite the
        // 'paused' status (soft pause keeps wires alive, so 'ready' still
        // fires). Halt again to honour the paused state.
        if (managed.download.status === 'paused') {
          this.haltTorrent(torrent);
        }
        // Store infoHash for duplicate detection
        const infoHash = torrent.infoHash;
        
        // Update infoHash if it wasn't available before (shouldn't happen normally)
        if (!managed.infoHash) {
          managed.infoHash = infoHash;
          this.infoHashIndex.set(infoHash, id);
          log.debug('InfoHash registered from ready event', { id, infoHash });
        }

        // Check for duplicates (safety check)
        const duplicateId = this.getDuplicateByInfoHash(infoHash, id);
        if (duplicateId) {
          const duplicateDownload = this.managedTorrents.get(duplicateId);
          const duplicateName = duplicateDownload?.download.name || 'Unknown';
          log.warn('Duplicate torrent detected', { id, duplicateId, infoHash, duplicateName });
          
          // Remove this torrent and keep the existing one
          try {
            this.client.remove(torrent);
            log.debug('Duplicate torrent removed from WebTorrent', { id });
          } catch (e) {
            log.error('Failed to remove duplicate torrent', { id, error: e });
          }
          managed.torrent = null;
          managed.infoHash = null;
          
          const errorMessage = `This torrent is already added: "${duplicateName}"`;
          
        // Completely remove duplicate from system — use hard delete to prevent resurrection
          await db.deleteDownload(id);
          this.managedTorrents.delete(id);
          
          reject(new TorrentError(errorMessage, 'DUPLICATE', id));
          return;
        }

        // Update name and totalSize from torrent metadata
        const name = torrent.name || 'Unknown';
        const totalSize = torrent.length || 0;
        managed.download.name = name;
        managed.download.totalSize = totalSize;

        log.debug('Torrent ready', { id, name, infoHash, totalSize });

        // Update database with torrent metadata — only the first time we ever
        // learn it for this torrent, so a resume/recheck re-add can't re-stamp
        // totalSize from a transient mid-reattach reading (isNew is unreliable
        // here: processQueue always passes true, even for resumes).
        if (firstTimeReady) {
          await db.updateDownloadProgress(id, {
            progress: torrent.progress,
            downloadedBytes: torrent.downloaded,
            uploadedBytes: torrent.uploaded,
            downSpeedBps: torrent.downloadSpeed,
            upSpeedBps: torrent.uploadSpeed,
            etaSeconds: torrent.timeRemaining > 0 ? Math.floor(torrent.timeRemaining / 1000) : null,
            peers: torrent.numPeers,
            seeds: 0,
            name,
            totalSize,
          });
        }

        resolve();
      });
      
      torrent.on('done', async () => {
        log.info('Torrent completed', { id, name: managed.download.name });
        if (managed.download.status !== 'downloading') return;

        // Backstop for the pause race: WebTorrent's _checkDone() fires 'done' when
        // there are NO selections at all (which is exactly how haltTorrent pauses).
        // A genuinely-finished torrent still has its satisfied selection at emit
        // time (the emit precedes _gcSelections), so an empty _selections here means
        // a paused partial download, not a real completion — ignore it.
        const sel = (torrent as unknown as { _selections?: unknown[] })._selections;
        if (Array.isArray(sel) && sel.length === 0) {
          log.debug('Ignoring spurious done (no selections — torrent is paused/halted)', { id });
          return;
        }

        // Persist the completion snapshot NOW rather than waiting on the throttled
        // 5s stats tick — auto-move destroys the instance right after 'done', and an
        // app quit in that window would otherwise leave the DB at sub-1.0 progress.
        managed.download.progress = 1;
        try { await db.updateDownloadField(id, 'progress', 1); } catch (_) { /* best-effort */ }

        // Was this 'done' just a force-recheck re-verifying already-complete data?
        // Restore the pre-recheck status silently: no spurious "download complete"
        // notification and DON'T reset the seed-time clock.
        const recheckReturn = managed.recheckReturnStatus;
        managed.recheckReturnStatus = null;
        if (recheckReturn) {
          // A 'completed' torrent was explicitly STOPPED (no live instance) — a
          // recheck must not leave it seeding, or it uploads forever with the UI
          // showing "Completed" and no way to stop it (stopSeeding/pause both
          // reject that state). Tear the instance down like stopSeeding does.
          if (recheckReturn === 'completed') {
            this.closeStreamServer(managed);
            try { managed.torrent?.destroy({ destroyStore: false } as any); } catch (_) { /* ignore */ }
            managed.torrent = null;
          }
          await this.transitionStatus(id, recheckReturn);
          // The recheck occupied a download slot while verifying — free it.
          void this.processQueue();
          return;
        }

        await this.transitionStatus(id, 'seeding');
        // Record when seeding started for time-limit tracking
        await db.updateDownloadField(id, 'seedingStartedAt', Date.now());
        managed.download.seedingStartedAt = Date.now();
        // Notify completion listeners (used for OS notifications)
        for (const cb of this.completionCallbacks) {
          try { cb({ id, name: managed.download.name }); } catch (_) { /* ignore */ }
        }
        // Auto-move to the completed folder (then keep seeding from there).
        void this.moveCompletedIfNeeded(id);
        // The download slot this torrent held just freed up (seeding doesn't
        // count toward maxActiveDownloads) — promote the next queued download.
        void this.processQueue();
      });

      
      // WebTorrent types are incomplete - error event exists but isn't typed correctly
      (torrent as unknown as NodeJS.EventEmitter).on('error', async (err: Error) => {
        log.error('Torrent error', {
          id,
          error: err?.message || String(err),
        });

        const errorMsg = err?.message || String(err);

        try {
          await this.transitionStatus(id, 'error', errorMsg);
        } catch (e) {
          // Status transition might fail if already in error state
          log.warn('Could not transition to error state', { id });
        }

        // If the torrent errored before 'ready', settle the add promise too —
        // otherwise the caller (IPC add / queue) would wait forever.
        if (!settled) {
          settled = true;
          clearTimeout(metadataTimeout);
          reject(new TorrentError(errorMsg, 'TORRENT_ERROR', id));
        }

        // Process queue to start next download
        this.processQueue();
      });
      
      // If the download was paused, pause immediately
      if (managed.download.status === 'paused') {
        torrent.pause();
      }
    });
  }
  
  /**
   * Process the download queue
   */
  private async processQueue(): Promise<void> {
    const activeCount = this.getActiveCount();

    log.debug('Processing queue', { activeCount, maxActive: this.maxActiveDownloads });

    if (activeCount >= this.maxActiveDownloads) {
      log.debug('Max active downloads reached, skipping queue processing');
      return;
    }

    // Find queued downloads, sorted by priority (2=high → 1=normal → 0=low)
    const queued = await db.getDownloadsByStatus('queued');
    queued.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const slotsAvailable = this.maxActiveDownloads - activeCount;

    log.debug('Queue status', { queuedCount: queued.length, slotsAvailable });

    for (let i = 0; i < Math.min(queued.length, slotsAvailable); i++) {
      const download = queued[i];
      const managed = this.managedTorrents.get(download.id);
      if (!managed) continue;

      if (managed.torrent) {
        // A soft-paused torrent that was re-queued in place because we were at
        // the active limit (see resumeDownload). Its instance is still live —
        // resume it directly rather than re-adding from scratch.
        try {
          this.resumeInPlace(managed);
          await this.transitionStatus(download.id, 'downloading');
          log.debug('Promoted re-queued in-memory download', { id: download.id });
        } catch (error) {
          log.error('Failed to promote queued in-memory download', {
            id: download.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      {
        try {
          // "Start seeding" entries seed the original files from disk.
          if (download.seedPaths && download.seedPaths.length > 0) {
            log.debug('Starting queued seed', { id: download.id });
            await this.addSeedInternal(download.id, download.seedPaths, download.savePath);
            continue;
          }

          let source: string;
          if (download.sourceType === 'torrent_file' && download.torrentFilePath) {
            source = download.torrentFilePath;
          } else {
            source = download.sourceUri;
          }

          log.debug('Starting queued download', { id: download.id, priority: download.priority });
          await this.addTorrentInternal(
            download.id,
            source,
            download.savePath,
            true,
            managed.selectedFiles
          );
        } catch (error) {
          log.error('Failed to start queued download', {
            id: download.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  
  /**
   * Get count of currently active downloads
   */
  private getActiveCount(): number {
    let count = 0;
    for (const managed of this.managedTorrents.values()) {
      if (managed.torrent && isActiveState(managed.download.status)) {
        count++;
      }
    }
    return count;
  }

  /** Torrents holding a live WebTorrent instance (downloading OR seeding) — both
   *  open peer connections, so both count against the global connection budget. */
  private liveTorrentCount(): number {
    let count = 0;
    for (const managed of this.managedTorrents.values()) {
      if (managed.torrent && (managed.download.status === 'downloading' || managed.download.status === 'seeding')) {
        count++;
      }
    }
    return count;
  }

  /**
   * Scale the per-torrent connection ceiling (client.maxConns, read live by
   * WebTorrent) so the total across all live torrents stays within the global
   * budget. Prevents flooding the router's NAT table / exhausting OS sockets —
   * the cause of "torrents kill my whole internet" and crashes under load.
   */
  private applyConnectionLimit(): void {
    if (!this.client) return;
    const perTorrentCeiling = this.maxConnections > 0 ? this.maxConnections : 100;
    const globalCap = this.maxConnectionsGlobal > 0 ? this.maxConnectionsGlobal : perTorrentCeiling;
    const live = Math.max(1, this.liveTorrentCount());
    const target = Math.max(
      TorrentManager.MIN_CONNS_PER_TORRENT,
      Math.min(perTorrentCeiling, Math.floor(globalCap / live))
    );

    // Connection slow-start: while the ramp window is open, clamp the applied
    // ceiling to a value that climbs linearly from RAMP_START_CONNS to the full
    // target. Re-evaluated each stats tick (see startStatsBroadcast) so it
    // progresses smoothly; the window self-closes once elapsed.
    let effective = target;
    if (this.connRampStartAt > 0) {
      const elapsed = Date.now() - this.connRampStartAt;
      if (elapsed >= TorrentManager.RAMP_DURATION_MS) {
        this.connRampStartAt = 0; // ramp complete
      } else {
        const frac = elapsed / TorrentManager.RAMP_DURATION_MS;
        const ramped = Math.round(
          TorrentManager.RAMP_START_CONNS + (target - TorrentManager.RAMP_START_CONNS) * frac
        );
        effective = Math.max(TorrentManager.RAMP_START_CONNS, Math.min(target, ramped));
      }
    }

    if ((this.client as any).maxConns !== effective) {
      (this.client as any).maxConns = effective;
      log.debug('Connection limit applied', { live, target, effective, ramping: this.connRampStartAt > 0 });
    }
  }

  /**
   * Safely delete a path recursively with retry logic
   */
  private async deletePathRecursive(targetPath: string, downloadId: string): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!fs.existsSync(targetPath)) {
          log.debug('Path does not exist, skipping deletion', { path: targetPath });
          return;
        }

        const stat = fs.statSync(targetPath);

        if (stat.isDirectory()) {
          // First, recursively delete all contents
          const items = fs.readdirSync(targetPath);
          for (const item of items) {
            const itemPath = path.join(targetPath, item);
            await this.deletePathRecursive(itemPath, downloadId);
          }

          // Then delete the empty directory
          fs.rmdirSync(targetPath);
          log.debug('Deleted directory', { path: targetPath });
        } else {
          // Delete file
          fs.unlinkSync(targetPath);
          log.debug('Deleted file', { path: targetPath });
        }

        return; // Success
      } catch (e) {
        const error = e as NodeJS.ErrnoException;
        const errorMsg = error.message || String(e);

        if (attempt < maxRetries) {
          // Retry on permission errors or "directory not empty" errors
          if (error.code === 'EPERM' || error.code === 'ENOTEMPTY' || error.code === 'EBUSY') {
            log.warn(`Delete attempt ${attempt} failed, retrying...`, {
              path: targetPath,
              error: errorMsg,
              code: error.code,
            });
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            continue;
          }
        }

        // Final attempt failed or non-retryable error
        log.error('Failed to delete path after retries', {
          id: downloadId,
          path: targetPath,
          error: errorMsg,
          code: error.code,
          attempts: attempt,
        });
        return; // Don't throw, just log the error
      }
    }
  }

  /**
   * Pause a download
   */
  async pauseDownload(id: string): Promise<void> {
    await this.whenReady();
    log.info('Pausing download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    // Check if the current state can pause
    const currentStatus = managed.download.status;
    if (!canPause(currentStatus)) {
      throw new TorrentError(
        `Cannot pause download in ${currentStatus} state`,
        'INVALID_STATE',
        id
      );
    }
    
    // Validate state transition before attempting pause
    if (!isValidTransition(currentStatus, 'paused')) {
      throw new TorrentError(
        `Invalid state transition from ${currentStatus} to paused`,
        'INVALID_STATE',
        id
      );
    }
    
    if (managed.torrent && !managed.torrent.done) {
      // Soft pause: stop the torrent from wanting pieces but keep it (and its
      // peer connections) alive — destroying-and-recreating on every pause used
      // to drop the whole swarm and force a full on-disk re-hash on resume.
      log.debug('Soft-pausing in-progress torrent (halt selections, keep wires)', { id, infoHash: managed.infoHash });
      this.closeStreamServer(managed);
      // Mark 'paused' BEFORE halting. haltTorrent clears torrent._selections to
      // stop wanting pieces, but WebTorrent's _checkDone() treats "no selections"
      // as DONE and fires a spurious 'done' the moment an in-flight piece verifies
      // just after. If the status were still 'downloading', the 'done' handler
      // would falsely mark this PARTIAL download complete (100%) — the "stop →
      // hangs → shows completed" deception. Transitioning first makes it a no-op.
      await this.transitionStatus(id, 'paused');
      this.haltTorrent(managed.torrent);
    } else {
      if (managed.torrent) {
        // Already complete (seeding): nothing to lose by destroying, and doing so
        // is what releases the on-disk file handle — WebTorrent keeps it open
        // while seeding, which can make the file look "in use"/locked until
        // paused. Data on disk is preserved (destroyStore: false).
        log.debug('Destroying completed torrent instance for pause', { id, infoHash: managed.infoHash });
        this.closeStreamServer(managed);
        try {
          managed.torrent.destroy({ destroyStore: false } as any);
        } catch (e) {
          log.warn('Error destroying torrent during pause (non-fatal)', { error: String(e) });
        }
        managed.torrent = null;
      }
      await this.transitionStatus(id, 'paused');
    }

    // Process queue to start next download
    await this.processQueue();

    log.debug('Download paused successfully', { id });
  }

  /**
   * Actually stop a live torrent from downloading while keeping wires alive.
   *
   * WebTorrent's public deselect() CANNOT do this reliably: every select() call
   * pushes a NEW entry onto torrent._selections (and the app selects on ready,
   * on resume, on stream-open, plus WebTorrent adds its own whole-torrent
   * default), while deselect() removes only the FIRST entry matching its exact
   * (from,to,priority) triple. Leftover duplicate selections keep the torrent
   * interested and pieces keep flowing — verified against real loopback wires:
   * after duplicated selects, "deselect everything" left 1 selection and the
   * download kept growing at full speed; clearing _selections stopped it dead
   * (0 bytes over 4s) and resume()+select() restarted it cleanly.
   *
   * So: clear the selection list directly (private but stable across
   * webtorrent 1.x — both piece-request loops iterate _selections), drop
   * critical marks, pause() (blocks NEW peers), and push wire uninterest.
   */
  private haltTorrent(torrent: Torrent): void {
    const t = torrent as any;
    try { t.pause(); } catch { /* ignore */ }
    try {
      if (Array.isArray(t._selections)) t._selections.length = 0;
      t._critical = [];
      if (typeof t._updateInterest === 'function') t._updateInterest();
    } catch (e) {
      log.warn('haltTorrent: failed to clear selections (non-fatal)', { error: String(e) });
    }
  }

  /**
   * Re-arm a soft-paused torrent that never left memory so it actively wants
   * pieces again — without the full tear-down/re-add that drops peers and forces
   * an on-disk re-verify. Caller is responsible for the status transition.
   * Shared by resumeDownload (direct resume) and processQueue (promotion of a
   * torrent that was re-queued in place because we were at the active limit).
   */
  private resumeInPlace(managed: ManagedTorrent): void {
    const torrent = managed.torrent;
    if (!torrent) return;
    try {
      const t = torrent as any;
      try { t.resume(); } catch { /* ignore */ }
      // Start from a clean slate: selections accumulate (see haltTorrent) and a
      // pile of stale entries is exactly what used to defeat pause.
      if (Array.isArray(t._selections)) t._selections.length = 0;
      if (managed.selectedFiles && managed.selectedFiles.length > 0) {
        managed.selectedFiles.forEach((index) => {
          if (index < torrent.files.length) torrent.files[index].select();
        });
      } else {
        torrent.files.forEach((file) => file.select());
      }
      this.applyStrategy(torrent, managed.download.sequentialDownload === true);
    } catch (e) {
      log.warn('Error re-selecting files on resume (non-fatal)', { error: String(e) });
    }
  }

  /**
   * Resume a download
   */
  async resumeDownload(id: string): Promise<void> {
    await this.whenReady();
    log.info('Resuming download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (!canResume(managed.download.status)) {
      throw new TorrentError(
        `Cannot resume download in ${managed.download.status} state`,
        'INVALID_STATE',
        id
      );
    }
    
    if (managed.torrent) {
      // Soft-paused: the torrent (and its peers) never left memory. Just want
      // pieces again instead of tearing everything down and re-adding from
      // scratch — that full re-add is what used to drop peers and force a
      // complete on-disk re-verify on every single resume.
      //
      // But respect the concurrency limit: resuming straight to 'downloading'
      // without a slot check let pause→resume (and "Resume All") blow past
      // maxActiveDownloads, since pauseDownload already promoted a queued torrent
      // into the freed slot. If we're at capacity, re-queue it (kept halted) and
      // let processQueue promote it in place when a slot frees.
      if (this.getActiveCount() >= this.maxActiveDownloads) {
        this.haltTorrent(managed.torrent);
        await this.transitionStatus(id, 'queued');
        log.debug('Resume deferred — at max active downloads; re-queued in place', { id });
        return;
      }
      log.debug('Torrent still in memory on resume — re-selecting instead of re-adding', { id });
      this.resumeInPlace(managed);
      await this.transitionStatus(id, 'downloading');
      log.debug('Download resumed in place (no re-add)', { id });
      return;
    }

    // No live torrent (paused while seeding, queued, or never attached) —
    // re-queue so processQueue() re-adds it from scratch.
    log.debug('Re-queueing download for resume', { id });
    await this.transitionStatus(id, 'queued');
    await this.processQueue();

    log.debug('Download resumed successfully', { id });
  }

  /**
   * Remove a download
   */
  async removeDownload(id: string, deleteFiles: boolean): Promise<void> {
    await this.whenReady();
    log.info('Removing download', { id, deleteFiles, idType: typeof id, deleteFilesType: typeof deleteFiles });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError(`Download not found: ${id}`, 'NOT_FOUND', id);
    }

    // If an auto-move is in flight, wait for it: otherwise we'd read the stale
    // pre-move savePath below and delete the already-emptied source, orphaning the
    // moved copy (and the DB row would point at the new path we never cleaned).
    await this.waitForMove(id);

    // Remove from infoHash index
    if (managed.infoHash) {
      this.infoHashIndex.delete(managed.infoHash);
    }

    // Stop any active stream server first
    this.closeStreamServer(managed);
    // Kill any cast/transcode ffmpeg reading this torrent's files from disk —
    // otherwise the open handle blocks file deletion on Windows and the process
    // keeps transcoding a removed torrent. No-op if casting was never used.
    try { peekCastServer()?.teardownDownload(id); } catch (_) { /* non-fatal */ }

    // Remove from WebTorrent if torrent exists
    if (managed.torrent) {
      try {
        // Check if torrent is in client before removing
        const torrentInClient = this.client.torrents.find(t => t === managed.torrent);
        if (torrentInClient) {
          this.client.remove(managed.torrent);
          log.debug('Torrent removed from WebTorrent', { id });
        } else {
          log.debug('Torrent not in WebTorrent client, skipping removal', { id });
        }
      } catch (e) {
        log.error('Failed to remove torrent from WebTorrent', { id, error: e });
        // Don't throw - continue with cleanup even if WebTorrent removal fails
      }
      // Detach the live instance NOW. The managed entry lingers in the map through
      // the 500ms delete delay below, and the stats broadcast (every 750ms) would
      // otherwise read counters off the just-destroyed torrent (freed state) and
      // briefly emit a torrent that's mid-deletion. Also mark it removed so the
      // broadcast skips it entirely. Mirrors stopSeeding/recheck cleanup.
      managed.torrent = null;
      managed.download.status = 'removed';
    }

    // Delete files if requested
    if (deleteFiles) {
      // Wait a bit for file handles to be released
      await new Promise(resolve => setTimeout(resolve, 500));

      const seedPaths = managed.download.seedPaths;
      if (seedPaths && seedPaths.length > 0) {
        // "Start seeding" entries point at the user's ACTUAL files. Delete those
        // exact paths — never path.join(savePath, name): a custom torrent name
        // would miss the real files (silent failure) or, worse, match unrelated
        // data that happens to share the name in the same folder and destroy it.
        for (const p of seedPaths) {
          if (fs.existsSync(p)) await this.deletePathRecursive(p, id);
        }
      } else {
        const downloadPath = managed.download.savePath;
        if (fs.existsSync(downloadPath)) {
          const targetPath = path.join(downloadPath, managed.download.name);
          if (fs.existsSync(targetPath)) {
            await this.deletePathRecursive(targetPath, id);
          }
        }
      }
    }
    
    // Clean up stored torrent file if exists
    if (managed.download.torrentFilePath && fs.existsSync(managed.download.torrentFilePath)) {
      try {
        fs.unlinkSync(managed.download.torrentFilePath);
        log.debug('Deleted stored torrent file', { path: managed.download.torrentFilePath });
      } catch (e) {
        log.warn('Failed to delete stored torrent file', {
          path: managed.download.torrentFilePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    
    // Permanently delete from database — prevents resurrection on next launch
    await db.deleteDownload(id);
    log.debug('Download deleted from store', { id });
    
    // Remove from managed map
    this.managedTorrents.delete(id);
    // Release any cached seed options (announce list / piece length buffers) —
    // a "start seeding" entry removed while still queued never hit the success
    // path in addSeedInternal that would otherwise clear this.
    this.seedOptionsCache.delete(id);

    // Remove from infoHash index to prevent memory leaks
    if (managed.infoHash) {
      this.infoHashIndex.delete(managed.infoHash);
      log.debug('Removed from infoHash index', { id, infoHash: managed.infoHash });
    }

    // Process queue
    await this.processQueue();

    log.info('Download removed successfully', { id });
  }
  
  /**
   * Stop seeding a completed download
   */
  async stopSeeding(id: string): Promise<void> {
    await this.whenReady();
    log.info('Stopping seeding', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (managed.download.status !== 'seeding') {
      throw new TorrentError(
        'Download is not seeding',
        'INVALID_STATE',
        id
      );
    }

    // Don't race an in-flight auto-move (which destroys+re-seeds the instance).
    await this.waitForMove(id);

    // Destroy the torrent instance — torrent.pause() in WebTorrent 1.9.7 only
    // stops new connections; already-connected peers keep downloading from us.
    // Data on disk is preserved (destroyStore: false).
    if (managed.torrent) {
      this.closeStreamServer(managed);
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (e) {
        log.warn('Error destroying torrent during stopSeeding (non-fatal)', { error: String(e) });
      }
      managed.torrent = null;
    }

    await this.transitionStatus(id, 'completed');

    // A seeding slot was freed — let the next queued torrent start
    await this.processQueue();

    log.debug('Seeding stopped', { id });
  }
  
  /**
   * Retry a failed download
   */
  async retryDownload(id: string): Promise<void> {
    await this.whenReady();
    log.info('Retrying download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    
    if (managed.download.status !== 'error') {
      throw new TorrentError(
        'Can only retry downloads in error state',
        'INVALID_STATE',
        id
      );
    }
    
    // Re-queue (transitionStatus will clear the error)
    await this.transitionStatus(id, 'queued');

    // Process queue
    await this.processQueue();

    log.debug('Download re-queued for retry', { id });
  }

  /**
   * Force a data recheck: re-hash the files already on disk against the
   * torrent's piece hashes. Implemented by dropping the live torrent instance
   * (keeping the data) and re-adding it — WebTorrent verifies existing pieces
   * on add, so valid data is kept and only missing/corrupt pieces re-download.
   * Works from any state that may have data on disk.
   */
  async recheckDownload(id: string): Promise<void> {
    await this.whenReady();
    log.info('Rechecking download', { id });

    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }

    if (!canRecheck(managed.download.status)) {
      throw new TorrentError(
        `Cannot recheck a download in ${managed.download.status} state`,
        'INVALID_STATE',
        id
      );
    }

    // Don't race an in-flight auto-move (which destroys+re-seeds the instance).
    await this.waitForMove(id);

    // If we're re-verifying an already-finished torrent, remember its status so
    // the immediate 'done' on re-verify restores it silently (no completion
    // notification, no seed-clock reset) rather than looking like a fresh
    // completion. Incomplete rechecks download normally and notify as usual.
    managed.recheckReturnStatus = isFinished(managed.download.status)
      ? managed.download.status
      : null;

    // Drop the live instance but keep the data on disk (destroyStore: false).
    this.closeStreamServer(managed);
    if (managed.torrent) {
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (e) {
        log.warn('Error destroying torrent during recheck (non-fatal)', { error: String(e) });
      }
      managed.torrent = null;
    }

    // Reflect the re-verification in the UI: progress climbs from 0 as pieces
    // are validated. Lifetime up/down byte counters are left untouched.
    managed.download.progress = 0;
    managed.download.downSpeedBps = 0;
    managed.download.upSpeedBps = 0;
    try { await db.updateDownloadField(id, 'progress', 0); } catch (_) { /* best-effort */ }

    // Re-queue → processQueue re-adds it → WebTorrent verifies on-disk data.
    await this.transitionStatus(id, 'queued');
    await this.processQueue();

    log.debug('Download re-queued for recheck', { id });
  }

  /**
   * Move a freshly-completed download to the configured "completed" folder and
   * keep seeding from the new location. Best-effort and fully guarded: any
   * failure leaves the torrent seeding from its original path.
   */
  private async moveCompletedIfNeeded(id: string): Promise<void> {
    if (!this.autoMoveEnabled || !this.autoMovePath) return;
    if (this.movingIds.has(id)) return;

    const managed = this.managedTorrents.get(id);
    if (!managed) return;
    // "Start seeding" entries live at their original source — never relocate.
    if (managed.download.seedPaths && managed.download.seedPaths.length > 0) return;

    const name = managed.download.name;
    const srcDir = managed.download.savePath;
    if (!name || !srcDir) return;
    if (path.resolve(srcDir) === path.resolve(this.autoMovePath)) return; // already there

    const src = path.join(srcDir, name);
    const dest = path.join(this.autoMovePath, name);
    if (!fs.existsSync(src)) return;            // nothing on disk to move
    if (fs.existsSync(dest)) {
      log.warn('Auto-move skipped: destination already exists', { id, dest });
      return;
    }

    this.movingIds.add(id);
    let resolveMove: () => void = () => {};
    this.movingPromises.set(id, new Promise<void>((r) => { resolveMove = r; }));
    // Prefer re-seeding offline from the .torrent metadata we have in memory.
    const metaBuffer: Buffer | null = (() => {
      try { return (managed.torrent as any)?.torrentFile ?? null; } catch { return null; }
    })();

    try {
      log.info('Auto-moving completed download', { id, from: src, to: dest });

      // Release file handles before moving (WebTorrent holds them while seeding).
      this.closeStreamServer(managed);
      if (managed.torrent) {
        try { managed.torrent.destroy({ destroyStore: false } as any); } catch (_) { /* ignore */ }
        managed.torrent = null;
      }
      await new Promise((r) => setTimeout(r, 800));

      if (!fs.existsSync(this.autoMovePath)) fs.mkdirSync(this.autoMovePath, { recursive: true });

      // rename() is atomic on the same volume; across volumes it throws EXDEV,
      // so fall back to a recursive copy + delete.
      try {
        fs.renameSync(src, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          this.copyRecursiveSync(src, dest);
          await this.deletePathRecursive(src, id);
        } else {
          throw e;
        }
      }

      // Persist the new location. Save the metadata so re-seeding is offline
      // (a magnet-sourced torrent would otherwise need peers to re-verify).
      const fields: Partial<Download> = { savePath: this.autoMovePath };
      if (metaBuffer) {
        const dir = path.join(getHostEnv().userDataDir, 'torrents');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tf = path.join(dir, `${id}.torrent`);
        try {
          fs.writeFileSync(tf, metaBuffer);
          fields.torrentFilePath = tf;
          fields.sourceType = 'torrent_file';
          fields.sourceUri = tf;
        } catch (_) { /* fall back to existing source */ }
      }
      Object.assign(managed.download, fields);
      await db.updateDownloadFields(id, fields);

      // Re-seed from the new path (isNew=false preserves the 'seeding' state).
      const source = managed.download.torrentFilePath || managed.download.sourceUri;
      await this.addTorrentInternal(id, source, this.autoMovePath, false, managed.selectedFiles);
      log.info('Auto-move complete; re-seeding from new location', { id, dest });
    } catch (e) {
      log.error('Auto-move failed; re-seeding from original location', { id, error: e instanceof Error ? e.message : String(e) });
      // Best-effort: keep seeding from wherever the data still is.
      try {
        if (!managed.torrent) {
          const source = managed.download.torrentFilePath || managed.download.sourceUri;
          await this.addTorrentInternal(id, source, managed.download.savePath, false, managed.selectedFiles);
        }
      } catch (_) { /* give up; user can recheck manually */ }
    } finally {
      this.movingIds.delete(id);
      this.movingPromises.delete(id);
      resolveMove();
    }
  }

  /** Await any in-flight auto-move for this id (no-op if none). Lets remove/
   *  stopSeeding/recheck operate on the final savePath, not a mid-move one. */
  private async waitForMove(id: string): Promise<void> {
    const p = this.movingPromises.get(id);
    if (p) {
      log.debug('Waiting for in-flight auto-move to settle before mutating', { id });
      try { await p; } catch { /* the move guards its own errors */ }
    }
  }

  /** Recursive synchronous copy (file or directory) for cross-volume moves. */
  private copyRecursiveSync(src: string, dest: string): void {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        this.copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  /**
   * Get all downloads
   */
  async getDownloads(): Promise<Download[]> {
    return db.getAllDownloads();
  }

  /**
   * Pause every active torrent (downloading / queued / seeding).
   * Used by the VPN kill-switch and the tray "Pause All" action.
   * Returns the number of torrents that were paused.
   */
  async pauseAllActive(): Promise<number> {
    await this.whenReady();
    let paused = 0;
    for (const [id, managed] of this.managedTorrents) {
      const status = managed.download.status;
      if (status === 'downloading' || status === 'queued' || status === 'seeding') {
        try {
          await this.pauseDownload(id);
          paused++;
        } catch (e) {
          log.warn('pauseAllActive: failed to pause one torrent', { id, error: String(e) });
        }
      }
    }
    log.info('Paused all active torrents', { count: paused });
    return paused;
  }

  /**
   * Resume every paused torrent (re-queues them; the queue respects
   * maxActiveDownloads). Used by the tray "Resume All" action and the UI.
   * Returns the number of torrents that were re-queued.
   */
  async resumeAllPaused(): Promise<number> {
    await this.whenReady();
    let resumed = 0;
    for (const [id, managed] of this.managedTorrents) {
      if (managed.download.status === 'paused') {
        try {
          await this.resumeDownload(id);
          resumed++;
        } catch (e) {
          log.warn('resumeAllPaused: failed to resume one torrent', { id, error: String(e) });
        }
      }
    }
    log.info('Resumed all paused torrents', { count: resumed });
    return resumed;
  }

  /**
   * Get files for a specific download
   */
  async getFiles(id: string): Promise<TorrentFile[]> {
    const managed = this.managedTorrents.get(id);
    if (!managed) {
      // If not in memory, check DB to confirm it exists
      const download = await db.getDownloadById(id);
      if (!download) {
        throw new TorrentError('Download not found', 'NOT_FOUND', id);
      }
      return [];
    }

    if (managed.torrent && managed.torrent.files) {
      return managed.torrent.files.map(file => ({
        name: file.name,
        path: file.path,
        length: file.length,
        downloaded: file.downloaded,
        progress: file.progress || (file.length > 0 ? file.downloaded / file.length : 0),
      }));
    }

    return [];
  }

  /**
   * Close and forget a managed torrent's streaming server (if any).
   * Called whenever the underlying torrent is destroyed (pause/resume/remove)
   * or on shutdown, so we never leak HTTP servers or point at a dead torrent.
   */
  private closeStreamServer(managed: ManagedTorrent): void {
    // Undo any instant-play prioritization first — this runs even for transcoded
    // streams, which don't create a per-torrent streamServer but still forced the
    // head selection / sequential strategy.
    if (managed.streamHead || managed.streamStrategyOverridden) {
      this.clearStreamHead(managed, managed.torrent);
      if (managed.streamStrategyOverridden) {
        managed.streamStrategyOverridden = false;
        if (managed.torrent) this.applyStrategy(managed.torrent, managed.download.sequentialDownload === true);
      }
    }
    const s = managed.streamServer;
    if (!s) return;
    managed.streamServer = null;
    try {
      if (typeof s.server.destroy === 'function') s.server.destroy();
      else s.server.close();
    } catch (e) {
      log.warn('Failed to close stream server', { id: managed.id, error: String(e) });
    }
  }

  /** Whether a file is supposed to be downloading per the user's intent (per-file
   *  'skip' priority and any selected-files subset). */
  private fileShouldDownload(managed: ManagedTorrent, fileIndex: number): boolean {
    if (managed.download.filePriorities?.[fileIndex] === 'skip') return false;
    if (managed.selectedFiles && managed.selectedFiles.length > 0) {
      return managed.selectedFiles.includes(fileIndex);
    }
    return true;
  }

  /**
   * Called by the renderer when the in-app player closes. getStreamUrl pins the
   * torrent into forced-sequential mode with a priority-10 head selection and
   * whole-file-selects the streamed file; without a pause/remove none of that
   * ever reverts, so the torrent stays stuck in sequential mode (defeating
   * rarest-first) and a previously "skipped" file keeps downloading forever.
   * This reverts all of it.
   */
  async stopStream(id: string, fileIndex?: number): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) return;
    const torrent = managed.torrent;
    // Revert head prioritization + forced-sequential strategy, close the server.
    this.closeStreamServer(managed);
    // getStreamUrl force-selects (whole-file) EVERY file the user previews this
    // session, and switching files never deselects the prior one — so re-assert
    // the intended selection across ALL files, not just the last active index.
    // Any file that shouldn't be downloading (skip / outside the selection) is
    // re-deselected so a quick preview doesn't permanently re-enable it.
    if (torrent && torrent.files) {
      torrent.files.forEach((f: any, idx: number) => {
        if (!this.fileShouldDownload(managed, idx)) {
          try { f.deselect(); } catch { /* ignore */ }
        }
      });
    }
    log.debug('Stream stopped and reverted', { id, fileIndex });
  }

  /**
   * Instant-play ("zero-wait") prioritization for a file about to be streamed.
   * WebTorrent only fetches the head of the file once the <video> issues its
   * first Range request, and under the default rarest-first strategy even those
   * head pieces arrive scattered — so playback stalls waiting for a contiguous
   * run. Here we (1) select the head of the file at a high priority so it wins
   * over other files/torrents, (2) mark the very first pieces critical so they're
   * requested from every peer immediately, and (3) force a sequential strategy so
   * the buffer fills in playback order. All three are reverted in
   * closeStreamServer().
   */
  private prioritizeStreamHead(managed: ManagedTorrent, torrent: Torrent, fileIndex: number): void {
    const file: any = torrent.files[fileIndex];
    if (!file || file.length === 0) return;
    const pieceLength: number = (torrent as any).pieceLength || 0;
    if (!pieceLength) return;

    // Clear any previous head selection so re-resolving (same or different file)
    // never accumulates duplicate high-priority selections.
    this.clearStreamHead(managed, torrent);

    const startPiece: number = file._startPiece;
    const endPiece: number = file._endPiece;
    const headPieces = Math.max(2, Math.ceil(STREAM_HEAD_BYTES / pieceLength));
    const headEnd = Math.min(startPiece + headPieces - 1, endPiece);

    try {
      (torrent as any).select(startPiece, headEnd, STREAM_HEAD_PRIORITY);
      (torrent as any).critical(startPiece, Math.min(startPiece + 2, endPiece));
    } catch (e) {
      log.warn('Stream head prioritization failed (non-fatal)', { id: managed.id, error: String(e) });
      return;
    }
    managed.streamHead = { fileIndex, startPiece, endPiece: headEnd };

    // Force sequential piece picking while streaming so the buffer fills in order.
    managed.streamStrategyOverridden = true;
    this.applyStrategy(torrent, true);
    log.debug('Stream head prioritized', { id: managed.id, fileIndex, startPiece, headEnd, headPieces });
  }

  /** Remove the active stream-head selection (best effort). */
  private clearStreamHead(managed: ManagedTorrent, torrent: Torrent | null): void {
    const head = managed.streamHead;
    if (!head) return;
    managed.streamHead = null;
    if (!torrent) return;
    try {
      (torrent as any).deselect(head.startPiece, head.endPiece, STREAM_HEAD_PRIORITY);
    } catch (e) {
      log.warn('Failed to clear stream head selection', { id: managed.id, error: String(e) });
    }
  }

  /**
   * Return a local HTTP URL for streaming a file inside a torrent. WebTorrent's
   * per-torrent server supports HTTP Range requests, and reading a byte range
   * prioritises those pieces — so playback works while the torrent is still
   * downloading (sequential, on demand). The server binds to 127.0.0.1 only.
   */
  async getStreamUrl(
    id: string,
    fileIndex: number,
    opts?: { transcode?: boolean },
  ): Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean }> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) {
      throw new TorrentError('Download not found', 'NOT_FOUND', id);
    }
    const torrent = managed.torrent;
    if (!torrent || !torrent.files || torrent.files.length === 0) {
      throw new TorrentError('Torrent is not active (resume it to stream)', 'NOT_ACTIVE', id);
    }
    if (fileIndex < 0 || fileIndex >= torrent.files.length) {
      throw new TorrentError('Invalid file index', 'INVALID_INPUT', id);
    }

    const file = torrent.files[fileIndex];
    // Make sure the file is selected so its pieces actually download.
    try { (file as any).select(); } catch { /* ignore */ }
    // Instant-play: prioritize the head of this file and fetch it in order so
    // playback starts within a couple of pieces instead of waiting on the swarm.
    this.prioritizeStreamHead(managed, torrent, fileIndex);

    const kind = classifyMediaKind(file.name);

    // Transcode when forced (direct playback failed) or the container isn't one
    // Chromium can play. Requires the bundled ffmpeg.
    const wantTranscode = opts?.transcode === true || !isDirectlyPlayable(file.name);
    if (wantTranscode && this.ffmpegPath) {
      const port = await this.ensureTranscodeServer();
      return {
        url: `http://127.0.0.1:${port}/transcode/${encodeURIComponent(id)}/${fileIndex}?t=${Date.now()}`,
        name: file.name,
        kind,
        transcoded: true,
      };
    }

    // Direct streaming via WebTorrent's per-torrent server (with Range support).
    // Reuse the server only if it belongs to the current torrent instance.
    if (managed.streamServer && managed.streamServer.torrent !== torrent) {
      this.closeStreamServer(managed);
    }

    if (!managed.streamServer) {
      // Harden WebTorrent's stream server. It binds to 127.0.0.1, but any
      // page in the user's browser can still reach localhost via fetch — and
      // WebTorrent defaults to `origin: '*'` (CORS open to every site). With
      // the path being just `/<fileIndex>`, a malicious site could read the
      // streaming file cross-origin.
      //   • hostname: '127.0.0.1' — rejects requests whose Host header isn't
      //     our loopback address (blocks DNS-rebinding).
      //   • origin: a sentinel string — NOTE webtorrent 1.9.7 coerces
      //     `origin:false` back to '*' (`if (!opts.origin) opts.origin='*'`),
      //     so `false` is useless here. A non-empty origin that no real site
      //     sends means Access-Control-Allow-Origin is never emitted for a
      //     cross-origin fetch, so the browser blocks JS from reading the body.
      //     Our own <video>/<audio> load is a no-cors request (no Origin
      //     header), so it still plays — same as before.
      const server = (torrent as any).createServer({ origin: 'th-local-stream', hostname: '127.0.0.1' });
      await new Promise<void>((resolve, reject) => {
        try {
          server.listen(0, '127.0.0.1', () => resolve());
          server.on('error', reject);
        } catch (e) {
          reject(e);
        }
      });
      const port = server.address().port;
      managed.streamServer = { server, port, torrent };
      log.info('Stream server started', { id, port });
    }

    const port = managed.streamServer.port;
    return {
      url: `http://127.0.0.1:${port}/${fileIndex}`,
      name: file.name,
      kind,
      transcoded: false,
    };
  }

  /** Bundled ffmpeg path (or null). Exposed for the LAN cast server. */
  get ffmpegBinary(): string | null { return this.ffmpegPath; }

  /**
   * Apply IP-blocklist filtering to the live client. Main owns the lists/parsing
   * and ships the merged, sorted [start,end] ranges; we drop any peer whose IPv4
   * falls inside a range. Wires are hooked once; later calls just swap the ranges
   * (the hook reads this.blockedRanges live).
   */
  applyIpBlocklist(ranges: Array<[number, number]>): void {
    this.blockedRanges = ranges;
    if (this.blocklistHooked || !this.client) return;
    this.blocklistHooked = true;

    const checkWire = (wire: any): void => {
      const n = typeof wire?.remoteAddress === 'string' ? ipToNum(wire.remoteAddress) : null;
      if (n !== null && ipInRanges(this.blockedRanges, n)) { try { wire.destroy(); } catch { /* ignore */ } }
    };
    const hookTorrent = (torrent: any): void => {
      torrent.on('wire', checkWire);
      for (const w of (torrent.wires || [])) checkWire(w);
    };
    this.client.on('torrent', hookTorrent);
    for (const t of (((this.client as any).torrents) || [])) hookTorrent(t);
    log.info('IP blocklist filtering active in torrent host', { ranges: ranges.length });
  }

  /**
   * The TCP port the engine listens on for incoming peers, for UPnP forwarding.
   * Prefers the live value WebTorrent resolves once its TCP pool is listening;
   * falls back to the configured fixed port (Settings → Advanced).
   */
  getListeningPort(): number {
    const live = Number((this.client as any)?.torrentPort) || 0;
    return live > 0 ? live : this.configuredPort;
  }

  /**
   * Resolve on-disk info for a file so the LAN "cast to device" server can serve
   * it (direct Range or on-demand HLS transcode). Returns null if not available.
   */
  getCastFileInfo(id: string, fileIndex: number): {
    name: string; length: number; diskPath: string; complete: boolean;
    kind: 'video' | 'audio' | 'other'; direct: boolean;
  } | null {
    const managed = this.managedTorrents.get(id);
    if (!managed || !managed.torrent) return null;
    const file = managed.torrent.files[fileIndex];
    if (!file) return null;
    const rel = (file as unknown as { path: string }).path || file.name;
    let diskPath = path.join(managed.download.savePath, rel);
    // "Start seeding" entries keep content at the original source path.
    if (!fs.existsSync(diskPath) && managed.download.seedPaths && managed.download.seedPaths.length === 1) {
      diskPath = managed.download.seedPaths[0];
    }
    const downloaded = (file as unknown as { downloaded: number }).downloaded || 0;
    const complete = file.length > 0 && downloaded >= file.length;
    return {
      name: file.name,
      length: file.length,
      diskPath,
      complete,
      kind: classifyMediaKind(file.name),
      direct: isDirectlyPlayable(file.name),
    };
  }

  // ── Subtitles ───────────────────────────────────────────────────────────────

  /** Run ffmpeg and resolve its stdout as a UTF-8 string (for VTT extraction). */
  private ffmpegCapture(args: string[]): Promise<string> {
    if (!this.ffmpegPath) return Promise.reject(new Error('ffmpeg unavailable'));
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath as string, args, { windowsHide: true });
      const out: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => out.push(d));
      proc.stderr.on('data', () => { /* discard */ });
      proc.on('error', reject);
      proc.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
    });
  }

  /** Parse `ffmpeg -i` stderr for embedded TEXT subtitle streams (skip image subs). */
  private probeSubtitleStreams(file: string): Promise<Array<{ sIndex: number; lang?: string; codec: string }>> {
    if (!this.ffmpegPath) return Promise.resolve([]);
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath as string, ['-i', file], { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', () => resolve([]));
      proc.on('close', () => {
        const out: Array<{ sIndex: number; lang?: string; codec: string }> = [];
        let sIndex = 0;
        const re = /Stream #\d+:\d+(?:\(([a-zA-Z]+)\))?: Subtitle: (\w+)/g;
        let m: RegExpExecArray | null;
        const textCodecs = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'srt']);
        while ((m = re.exec(err)) !== null) {
          const codec = m[2].toLowerCase();
          if (textCodecs.has(codec)) out.push({ sIndex, lang: m[1], codec });
          sIndex++; // count all subtitle streams so -map 0:s:<n> stays aligned
        }
        resolve(out);
      });
    });
  }

  /** List selectable subtitle tracks: embedded text subs + sidecar files. */
  async getSubtitleTracks(id: string, fileIndex: number): Promise<Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }>> {
    const info = this.getCastFileInfo(id, fileIndex);
    if (!info) return [];
    const tracks: Array<{ key: string; label: string; lang?: string; source: 'embedded' | 'external' }> = [];
    try {
      const streams = await this.probeSubtitleStreams(info.diskPath);
      streams.forEach((s, i) => {
        tracks.push({ key: `embedded:${s.sIndex}`, label: s.lang ? `${s.lang.toUpperCase()} (embedded)` : `Embedded #${i + 1}`, lang: s.lang, source: 'embedded' });
      });
    } catch { /* ignore */ }
    try {
      const dir = path.dirname(info.diskPath);
      const baseNoExt = path.basename(info.diskPath, path.extname(info.diskPath)).toLowerCase();
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(srt|ass|ssa|vtt|sub)$/i.test(f)) continue;
        // Prefer sidecars that share the video's base name, but include any.
        const related = f.toLowerCase().startsWith(baseNoExt.slice(0, Math.min(baseNoExt.length, 12)));
        tracks.push({ key: `external:${f}`, label: f, source: 'external' });
        if (related) { /* keep order; related ones still listed */ }
      }
    } catch { /* ignore */ }
    return tracks;
  }

  /** Return the chosen subtitle track converted to WebVTT text. */
  async getSubtitleVtt(id: string, fileIndex: number, key: string): Promise<string> {
    const info = this.getCastFileInfo(id, fileIndex);
    if (!info) throw new TorrentError('File not found', 'NOT_FOUND', id);
    if (key.startsWith('embedded:')) {
      const sIndex = Number(key.slice('embedded:'.length));
      return this.ffmpegCapture(['-i', info.diskPath, '-map', `0:s:${sIndex}`, '-f', 'webvtt', 'pipe:1']);
    }
    if (key.startsWith('external:')) {
      const name = key.slice('external:'.length);
      const full = path.join(path.dirname(info.diskPath), name);
      if (!fs.existsSync(full)) throw new Error('Subtitle file not found');
      if (/\.vtt$/i.test(full)) return fs.readFileSync(full, 'utf8');
      return this.ffmpegCapture(['-i', full, '-f', 'webvtt', 'pipe:1']);
    }
    throw new Error('Unknown subtitle track');
  }

  /**
   * Lazily start the shared transcoding HTTP server (127.0.0.1 only).
   * Routes: GET /transcode/<downloadId>/<fileIndex> → fragmented MP4 / MP3.
   */
  private ensureTranscodeServer(): Promise<number> {
    if (this.transcodeServer) return Promise.resolve(this.transcodePort);
    // Memoize the in-flight bind: transcodeServer is only assigned inside the
    // async listen() callback, so two concurrent first calls would otherwise both
    // pass the guard above, both listen(), and the second would overwrite the
    // reference — orphaning the first server (open socket, never closed).
    if (this.transcodeServerPromise) return this.transcodeServerPromise;
    this.transcodeServerPromise = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleTranscodeRequest(req, res));
      server.on('error', (e) => { this.transcodeServerPromise = null; reject(e); });
      server.listen(0, '127.0.0.1', () => {
        this.transcodeServer = server;
        this.transcodePort = (server.address() as any).port;
        log.info('Transcode server started', { port: this.transcodePort });
        resolve(this.transcodePort);
      });
    });
    return this.transcodeServerPromise;
  }

  private handleTranscodeRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let proc: ChildProcess | null = null;
    let input: NodeJS.ReadableStream | null = null;
    const cleanup = () => {
      if (proc) { this.activeTranscodes.delete(proc); try { proc.kill('SIGKILL'); } catch { /* ignore */ } proc = null; }
      if (input) { try { (input as any).destroy?.(); } catch { /* ignore */ } input = null; }
    };

    try {
      // Reject cross-origin reads and DNS-rebinding: this server is for our own
      // renderer only. The Host header must be the loopback address we serve on;
      // a rebinding attack (evil.com → 127.0.0.1) keeps Host: evil.com and fails
      // here. Any cross-site fetch with an Origin header is denied outright.
      const host = (req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); res.end(); return; }
      if (req.headers.origin) { res.writeHead(403); res.end(); return; }

      const url = new URL(req.url || '', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean); // ['transcode', id, index]
      if (parts[0] !== 'transcode' || parts.length < 3) { res.writeHead(404); res.end(); return; }
      const id = decodeURIComponent(parts[1]);
      const fileIndex = Number(parts[2]);

      const managed = this.managedTorrents.get(id);
      const torrent = managed?.torrent;
      if (!torrent || !torrent.files || fileIndex < 0 || fileIndex >= torrent.files.length) {
        res.writeHead(404); res.end(); return;
      }
      if (!this.ffmpegPath) { res.writeHead(503); res.end('ffmpeg unavailable'); return; }

      const file = torrent.files[fileIndex];
      try { (file as any).select(); } catch { /* ignore */ }
      const kind = classifyMediaKind(file.name);

      const args = kind === 'audio'
        ? ['-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1']
        : [
            '-i', 'pipe:0',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4', 'pipe:1',
          ];

      res.writeHead(200, {
        'Content-Type': kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
        'Cache-Control': 'no-store',
      });

      input = (file as any).createReadStream();
      proc = spawn(this.ffmpegPath, args, { windowsHide: true });
      this.activeTranscodes.add(proc);

      input!.on('error', () => cleanup());
      proc.stdin?.on('error', () => { /* EPIPE when ffmpeg/client ends — ignore */ });
      input!.pipe(proc.stdin!);
      proc.stdout?.pipe(res);
      proc.stderr?.on('data', () => { /* discard ffmpeg progress chatter */ });
      proc.on('error', (e) => { log.warn('ffmpeg error', { error: String(e) }); cleanup(); try { res.destroy(); } catch { /* ignore */ } });
      proc.on('close', () => { if (proc) this.activeTranscodes.delete(proc); });

      res.on('close', cleanup);
      req.on('close', cleanup);
    } catch (e) {
      log.error('Transcode request failed', { error: String(e) });
      cleanup();
      try { res.writeHead(500); res.end(); } catch { /* ignore */ }
    }
  }
  
  /**
   * Get current stats for all managed torrents
   */
  getStats(): DownloadStats[] {
    const stats: DownloadStats[] = [];
    
    for (const managed of this.managedTorrents.values()) {
      const torrent = managed.torrent;
      const download = managed.download;
      
      if (download.status === 'removed') continue;
      
      if (torrent) {
        // Lifetime totals = persisted baseline (from before this instance was
        // attached) + this session's bytes. Prevents the ratio from resetting
        // on pause/resume/recheck/restart.
        //
        // Use torrent.RECEIVED, not torrent.downloaded, for the download side:
        // torrent.downloaded sums verified on-disk pieces, so re-attaching a
        // completed torrent (restart/recheck/auto-move re-verify existing data)
        // makes it jump back to ~full length with zero network transfer — adding
        // that to the persisted baseline DOUBLED the lifetime total every restart.
        // torrent.received counts only bytes actually pulled from peers this
        // session (disk verification never touches it), so base + received stays
        // the true lifetime. (Upload side is already a genuine session counter.)
        const lifetimeDownloaded = (managed.sessionBaseDownloaded || 0) + (torrent.received || 0);
        const lifetimeUploaded = (managed.sessionBaseUploaded || 0) + (torrent.uploaded || 0);
        stats.push({
          id: download.id,
          progress: torrent.progress,
          downloadedBytes: lifetimeDownloaded,
          uploadedBytes: lifetimeUploaded,
          downSpeedBps: torrent.downloadSpeed,
          upSpeedBps: torrent.uploadSpeed,
          etaSeconds: torrent.timeRemaining > 0 ? Math.floor(torrent.timeRemaining / 1000) : null,
          peers: torrent.numPeers,
          // WebTorrent doesn't distinguish seeds from peers; show numPeers when seeding
          seeds: download.status === 'seeding' ? torrent.numPeers : 0,
          status: download.status,
        });
        // Keep the in-memory record in sync with the live torrent. Persisting
        // only updates the store copy; without this, checkSeedingLimits would
        // compute the seed ratio from stale (often zero) byte counters.
        download.progress = torrent.progress;
        download.downloadedBytes = lifetimeDownloaded;
        download.uploadedBytes = lifetimeUploaded;
        download.downSpeedBps = torrent.downloadSpeed;
        download.upSpeedBps = torrent.uploadSpeed;
        download.peers = torrent.numPeers;
      } else {
        stats.push({
          id: download.id,
          progress: download.progress,
          downloadedBytes: download.downloadedBytes,
          uploadedBytes: download.uploadedBytes,
          downSpeedBps: 0,
          upSpeedBps: 0,
          etaSeconds: null,
          peers: 0,
          seeds: 0,
          status: download.status,
        });
      }
    }
    
    return stats;
  }
  
  /**
   * Subscribe to stats updates
   */
  onStats(callback: StatsCallback): () => void {
    this.statsCallbacks.add(callback);
    return () => {
      this.statsCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to download completion events (for OS notifications)
   */
  onComplete(callback: CompletionCallback): () => void {
    this.completionCallbacks.add(callback);
    return () => {
      this.completionCallbacks.delete(callback);
    };
  }

  /** Subscribe to the WebTorrent 'listening' event (TCP port bound). */
  onListening(callback: () => void): () => void {
    this.listeningCallbacks.add(callback);
    return () => { this.listeningCallbacks.delete(callback); };
  }
  
  /**
   * Start periodic stats broadcasting
   */
  private startStatsBroadcast(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.statsInterval = setInterval(async () => {
      // Advance connection slow-start while its window is open (cheap no-op once done).
      if (this.connRampStartAt > 0) this.applyConnectionLimit();

      const stats = this.getStats();

      // Broadcast to callbacks every tick (in-memory, cheap) so the UI stays smooth
      for (const callback of this.statsCallbacks) {
        try {
          callback(stats);
        } catch (e) {
          log.error('Stats callback error', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Persist to disk only every PERSIST_INTERVAL_MS, batched into one write
      const now = Date.now();
      if (now - this.lastPersistAt >= TorrentManager.PERSIST_INTERVAL_MS) {
        this.lastPersistAt = now;
        try {
          await db.updateDownloadsProgressBatch(stats.map(stat => ({
            id: stat.id,
            progress: stat.progress,
            downloadedBytes: stat.downloadedBytes,
            uploadedBytes: stat.uploadedBytes,
            downSpeedBps: stat.downSpeedBps,
            upSpeedBps: stat.upSpeedBps,
            etaSeconds: stat.etaSeconds,
            peers: stat.peers,
            seeds: stat.seeds,
          })));
        } catch (e) {
          log.error('Failed to persist download progress', { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // Check seeding limits (ratio + time)
      await this.checkSeedingLimits();
    }, 750);
 // 750ms interval

    log.debug('Stats broadcast started');
  }
  
  /**
   * Update manager settings
   */
  async updateSettings(settings: {
    maxActiveDownloads?: number;
    maxDownKbps?: number;
    maxUpKbps?: number;
    altSpeedEnabled?: boolean;
    altDownKbps?: number;
    altUpKbps?: number;
    autoMoveEnabled?: boolean;
    autoMovePath?: string;
    defaultSeedRatioLimit?: number;
    defaultSeedTimeLimitMinutes?: number;
    maxConnections?: number;
    maxConnectionsGlobal?: number;
    adaptiveUpload?: boolean;
    dohEnabled?: boolean;
    dohTemplateId?: string;
    dohCustomTemplates?: DohTemplate[];
  }): Promise<void> {
    log.debug('Updating settings', settings);

    let dohDirty = false;
    if (settings.dohEnabled !== undefined) { this.dohEnabled = settings.dohEnabled; dohDirty = true; }
    if (settings.dohTemplateId !== undefined) { this.dohTemplateId = settings.dohTemplateId; dohDirty = true; }
    if (settings.dohCustomTemplates !== undefined) { this.dohCustomTemplates = settings.dohCustomTemplates; dohDirty = true; }
    if (dohDirty) this.applyDohConfig();

    let connDirty = false;
    if (settings.maxConnections !== undefined && settings.maxConnections > 0) { this.maxConnections = settings.maxConnections; connDirty = true; }
    if (settings.maxConnectionsGlobal !== undefined && settings.maxConnectionsGlobal > 0) { this.maxConnectionsGlobal = settings.maxConnectionsGlobal; connDirty = true; }
    if (connDirty) this.applyConnectionLimit();

    // Adaptive upload throttle on/off — takes effect live.
    if (settings.adaptiveUpload !== undefined && settings.adaptiveUpload !== this.adaptiveUploadEnabled) {
      this.adaptiveUploadEnabled = settings.adaptiveUpload;
      if (this.adaptiveUploadEnabled) this.startAdaptiveThrottle();
      else this.stopAdaptiveThrottle();
    }

    if (settings.maxActiveDownloads !== undefined) {
      this.maxActiveDownloads = settings.maxActiveDownloads;
    }
    let speedDirty = false;
    if (settings.maxDownKbps !== undefined) { this.maxDownKbps = settings.maxDownKbps; speedDirty = true; }
    if (settings.maxUpKbps !== undefined) { this.maxUpKbps = settings.maxUpKbps; speedDirty = true; }
    if (settings.altSpeedEnabled !== undefined) { this.altSpeedEnabled = settings.altSpeedEnabled; speedDirty = true; }
    if (settings.altDownKbps !== undefined) { this.altDownKbps = settings.altDownKbps; speedDirty = true; }
    if (settings.altUpKbps !== undefined) { this.altUpKbps = settings.altUpKbps; speedDirty = true; }
    if (speedDirty) this.applySpeedLimits();

    if (settings.autoMoveEnabled !== undefined) this.autoMoveEnabled = settings.autoMoveEnabled;
    if (settings.autoMovePath !== undefined) this.autoMovePath = settings.autoMovePath;

    if (settings.defaultSeedRatioLimit !== undefined) {
      this.defaultSeedRatioLimit = settings.defaultSeedRatioLimit;
    }
    if (settings.defaultSeedTimeLimitMinutes !== undefined) {
      this.defaultSeedTimeLimitMinutes = settings.defaultSeedTimeLimitMinutes;
    }

    await this.processQueue();
  }

  // ── Speed limits (normal vs alternative/"turbo") ──────────────────────────

  /** Manual download cap in bytes/sec (-1 = unlimited), honouring alt mode. */
  private effectiveDownBytes(): number {
    const kbps = this.altSpeedEnabled ? this.altDownKbps : this.maxDownKbps;
    return kbps > 0 ? kbps * 1024 : -1;
  }
  private effectiveUpBytes(): number {
    const kbps = this.altSpeedEnabled ? this.altUpKbps : this.maxUpKbps;
    return kbps > 0 ? kbps * 1024 : -1;
  }

  /** Adaptive throttle governs upload only; download follows the manual cap. */
  private currentDownBytes(): number {
    return this.effectiveDownBytes();
  }
  /** Merge the manual upload cap with the adaptive ceiling: most restrictive
   *  positive value wins; -1 from both means unlimited. */
  private currentUpBytes(): number {
    const manual = this.effectiveUpBytes();
    const adaptive = this.adaptiveUpBytes;
    if (manual > 0 && adaptive > 0) return Math.min(manual, adaptive);
    if (manual > 0) return manual;
    if (adaptive > 0) return adaptive;
    return -1;
  }

  /** Push the current effective limits to the live WebTorrent client. */
  private applySpeedLimits(): void {
    try { (this.client as any).throttleDownload?.(this.currentDownBytes()); } catch (_) { /* unsupported */ }
    try { (this.client as any).throttleUpload?.(this.currentUpBytes()); } catch (_) { /* unsupported */ }
    log.info('Speed limits applied', {
      alt: this.altSpeedEnabled,
      downKbps: this.altSpeedEnabled ? this.altDownKbps : this.maxDownKbps,
      upKbps: this.altSpeedEnabled ? this.altUpKbps : this.maxUpKbps,
      adaptiveUpKBs: this.adaptiveUpBytes > 0 ? Math.round(this.adaptiveUpBytes / 1024) : 'off',
    });
  }

  // ── Adaptive upload throttle (bufferbloat protection) ─────────────────────

  /** Start the latency-driven upload throttle. Idempotent. */
  private startAdaptiveThrottle(): void {
    if (!this.adaptive) {
      this.adaptive = new AdaptiveThrottle({
        getUploadBps: () => {
          try { return (this.client as any)?.uploadSpeed ?? 0; } catch { return 0; }
        },
        onCap: (bytes) => {
          this.adaptiveUpBytes = bytes;
          this.applySpeedLimits();
        },
      });
    }
    this.adaptive.start();
  }

  /** Stop the throttle and clear any adaptive cap so manual limits alone apply. */
  private stopAdaptiveThrottle(): void {
    this.adaptive?.stop();
    this.adaptiveUpBytes = -1;
    this.applySpeedLimits();
  }

  /** Recompute the active DoH resolver URL from current state and apply it. */
  private applyDohConfig(): void {
    const url = resolveActiveDohUrl(
      { dohEnabled: this.dohEnabled, dohTemplateId: this.dohTemplateId },
      this.dohCustomTemplates,
    );
    configureDoh({ enabled: this.dohEnabled, url });
  }

  /** One-click toggle of the alternative ("turbo"/turtle) speed limits. */
  async setAltSpeed(enabled: boolean): Promise<{ altSpeedEnabled: boolean }> {
    await this.whenReady();
    this.altSpeedEnabled = enabled;
    this.applySpeedLimits();
    await db.updateSettings({ altSpeedEnabled: enabled } as any);
    return { altSpeedEnabled: enabled };
  }

  /** Current alt-speed state (for the toolbar/tray toggle to read on load). */
  isAltSpeedEnabled(): boolean { return this.altSpeedEnabled; }

  /** Live snapshot for the adaptive-throttle indicator in the UI. */
  getNetworkHealth(): NetworkHealth {
    const st = this.adaptive?.getState() ?? null;
    let uploadBps = 0;
    try { uploadBps = (this.client as any)?.uploadSpeed ?? 0; } catch { /* client not up yet */ }
    return {
      adaptive: {
        active: this.adaptiveUploadEnabled && !!st?.active,
        latencyMs: st?.latencyMs ?? null,
        baselineMs: st?.baselineMs != null ? Math.round(st.baselineMs) : null,
        capKbps: st && st.capBytes > 0 ? Math.round(st.capBytes / 1024) : -1,
        congested: st?.congested ?? false,
      },
      uploadBps,
    };
  }

  // ============================================================
  // Priority 1: New Engine Features
  // ============================================================

  /**
   * Toggle sequential download mode (download pieces in order, e.g. for
   * progressive playback). WebTorrent's piece picker reads `torrent.strategy`
   * on every request cycle: 'rarest' → rarity-based (the healthy default for a
   * normal download), anything else → in-order selection (lib/torrent.js
   * trySelectWire). Flipping the property takes effect on the next request, so
   * there's nothing else to trigger — and we no longer re-select files (which
   * would clobber the user's per-file "skip" choices) or mark every piece
   * critical (which defeats hotswap).
   */
  async setSequentialDownload(id: string, enabled: boolean): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.sequentialDownload = enabled;
    await db.updateDownloadField(id, 'sequentialDownload', enabled);

    if (managed.torrent) {
      this.applyStrategy(managed.torrent, enabled);
    }

    log.info('Sequential download set', { id, enabled });
  }

  /**
   * Apply the piece-picking strategy for a torrent. Always set explicitly
   * (WebTorrent 1.9.7 defaults new torrents to 'sequential'); a normal download
   * should be rarest-first for swarm health unless the user opted into
   * sequential. Called on toggle and whenever a torrent instance is (re)attached.
   */
  private applyStrategy(torrent: Torrent, sequential: boolean): void {
    try {
      (torrent as any).strategy = sequential ? 'sequential' : 'rarest';
    } catch (_) { /* property unsupported on this version — best effort */ }
  }

  /**
   * Set per-file download priority.
   * 'skip' = deselect (don't download), others = select.
   */
  async setFilePriority(id: string, fileIndex: number, priority: FilePriority): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    // Persist priority
    const priorities = managed.download.filePriorities ?? [];
    priorities[fileIndex] = priority;
    managed.download.filePriorities = priorities;
    await db.updateDownloadField(id, 'filePriorities', priorities);

    if (managed.torrent) {
      const torrent = managed.torrent;
      const file: any = torrent.files[fileIndex];
      if (file) {
        // Clear this file's previous priority selection(s) so repeated changes
        // don't pile up duplicate entries in torrent._selections. We only touch
        // OUR known priority levels — never priority 0 (webtorrent's default
        // whole-torrent selection), so a single-file torrent's base download
        // isn't accidentally dropped.
        const start = file._startPiece, end = file._endPiece;
        if (typeof start === 'number' && typeof end === 'number') {
          for (const pr of [FILE_PRIORITY_LOW, FILE_PRIORITY_NORMAL, FILE_PRIORITY_HIGH]) {
            try { (torrent as any).deselect(start, end, pr); } catch { /* ignore */ }
          }
        }
        if (priority === 'skip') {
          file.deselect();
          log.info('File deselected (skip)', { id, fileIndex, name: file.name });
        } else {
          // Map to a real webtorrent selection priority. The piece picker sorts
          // _selections by priority descending (torrent.js), so a 'high' file's
          // pieces are requested before a 'low' file's — instead of every
          // non-skip file being identical as before. All levels are >0, so they
          // still beat the default whole-torrent selection and do download.
          const prio = priority === 'high' ? FILE_PRIORITY_HIGH
            : priority === 'low' ? FILE_PRIORITY_LOW
            : FILE_PRIORITY_NORMAL;
          file.select(prio);
          log.info('File selected', { id, fileIndex, name: file.name, priority, prio });
        }
      }
    }
  }

  // NOTE: there is deliberately NO setTorrentSpeedLimits. webtorrent 1.9.7 only
  // throttles GLOBALLY (client-level ThrottleGroups baked into every peer at
  // creation), so a per-torrent limit cannot be enforced. The old method stored a
  // value the UI showed as active while the engine ignored it — a placebo, now
  // removed. Only the global / alt-speed limits (which work) remain.

  /**
   * Set seed ratio limit for a specific torrent.
   * 0 = unlimited (use global default).
   */
  async setSeedRatioLimit(id: string, ratio: number): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.seedRatioLimit = ratio;
    await db.updateDownloadField(id, 'seedRatioLimit', ratio);
    log.info('Seed ratio limit set', { id, ratio });
  }

  /**
   * Set seed time limit for a specific torrent.
   * 0 = unlimited.
   */
  async setSeedTimeLimit(id: string, minutes: number): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.seedTimeLimitMinutes = minutes;
    await db.updateDownloadField(id, 'seedTimeLimitMinutes', minutes);
    log.info('Seed time limit set', { id, minutes });
  }

  /**
   * Snapshot of currently-connected peers for a torrent (for the Peers tab).
   * Reads WebTorrent's live wires: address, decoded client, connection type,
   * live speeds, transferred bytes, the peer's download progress, and the
   * choke/interest flags. Returns [] when the torrent isn't active.
   */
  getPeers(id: string): PeerInfo[] {
    const managed = this.managedTorrents.get(id);
    const torrent = managed?.torrent as any;
    if (!torrent) return [];

    const numPieces: number = Array.isArray(torrent.pieces) ? torrent.pieces.length : 0;
    const peerMap = torrent._peers || {};
    const out: PeerInfo[] = [];

    for (const key of Object.keys(peerMap)) {
      const peer = peerMap[key];
      const wire = peer?.wire;
      const rawAddress: string = peer?.addr || wire?.remoteAddress || '';
      if (!wire || !rawAddress) continue; // only fully-connected peers

      // Strip the IPv4-mapped-IPv6 prefix (incoming TCP shows ::ffff:1.2.3.4).
      const address = rawAddress.replace(/^::ffff:/i, '');

      out.push({
        address,
        client: clientFromWire(wire),
        connType: normalizeConnType(wire.type || peer.type),
        downSpeed: safeSpeed(wire.downloadSpeed),
        upSpeed: safeSpeed(wire.uploadSpeed),
        downloaded: Number(wire.downloaded) || 0,
        uploaded: Number(wire.uploaded) || 0,
        progress: peerProgress(wire, numPieces),
        flags: {
          interested: !!wire.amInterested,
          choking: !!wire.amChoking,
          peerInterested: !!wire.peerInterested,
          peerChoking: !!wire.peerChoking,
        },
      });
    }

    // Fastest peers first — most relevant to the user.
    out.sort((a, b) => (b.downSpeed + b.upSpeed) - (a.downSpeed + a.upSpeed));
    return out;
  }

  /**
   * Aggregate every active torrent's connected peers by country for the live
   * swarm world map. Resolution is done fully offline (a country-level IP DB),
   * so no peer IP ever leaves the machine — the renderer only receives country
   * codes and counts, never addresses. IPv6 and private/unroutable peers are
   * counted in the total but left unresolved (the DB is IPv4 public-only).
   */
  getSwarmGeo(): SwarmGeo {
    this.ensureGeoInit();
    const byCountry = new Map<string, { count: number; downBps: number; upBps: number; seeds: number }>();
    let totalConns = 0;
    let resolved = 0;
    let torrents = 0;

    for (const managed of this.managedTorrents.values()) {
      if (!managed.torrent) continue;
      const peers = this.getPeers(managed.id);
      if (peers.length > 0) torrents++;
      for (const p of peers) {
        totalConns++;
        const cc = this.lookupCountry(p.address);
        if (!cc) continue;
        resolved++;
        const e = byCountry.get(cc) || { count: 0, downBps: 0, upBps: 0, seeds: 0 };
        e.count++;
        e.downBps += p.downSpeed;
        e.upBps += p.upSpeed;
        if (p.progress >= 0.999) e.seeds++;
        byCountry.set(cc, e);
      }
    }

    const points: SwarmGeoPoint[] = [];
    for (const [country, e] of byCountry) points.push({ country, ...e });
    points.sort((a, b) => b.count - a.count);
    return { points, totalConns, resolved, torrents };
  }

  /** Lazily initialize the offline country DB (CPU-ish, one-time). */
  private ensureGeoInit(): void {
    if (this.geoReady) return;
    try { ip3country.init(); this.geoReady = true; }
    catch (e) { log.warn('Country geo DB init failed (swarm map degraded)', { error: String(e) }); }
  }

  /**
   * Peer address → ISO country code, or null (IPv6/private/unknown).
   * NOTE: getPeers() returns "ip:port" (peer.addr keeps the port), so the port
   * must be split off before the lookup — a naive "contains ':' ⇒ IPv6" guard
   * here used to reject EVERY peer and left the swarm map permanently empty.
   */
  private lookupCountry(addr: string): string | null {
    if (!this.geoReady || !addr) return null;
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(addr);
    if (!m) return null; // IPv6 or hostname — the country DB is IPv4-only
    const ip = m[1];
    if (isPrivateOrReservedIPv4(ip)) return null;
    try {
      const cc = ip3country.lookupStr(ip);
      return cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null;
    } catch { return null; }
  }

  /**
   * Subscribe to a torrent's tracker client so we capture per-tracker scrape
   * data (seeders/leechers, last-announce time) keyed by announce URL. Idempotent
   * per client instance — re-hooks when the torrent (and thus its tracker client)
   * is recreated on pause/resume.
   */
  private attachTrackerListeners(managed: ManagedTorrent): void {
    const client = (managed.torrent as any)?.discovery?.tracker;
    if (!client || managed.trackerHookedClient === client) return;
    managed.trackerHookedClient = client;
    if (!managed.trackerStats) managed.trackerStats = new Map();

    const record = (data: any): void => {
      const url = data?.announce;
      if (typeof url !== 'string') return;
      managed.trackerStats!.set(url, {
        complete: Number(data.complete) || 0,
        incomplete: Number(data.incomplete) || 0,
        lastAnnounce: Date.now(),
      });
    };

    try {
      client.on('update', record);
      client.on('scrape', record);
    } catch (_) { /* tracker client without EventEmitter — ignore */ }
  }

  /**
   * Get current tracker info for a torrent. Reads the live tracker client
   * (torrent.discovery.tracker._trackers) — the previous code read a
   * non-existent torrent._trackers and reported a fake "connected" status from a
   * method reference. Status now reflects real state:
   *   • error      — the tracker connection was destroyed
   *   • connected  — announced OK and a re-announce interval is scheduled
   *   • updating   — added but no successful announce yet
   * Peer counts come from cached scrape data (see attachTrackerListeners).
   */
  getTrackers(id: string): TrackerInfo[] {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) return [];

    try {
      // Ensure scrape data is being captured (lazy — hooks on first read).
      this.attachTrackerListeners(managed);

      const trackers: any[] = (managed.torrent as any).discovery?.tracker?._trackers ?? [];
      return trackers.map((t: any): TrackerInfo => {
        const url = t.announceUrl || t.announce || String(t);
        const stat = managed.trackerStats?.get(url);
        let status: TrackerInfo['status'];
        if (t.destroyed) status = 'error';
        else if (t.interval) status = 'connected';
        else status = 'updating';
        return {
          url,
          status,
          peers: stat ? stat.complete + stat.incomplete : 0,
          lastAnnounce: stat ? stat.lastAnnounce : undefined,
        };
      });
    } catch (_) {
      return [];
    }
  }

  /** Strip a single trailing slash so URLs dedupe the way bittorrent-tracker does. */
  private stripTrailingSlash(url: string): string {
    const s = String(url || '').trim();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  }

  /** Validate + normalize a tracker URL, or throw a clear error. */
  private normalizeTrackerUrl(raw: string): string {
    const url = String(raw || '').trim();
    if (!url) throw new TorrentError('Tracker URL is empty', 'INVALID_INPUT');
    let proto: string;
    try { proto = new URL(url).protocol; } catch { throw new TorrentError('Invalid tracker URL', 'INVALID_INPUT'); }
    if (!['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(proto)) {
      throw new TorrentError('Unsupported tracker protocol (use http/https/udp/ws)', 'INVALID_INPUT');
    }
    return this.stripTrailingSlash(url);
  }

  /** The bittorrent-tracker client class for a URL's protocol (or null). */
  private trackerClassFor(url: string): any | null {
    let proto = '';
    try { proto = new URL(url).protocol; } catch { return null; }
    try {
      // bittorrent-tracker has no `exports` map, so deep requires resolve fine.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (proto === 'http:' || proto === 'https:') return require('bittorrent-tracker/lib/client/http-tracker.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (proto === 'udp:') return require('bittorrent-tracker/lib/client/udp-tracker.js');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (proto === 'ws:' || proto === 'wss:') return require('bittorrent-tracker/lib/client/websocket-tracker.js');
    } catch (_) { return null; }
    return null;
  }

  /** Attach a tracker to the live tracker client and announce immediately. */
  private applyTrackerLive(managed: ManagedTorrent, url: string): void {
    const client: any = (managed.torrent as any)?.discovery?.tracker;
    if (!client || !Array.isArray(client._trackers)) return; // not active — applies on next start
    if (client._trackers.some((t: any) => this.stripTrailingSlash(t.announceUrl) === url)) return;
    const TrackerClass = this.trackerClassFor(url);
    if (!TrackerClass) return;
    try {
      const tracker = new TrackerClass(client, url);
      client._trackers.push(tracker);
      // Kick an immediate announce so peers start flowing without waiting a cycle.
      try { tracker.announce(client._defaultAnnounceOpts({})); } catch (_) { /* announces on next cycle */ }
      log.info('Tracker attached live', { id: managed.id, url });
    } catch (e) {
      log.warn('Live tracker add failed (applies on restart)', { id: managed.id, url, error: String(e) });
    }
  }

  /** Destroy any live trackers the user has marked removed (called after add). */
  private pruneRemovedTrackersLive(managed: ManagedTorrent): void {
    const removed = managed.download.removedTrackers;
    if (!removed || removed.length === 0) return;
    const client: any = (managed.torrent as any)?.discovery?.tracker;
    if (!client || !Array.isArray(client._trackers)) return;
    const removedSet = new Set(removed.map((u) => this.stripTrailingSlash(u)));
    for (let i = client._trackers.length - 1; i >= 0; i--) {
      const t = client._trackers[i];
      if (removedSet.has(this.stripTrailingSlash(t.announceUrl))) {
        try { t.destroy?.(() => { /* noop */ }); } catch (_) { /* ignore */ }
        client._trackers.splice(i, 1);
      }
    }
  }

  /**
   * Add a tracker URL. Persists it (merged into the announce list on every
   * (re)start via the `announce` add-option) and attaches it to the live torrent
   * immediately if active. webtorrent 1.x Torrents have no addTracker(), so this
   * operates on the underlying bittorrent-tracker client directly.
   */
  async addTracker(id: string, url: string): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);
    const normalized = this.normalizeTrackerUrl(url);

    const custom = new Set(managed.download.customTrackers ?? []);
    custom.add(normalized);
    const removed = new Set(managed.download.removedTrackers ?? []);
    removed.delete(normalized);
    managed.download.customTrackers = [...custom];
    managed.download.removedTrackers = [...removed];
    await db.updateDownloadFields(id, {
      customTrackers: managed.download.customTrackers,
      removedTrackers: managed.download.removedTrackers,
    });

    this.applyTrackerLive(managed, normalized);
    log.info('Tracker added', { id, url: normalized });
  }

  /**
   * Remove a tracker URL. Persists the removal (pruned from the live client after
   * each start) and destroys it on the live torrent now. Works for both
   * user-added and metadata trackers.
   */
  async removeTracker(id: string, url: string): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);
    const normalized = this.stripTrailingSlash(url);

    const custom = new Set(managed.download.customTrackers ?? []);
    custom.delete(normalized);
    const removed = new Set(managed.download.removedTrackers ?? []);
    removed.add(normalized);
    managed.download.customTrackers = [...custom];
    managed.download.removedTrackers = [...removed];
    await db.updateDownloadFields(id, {
      customTrackers: managed.download.customTrackers,
      removedTrackers: managed.download.removedTrackers,
    });

    const client: any = (managed.torrent as any)?.discovery?.tracker;
    if (client && Array.isArray(client._trackers)) {
      for (let i = client._trackers.length - 1; i >= 0; i--) {
        const t = client._trackers[i];
        if (this.stripTrailingSlash(t.announceUrl) === normalized) {
          try { t.destroy?.(() => { /* noop */ }); } catch (_) { /* ignore */ }
          client._trackers.splice(i, 1);
        }
      }
    }
    managed.trackerStats?.delete(normalized);
    log.info('Tracker removed', { id, url: normalized });
  }

  /**
   * Check seeding limits (ratio + time) for all seeding torrents.
   * Called every stats tick.
   */
  private async checkSeedingLimits(): Promise<void> {
    const defaults = { ratioLimit: this.defaultSeedRatioLimit, timeLimitMinutes: this.defaultSeedTimeLimitMinutes };
    const now = Date.now();
    for (const managed of this.managedTorrents.values()) {
      if (managed.download.status !== 'seeding') continue;
      // Decision extracted to shared/seeding-limits (pure + unit-tested).
      const { stop, reason } = shouldStopSeeding(managed.download, defaults, now);
      if (!stop) continue;
      log.info('Auto-stopped seeding', { id: managed.id, reason });
      try { await this.stopSeeding(managed.id); } catch (_) { /* already stopped */ }
    }
  }

  
  /**
   * Destroy the manager (cleanup on app quit)
   */
  async destroy(): Promise<void> {
    log.info('Destroying TorrentManager');

    if (this.adaptive) {
      this.adaptive.stop();
      this.adaptive = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    
    // Clear all stats callbacks to prevent memory leaks
    this.statsCallbacks.clear();

    // Close any open streaming servers
    for (const managed of this.managedTorrents.values()) {
      this.closeStreamServer(managed);
    }

    // Kill active transcodes and close the transcode server
    for (const proc of this.activeTranscodes) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.activeTranscodes.clear();
    if (this.transcodeServer) {
      try { this.transcodeServer.close(); } catch { /* ignore */ }
      this.transcodeServer = null;
    }
    this.transcodeServerPromise = null;

    // Save final stats (single batched write, speeds zeroed since we're stopping)
    try {
      const stats = this.getStats();
      await db.updateDownloadsProgressBatch(stats.map(stat => ({
        id: stat.id,
        progress: stat.progress,
        downloadedBytes: stat.downloadedBytes,
        uploadedBytes: stat.uploadedBytes,
        downSpeedBps: 0,
        upSpeedBps: 0,
        etaSeconds: null,
        peers: 0,
        seeds: 0,
      })));
    } catch (e) {
      log.error('Failed to persist final progress', { error: e instanceof Error ? e.message : String(e) });
    }
    
    // Clear all managed torrents and indices
    this.managedTorrents.clear();
    this.infoHashIndex.clear();
    
    return new Promise((resolve) => {
      this.client.destroy((err) => {
        if (err) {
          log.error('Error destroying WebTorrent client', { error: String(err) });
        }
        log.info('TorrentManager destroyed');
        resolve();
      });
    });
  }
}

// NOTE: no getTorrentManager() singleton here. The real manager is instantiated
// by the torrent-host utilityProcess (new TorrentManager()); the main process uses
// the proxy from ./host/manager-proxy. Importing this file is value-importing
// WebTorrent, so only the host may do it.
