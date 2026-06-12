import WebTorrent, { Torrent } from 'webtorrent';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { app } from 'electron';
import {
  Download,
  DownloadStatus,
  DownloadStats,
  SourceType,
  TorrentFile,
  FilePriority,
  TrackerInfo,
  PeerInfo,
} from '../../shared/types';
import {
  isValidTransition,
  InvalidStateTransitionError,
  canPause,
  canResume,
  canRecheck,
  isActiveState,
} from '../../shared/state-machine';
import * as db from '../db/store';
import { logger, checkDiskSpace, formatBytes } from '../utils';
import { classifyMediaKind, isDirectlyPlayable } from '../../shared/media';
import { spawn, ChildProcess } from 'child_process';

// ffmpeg-static ships a platform binary; in a packaged app it lives in
// app.asar.unpacked (it can't execute from inside the asar archive).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegStaticPath = require('ffmpeg-static') as string | null;
function resolveFfmpegPath(): string | null {
  if (!ffmpegStaticPath) return null;
  return app.isPackaged
    ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStaticPath;
}

const log = logger.child('TorrentManager');

// ── Peer helpers (used by getPeers) ────────────────────────────────────────

// Azureus-style peer-id prefixes → human client names.
const CLIENT_CODES: Record<string, string> = {
  QB: 'qBittorrent', UT: 'µTorrent', UM: 'µTorrent Mac', UE: 'µTorrent Embedded',
  TR: 'Transmission', DE: 'Deluge', LT: 'libtorrent', lt: 'libTorrent',
  TH: 'TorrentHunt', AZ: 'Azureus / Vuze', BT: 'BitTorrent', BC: 'BitComet',
  KT: 'KTorrent', FD: 'Free Download Manager', WW: 'WebTorrent', WD: 'WebTorrent',
  WT: 'BitTornado', TX: 'Tixati', RT: 'rTorrent', qB: 'qBittorrent',
};

// 256-entry popcount table for fast peer-progress from a BitField buffer.
const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
  return t;
})();

/** Decode a remote client name from the extended handshake or the peer id. */
function clientFromWire(wire: any): string | undefined {
  const v = wire?.peerExtendedHandshake?.v;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return clientFromPeerId(wire?.peerId);
}

function clientFromPeerId(hex: unknown): string | undefined {
  if (typeof hex !== 'string' || !hex) return undefined;
  let ascii: string;
  try { ascii = Buffer.from(hex, 'hex').toString('latin1'); } catch { return undefined; }
  const m = ascii.match(/^-([A-Za-z]{2})(\d)(\d)(\d)(\d)-/);
  if (m) {
    const name = CLIENT_CODES[m[1]] || CLIENT_CODES[m[1].toUpperCase()] || m[1];
    return `${name} ${m[2]}.${m[3]}.${m[4]}`;
  }
  return undefined;
}

/** Peer's download progress (0..1) via popcount over its piece bitfield. */
function peerProgress(wire: any, numPieces: number): number {
  if (!numPieces) return 0;
  const pp = wire?.peerPieces;
  if (!pp) return 0;
  const buf = pp.buffer as Uint8Array | undefined;
  if (buf && buf.length) {
    let bits = 0;
    for (let i = 0; i < buf.length; i++) bits += POPCOUNT[buf[i]];
    return Math.min(1, bits / numPieces);
  }
  // HaveAll/HaveNone bitfields expose no buffer — sample the ends.
  if (typeof pp.get === 'function') return pp.get(0) ? 1 : 0;
  return 0;
}

/** WebTorrent speedometer() → bytes/sec, defensively. */
function safeSpeed(fn: unknown): number {
  try { return typeof fn === 'function' ? Math.max(0, Math.round((fn as () => number)())) : 0; }
  catch { return 0; }
}

/** Normalize WebTorrent's connection type to a small enum the UI understands. */
function normalizeConnType(type: unknown): PeerInfo['connType'] {
  switch (type) {
    case 'tcpIncoming': return 'tcp-in';
    case 'tcpOutgoing': return 'tcp-out';
    case 'utpIncoming': return 'utp-in';
    case 'utpOutgoing': return 'utp-out';
    case 'webrtc': return 'webrtc';
    case 'webSeed': return 'web-seed';
    default: return 'other';
  }
}

interface ManagedTorrent {
  id: string;
  torrent: Torrent | null;
  download: Download;
  infoHash: string | null;
  selectedFiles?: number[];
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
}

type StatsCallback = (stats: DownloadStats[]) => void;
type CompletionCallback = (info: { id: string; name: string }) => void;


/**
 * Error class for torrent operation failures
 */
export class TorrentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly downloadId?: string
  ) {
    super(message);
    this.name = 'TorrentError';
  }
}

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
  private maxActiveDownloads = 3;
  private maxDownKbps = 0;
  private maxUpKbps = 0;
  // Alternative ("turbo"/turtle) speed limits and whether they're active.
  private altSpeedEnabled = false;
  private altDownKbps = 0;
  private altUpKbps = 0;
  // Auto-move completed downloads to this folder, then re-seed from there.
  private autoMoveEnabled = false;
  private autoMovePath = '';
  // Guards re-entrant auto-move while a torrent is being relocated.
  private movingIds: Set<string> = new Set();
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
    const digits = app.getVersion().replace(/\D/g, '').padEnd(4, '0').slice(0, 4);
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

    log.debug('Settings loaded', {
      maxActiveDownloads: this.maxActiveDownloads,
      maxDownKbps: this.maxDownKbps,
      maxUpKbps: this.maxUpKbps,
    });

    // Use an ephemeral, non-identifying BitTorrent peer ID. It carries the
    // TorrentHunt client prefix (-TH<version>-) followed by random bytes that
    // rotate every launch, so peers can't correlate sessions long-term.
    //
    // utp: false — disable µTP transport. The native utp-native module throws
    // uncaught "no buffer space available" (WSAENOBUFS) errors on Windows under
    // load, which crash the main process. Plain TCP is stable and universal.
    //
    // dht / maxConns / torrentPort / download+uploadLimit come from Settings →
    // Advanced. (PEX can't be toggled in WebTorrent; LSD isn't implemented.)
    this.configuredPort = settings.portMin > 0 ? settings.portMin : 0;
    this.client = new WebTorrent({
      peerId: this.generateEphemeralPeerId(),
      utp: false,
      dht: settings.enableDHT !== false,
      maxConns: settings.maxConnections > 0 ? settings.maxConnections : 100,
      torrentPort: this.configuredPort,
      // -1 = unlimited (0 would mean "0 bytes/sec" and stall all traffic).
      // Effective limits honour the alternative-speed toggle.
      downloadLimit: this.effectiveDownBytes(),
      uploadLimit: this.effectiveUpBytes(),
    } as any);

    this.client.on('error', (err: string | Error) => {
      log.error('WebTorrent client error', { error: err });
    });

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

    // Re-add the active torrents in parallel. Doing this serially meant a single
    // magnet with no peers blocked the whole restore for up to METADATA_TIMEOUT_MS
    // (and N dead magnets blocked it N×). restoreTorrent never rejects (it logs
    // and transitions to 'error' on its own), so allSettled bounds the wait to
    // the single slowest torrent instead of their sum.
    const restorePromises: Promise<void>[] = [];
    for (const download of activeDownloads) {
      if (['downloading', 'seeding', 'queued'].includes(download.status)) {
        restorePromises.push(this.restoreTorrent(download));
      }
    }
    await Promise.allSettled(restorePromises);

    // Start stats broadcasting
    this.startStatsBroadcast();

    // Process queue
    await this.processQueue();

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
   * Extract infoHash from a magnet URI, normalized to lowercase hex.
   * Magnets may carry the hash as 40-char hex OR 32-char base32 — WebTorrent
   * normalizes to hex internally, so we must too or duplicate detection misses.
   */
  private extractInfoHashFromMagnet(magnetUri: string): string | null {
    try {
      const match = magnetUri.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      if (!match) return null;
      const hash = match[1];
      if (/^[a-fA-F0-9]{40}$/.test(hash)) return hash.toLowerCase();
      if (/^[a-zA-Z2-7]{32}$/.test(hash)) return this.base32ToHex(hash);
      return null;
    } catch (err) {
      return null;
    }
  }

  /** Decode an RFC 4648 base32 infohash (32 chars) to 40-char lowercase hex. */
  private base32ToHex(b32: string): string | null {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of b32.toUpperCase()) {
      const idx = alphabet.indexOf(ch);
      if (idx === -1) return null;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return bytes.length === 20 ? Buffer.from(bytes).toString('hex') : null;
  }

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

        tempClient.add(sourceInput, { path: app.getPath('temp') }, (torrent) => {
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
          headers: { 'User-Agent': `TorrentHunt/${app.getVersion()}`, 'Accept': 'application/x-bittorrent, */*' },
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
      infoHashToCheck = this.extractInfoHashFromMagnet(params.sourceUri);
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
        // Check index first
        const existingId = this.infoHashIndex.get(infoHashToCheck);
        if (existingId) {
          const existing = this.managedTorrents.get(existingId);
          if (existing && existing.download.status !== 'removed') {
            const errorMessage = `This torrent is already in downloads: "${existing.download.name}"`;
            log.warn('Duplicate torrent rejected (by infoHash index)', {
              infoHash: infoHashToCheck,
              existingId,
              existingName: existing.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
        }

        // Also check all managed torrents directly (in case index is out of sync)
        for (const [existingId, managed] of this.managedTorrents.entries()) {
          if (managed.download.status === 'removed') continue;
          if (managed.infoHash === infoHashToCheck) {
            const errorMessage = `This torrent is already in downloads: "${managed.download.name}"`;
            log.warn('Duplicate torrent rejected (by managed torrents scan)', {
              infoHash: infoHashToCheck,
              existingId,
              existingName: managed.download.name
            });
            throw new TorrentError(errorMessage, 'DUPLICATE');
          }
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

      const settings = await db.getSettings();
      const savePath = params.savePath || settings.defaultDownloadDir;

      // Ensure save directory exists
      if (!fs.existsSync(savePath)) {
        fs.mkdirSync(savePath, { recursive: true });
      }

      // Check available disk space
      const availableSpace = await checkDiskSpace(savePath);
      const minimumRequired = 100 * 1024 * 1024; // 100 MB minimum

      if (availableSpace !== null && availableSpace < minimumRequired) {
        const errorMessage = `Not enough disk space. Available: ${formatBytes(availableSpace)}, minimum required: ${formatBytes(minimumRequired)}`;
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
        const appDataDir = path.join(app.getPath('userData'), 'torrents');
        if (!fs.existsSync(appDataDir)) {
          fs.mkdirSync(appDataDir, { recursive: true });
        }

        const fileName = path.basename(localTorrentPath);
        torrentFilePath = path.join(appDataDir, `${Date.now()}_${fileName}`);
        fs.copyFileSync(localTorrentPath, torrentFilePath);
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

      // Process queue to potentially start this download
      await this.processQueue();

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
      
      // If selectedFiles is provided, configure file selection
      if (selectedFiles && selectedFiles.length > 0) {
        log.info('Adding torrent with selective file download', {
          id,
          selectedCount: selectedFiles.length,
        });
      }

      const torrent = this.client.add(torrentInput, addOptions);

      managed.torrent = torrent;
      // Snapshot lifetime totals so this session's bytes add onto them rather
      // than overwriting them (see ManagedTorrent.sessionBase* docs).
      managed.sessionBaseDownloaded = managed.download.downloadedBytes || 0;
      managed.sessionBaseUploaded = managed.download.uploadedBytes || 0;

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

        // Update database with torrent metadata
        if (isNew || managed.download.name === 'Loading...') {
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
        if (managed.download.status === 'downloading') {
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
        }
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

      if (managed && !managed.torrent) {
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
    
    // Destroy the WebTorrent instance to actually stop data transfer.
    // WebTorrent 1.9.7 does not reliably support torrent.pause().
    // Data on disk is preserved (destroyStore: false).
    if (managed.torrent) {
      log.debug('Destroying torrent instance for pause', { id, infoHash: managed.infoHash });
      this.closeStreamServer(managed);
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (e) {
        log.warn('Error destroying torrent during pause (non-fatal)', { error: String(e) });
      }
      managed.torrent = null;
    }

    await this.transitionStatus(id, 'paused');

    // Process queue to start next download
    await this.processQueue();

    log.debug('Download paused successfully', { id });
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
      // Torrent still in memory but shouldn't be — destroy it cleanly first
      log.debug('Torrent still in memory on resume, destroying first', { id });
      this.closeStreamServer(managed);
      try {
        managed.torrent.destroy({ destroyStore: false } as any);
      } catch (_) { /* ignore */ }
      managed.torrent = null;
    }

    // Re-queue the download so processQueue will re-add it to WebTorrent
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
    
    // Remove from infoHash index
    if (managed.infoHash) {
      this.infoHashIndex.delete(managed.infoHash);
    }

    // Stop any active stream server first
    this.closeStreamServer(managed);

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
    }
    
    // Delete files if requested
    if (deleteFiles) {
      // Wait a bit for file handles to be released
      await new Promise(resolve => setTimeout(resolve, 500));

      const downloadPath = managed.download.savePath;
      if (fs.existsSync(downloadPath)) {
        const downloadName = managed.download.name;
        const targetPath = path.join(downloadPath, downloadName);

        if (fs.existsSync(targetPath)) {
          await this.deletePathRecursive(targetPath, id);
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
        const dir = path.join(app.getPath('userData'), 'torrents');
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
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleTranscodeRequest(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.transcodeServer = server;
        this.transcodePort = (server.address() as any).port;
        log.info('Transcode server started', { port: this.transcodePort });
        resolve(this.transcodePort);
      });
    });
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
        const lifetimeDownloaded = (managed.sessionBaseDownloaded || 0) + (torrent.downloaded || 0);
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
  
  /**
   * Start periodic stats broadcasting
   */
  private startStatsBroadcast(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    this.statsInterval = setInterval(async () => {
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
  }): Promise<void> {
    log.debug('Updating settings', settings);

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

  /** Effective download cap in bytes/sec (-1 = unlimited), honouring alt mode. */
  private effectiveDownBytes(): number {
    const kbps = this.altSpeedEnabled ? this.altDownKbps : this.maxDownKbps;
    return kbps > 0 ? kbps * 1024 : -1;
  }
  private effectiveUpBytes(): number {
    const kbps = this.altSpeedEnabled ? this.altUpKbps : this.maxUpKbps;
    return kbps > 0 ? kbps * 1024 : -1;
  }

  /** Push the current effective limits to the live WebTorrent client. */
  private applySpeedLimits(): void {
    try { (this.client as any).throttleDownload?.(this.effectiveDownBytes()); } catch (_) { /* unsupported */ }
    try { (this.client as any).throttleUpload?.(this.effectiveUpBytes()); } catch (_) { /* unsupported */ }
    log.info('Speed limits applied', {
      alt: this.altSpeedEnabled,
      downKbps: this.altSpeedEnabled ? this.altDownKbps : this.maxDownKbps,
      upKbps: this.altSpeedEnabled ? this.altUpKbps : this.maxUpKbps,
    });
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
      const file = managed.torrent.files[fileIndex];
      if (file) {
        if (priority === 'skip') {
          file.deselect();
          log.info('File deselected (skip)', { id, fileIndex, name: file.name });
        } else {
          file.select();
          log.info('File selected', { id, fileIndex, name: file.name, priority });
        }
      }
    }
  }

  /**
   * Set per-torrent speed limits (overrides global limits for this torrent).
   */
  async setTorrentSpeedLimits(id: string, downKbps: number, upKbps: number): Promise<void> {
    await this.whenReady();
    const managed = this.managedTorrents.get(id);
    if (!managed) throw new TorrentError('Download not found', 'NOT_FOUND', id);

    managed.download.maxDownloadSpeed = downKbps;
    managed.download.maxUploadSpeed = upKbps;
    await db.updateDownloadFields(id, { maxDownloadSpeed: downKbps, maxUploadSpeed: upKbps });

    if (managed.torrent) {
      try {
        (managed.torrent as any).throttleDownload?.(downKbps > 0 ? downKbps * 1024 : 0);
      } catch (_) { /* unsupported */ }
      try {
        (managed.torrent as any).throttleUpload?.(upKbps > 0 ? upKbps * 1024 : 0);
      } catch (_) { /* unsupported */ }
    }

    log.info('Per-torrent speed limits set', { id, downKbps, upKbps });
  }

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

  /** Short "Ns/Nm/Nh ago" string for the last-announce timestamp. */
  private relativeTime(ts: number): string {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
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
          lastAnnounce: stat ? this.relativeTime(stat.lastAnnounce) : undefined,
        };
      });
    } catch (_) {
      return [];
    }
  }

  /**
   * Add a tracker URL to an active torrent.
   */
  addTracker(id: string, url: string): void {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) throw new TorrentError('Download not active', 'INVALID_STATE', id);

    try {
      (managed.torrent as any).addTracker?.(url);
      log.info('Tracker added', { id, url });
    } catch (err) {
      log.warn('addTracker not supported by WebTorrent version', { error: err });
    }
  }

  /**
   * Remove a tracker URL from an active torrent.
   */
  removeTracker(id: string, url: string): void {
    const managed = this.managedTorrents.get(id);
    if (!managed?.torrent) throw new TorrentError('Download not active', 'INVALID_STATE', id);

    try {
      (managed.torrent as any).removeTracker?.(url);
      log.info('Tracker removed', { id, url });
    } catch (err) {
      log.warn('removeTracker not supported by WebTorrent version', { error: err });
    }
  }

  /**
   * Check seeding limits (ratio + time) for all seeding torrents.
   * Called every stats tick.
   */
  private async checkSeedingLimits(): Promise<void> {
    for (const managed of this.managedTorrents.values()) {
      if (managed.download.status !== 'seeding') continue;

      const d = managed.download;
      const ratio = d.downloadedBytes > 0 ? d.uploadedBytes / d.downloadedBytes : 0;

      // Effective ratio limit: per-torrent overrides global
      const ratioLimit = (d.seedRatioLimit != null && d.seedRatioLimit > 0)
        ? d.seedRatioLimit
        : this.defaultSeedRatioLimit;

      if (ratioLimit > 0 && ratio >= ratioLimit) {
        log.info('Auto-stopped seeding (ratio limit reached)', { id: managed.id, ratio: ratio.toFixed(2), limit: ratioLimit });
        try { await this.stopSeeding(managed.id); } catch (_) { /* already stopped */ }
        continue;
      }

      // Effective time limit: per-torrent overrides global
      const timeLimit = (d.seedTimeLimitMinutes != null && d.seedTimeLimitMinutes > 0)
        ? d.seedTimeLimitMinutes
        : this.defaultSeedTimeLimitMinutes;

      if (timeLimit > 0 && d.seedingStartedAt) {
        const elapsedMinutes = (Date.now() - d.seedingStartedAt) / 60000;
        if (elapsedMinutes >= timeLimit) {
          log.info('Auto-stopped seeding (time limit reached)', { id: managed.id, elapsedMinutes: Math.round(elapsedMinutes), limit: timeLimit });
          try { await this.stopSeeding(managed.id); } catch (_) { /* already stopped */ }
        }
      }
    }
  }

  
  /**
   * Destroy the manager (cleanup on app quit)
   */
  async destroy(): Promise<void> {
    log.info('Destroying TorrentManager');

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

// Singleton instance
let torrentManager: TorrentManager | null = null;

export function getTorrentManager(): TorrentManager {
  if (!torrentManager) {
    torrentManager = new TorrentManager();
  }
  return torrentManager;
}
