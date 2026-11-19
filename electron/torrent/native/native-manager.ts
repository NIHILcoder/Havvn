import { mediaPath, hasPiece, VerifiedDiskMedia } from '../verified-media';
import { torrentFilePriority } from '../../../shared/torrent-file-selection';
import type { ExternalMedia, ExternalMediaRead } from '../../../shared/external-player';
/**
 * NativeTorrentManager — the transmission-daemon-backed download engine behind
 * the SAME host contract as the webtorrent TorrentManager (see
 * docs/native-host-contract.md). Runs in the torrent-host utilityProcess,
 * persists through the db-bridge (main owns electron-store), and drives the
 * bundled daemon over localhost RPC via TransmissionSidecar.
 *
 * Feature-complete vs the webtorrent engine: add / stats / controls / files /
 * peers / trackers / priorities / sequential / streaming / cast / subtitles /
 * swarm map / seed-from-folder / blocklist / magnet metadata preview. The one
 * deliberate no-op is DoH (the daemon has no resolver knob) — the webtorrent
 * engine stays selectable via settings.engine for that.
 *
 * Identity note: transmission's integer ids are NOT stable across daemon
 * restarts — everything is keyed on the torrent's infoHash (persisted onto the
 * Download record) and mapped to our uuid ids in memory.
 */

import fs from 'node:fs';
import type { DownloadDeletionPlan } from '../../../shared/download-removal';
import { checkDownloadDeletion, DeletionPreviewError, executeDownloadDeletion, prepareDownloadDeletion } from '../download-delete-plan';
import { assertTransfersAllowed, transfersBlocked, onTransfersBlocked } from '../transfer-policy';
import os from 'node:os';
import path from 'node:path';
import { torrentSourceKey } from '../../../shared/torrent-creation';
import http from 'node:http';
import crypto from 'node:crypto';
import * as db from '../host/db-bridge';
import { getHostEnv } from '../host/env';
import { prepareSeed, persistSeedMetadata, nativeSeedRoot, sameSeedSources, type SeedMetadata } from '../seed-metadata';
import { TorrentError } from '../errors';
import { logger } from '../../utils';
import { validateEpisodePrefetch, type EpisodePrefetchRequest, type EpisodePrefetchResult } from '../../../shared/episode-prefetch';
import { engineCapabilities } from '../../../shared/engine-capabilities';
import { TransmissionSidecar } from './transmission-sidecar';
import { TransmissionRpc, TrTorrent, TrStatus, TrFile } from './transmission-rpc';
import {
  ENGINE_STAT_FIELDS, mapStats, mapStatus, mapFiles, mapPeers, mapTrackers, aggregateSwarmGeo,
  editTrackerList, normalizeTrackerUrl, stripTrackerSlash, buildBlocklistP2P, fileBeginPiece,
  mapTorrentInfo,
} from './map';
import { NativeMediaServer } from './media-server';
import { probeAudioStreams, audioTrackList, audioTrackParam, AudioTrackListItem } from '../audio-probe';
import { streamStartSeconds, streamStartParam } from '../../../shared/stream-position';
import { listSubtitleTracks, getSubtitleVtt as extractSubtitleVtt } from '../subtitle-probe';
import type { SubtitleTrack } from '../../../shared/player-preferences';
import { extractInfoHashFromMagnet } from '../../../shared/magnet';
import { classifyMediaKind, isDirectlyPlayable } from '../../../shared/media';
import { isPrivateOrReservedIPv4 } from '../../../shared/ip-range';
import { resolveBindOverrides } from '../../../shared/vpn-bind';
import { getRoutedVpnIPv4 } from '../../utils/vpn-network';
import { captureRemovalSnapshot, persistRemovalSnapshot, readNativeRemovalMetadata, removalDataChanged } from '../download-removal';
import { DownloadUndoFailure, downloadRemovalSignature, type DownloadRemovalSnapshot, type DownloadUndoWarning } from '../../../shared/download-removal';
import { composeUploadLimits, DEFAULT_MAX_UP_KBPS } from '../../../shared/upload-limits';
import { AdaptiveThrottle } from '../adaptive-throttle';
import { daemonProxyEnv } from '../../../shared/tracker-proxy';
import { encryptionToSettingsInt, normalizeProtocolEncryption } from '../../../shared/protocol-encryption';
import { EMPTY_PIECES, summarizePieces } from '../../../shared/piece-bitfield';
import type {
  AppSettings, Download, DownloadStats, FilePriority, NetworkHealth, PeerInfo, RunningTransport,
  SourceType, SwarmGeo, TorrentFile, TorrentInfo, TorrentPieces, TrackerInfo, VpnBindStatus,
} from '../../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import ip3country = require('ip3country');

const log = logger.child('NativeEngine');

const STATS_INTERVAL_MS = 750;
const PEER_STATS_INTERVAL_MS = 5_000;
const PERSIST_EVERY_TICKS = 7; // ≈5.25s, mirrors the webtorrent manager's 5s batch persist

// Magnet metadata preview: same 30s budget as the webtorrent manager.
const METADATA_TIMEOUT_MS = 30_000;
const META_PROBE_FIELDS = ['id', 'hashString', 'name', 'totalSize', 'metadataPercentComplete', 'files'];

// parse-torrent is CJS with no types; we only need the file list + name.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const parseTorrent = require('parse-torrent') as (buf: Buffer) => {
  name?: string; infoHash?: string; length?: number;
  files?: Array<{ path: string; name: string; length: number }>;
};

function resolveFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let p = require('ffmpeg-static') as string | null;
    if (p && getHostEnv().isPackaged) p = p.replace('app.asar', 'app.asar.unpacked');
    return p;
  } catch {
    return null;
  }
}

const ACTIVE: ReadonlySet<Download['status']> = new Set(['downloading', 'seeding', 'queued']);

export class NativeTorrentManager {
  private readonly externalEpoch = crypto.randomBytes(16).toString('hex');
  private readonly externalDisk = new VerifiedDiskMedia();
  private readonly externalSnapshots = new Map<string, { at: number; value: TrTorrent | undefined }>();
  private readonly externalPending = new Map<string, Promise<TrTorrent | undefined>>();
  private sidecar: TransmissionSidecar | null = null;
  private rpc: TransmissionRpc | null = null;
  private ready: Promise<void> | null = null;

  private settings!: AppSettings;
  private readonly records = new Map<string, Download>();
  private readonly recheckRequests = new Map<string, Promise<void>>();
  private readonly idToHash = new Map<string, string>();
  private readonly hashToId = new Map<string, string>();
  /** Per-torrent file metadata for the SYNCHRONOUS cast resolver (getCastFileInfo). */
  private readonly metaCache = new Map<string, TrFile[]>();

  private lastStats: DownloadStats[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private pollGeneration = 0;
  private readonly pendingStarts = new Map<string, { poll: number; until: number; retryAt: number; awaitingStop: boolean }>();
  private readonly pendingFileSettings = new Set<string>();
  private nextPeerStatsAt = 0;
  private seedCounts = new Map<string, number>();
  private persistCounter = 0;
  private altSpeedEnabled = false;

  // Adaptive upload throttle (bufferbloat protection). The class itself is
  // engine-agnostic — it asks for the current upload rate and hands back a
  // ceiling — so the native engine runs its own instance rather than sharing
  // one. `adaptiveUpBytes` is the throttle's current ceiling (-1 = none) and is
  // merged with the manual caps by composeUploadLimits on every apply.
  private adaptive: AdaptiveThrottle | null = null;
  private adaptiveUploadEnabled = false;
  private adaptiveUpBytes = -1;
  private readonly ffmpegPath = resolveFfmpeg();
  private geoReady = false;
  private vpnBind: VpnBindStatus = { enabled: false, boundIp: null, iface: null, fallback: false };

  // Streaming: one shared 127.0.0.1 media server (loopback + per-session token),
  // and per-torrent the set of files pinned into sequential/priority-high head
  // mode so stopStream reverts them.
  private mediaServer: NativeMediaServer | null = null;
  private readonly streamToken = crypto.randomBytes(12).toString('hex');
  private readonly streamHeads = new Map<string, Set<number>>();
  private readonly startingStreams = new Map<string, number>();

  // IP blocklist: a tiny loopback server serves the generated P2P list, which the
  // daemon fetches via blocklist-update (transmission has no file:// blocklist).
  private blocklistServer: http.Server | null = null;
  private blocklistBody = '';
  private readonly blocklistToken = crypto.randomBytes(16).toString('hex');
  private dohWarned = false;

  private readonly statsCbs = new Set<(s: DownloadStats[]) => void>();
  private readonly completeCbs = new Set<(i: { id: string; name: string }) => void>();
  private readonly listeningCbs = new Set<() => void>();

  // ── Lifecycle ───────────────────────────────────────────────────────────────
  initialize(): Promise<void> {
    if (!this.ready) this.ready = this.doInit();
    return this.ready;
  }

  private async doInit(): Promise<void> {
    const env = getHostEnv();
    if (!env.engineBinary || !fs.existsSync(env.engineBinary)) {
      throw new Error(`transmission binary missing (${env.engineBinary ?? 'unset'}) — run: node scripts/fetch-transmission.mjs`);
    }
    const [settings, privacy] = await Promise.all([
      db.getSettings(),
      // Config failure must not silently start an unbound engine.
      db.getPrivacyConfig(),
    ]);
    this.settings = settings;
    // VPN bind (privacy.vpnBindEngine): resolve the VPN adapter's IPv4 NOW and
    // freeze it into settings.json — the daemon reads bind-address-* once at
    // startup, so every later change goes through a full engine restart
    // (vpn-guard drives that). No VPN present → loopback, never a real NIC.
    let bindOverrides: Record<string, unknown> = {};
    if (privacy?.vpnBindEngine === true) {
      const ifaces = os.networkInterfaces();
      const vpn = await getRoutedVpnIPv4();
      bindOverrides = resolveBindOverrides(vpn);
      this.vpnBind = { enabled: true, boundIp: vpn?.address ?? null, iface: vpn?.iface ?? null, fallback: !vpn };
      if (vpn) log.info('Engine bound to VPN interface', { iface: vpn.iface, ip: vpn.address });
      else log.warn('VPN bind enabled but no VPN adapter recognized — engine bound to loopback (fail-closed, zero peers until the VPN connects)', { interfaces: Object.keys(ifaces) });
    }
    this.sidecar = new TransmissionSidecar({
      binaryPath: env.engineBinary,
      configDir: env.engineStateDir,
      downloadDir: this.settings.defaultDownloadDir,
      pausedOnStart: true,
      peerPort: (this.settings.portMin ?? 0) > 0 ? this.settings.portMin : undefined,
      // Main's existing UPnP service owns the router mapping (honors the
      // portForwarding toggle); don't let the daemon double-map the port.
      settingsOverrides: {
        'port-forwarding-enabled': false,
        encryption: encryptionToSettingsInt(normalizeProtocolEncryption(this.settings.encryption)),
        ...this.queueSettings(this.settings),
        ...bindOverrides,
      },
      env: daemonProxyEnv(this.settings),
      onLog: (line) => log.debug('daemon', { line }),
      // Host exits → proxy respawns the whole host → clean engine restart.
      onUnexpectedExit: (code) => { log.error('transmission daemon died', { code }); process.exit(1); },
    });
    this.rpc = await this.sidecar.start();
    log.info('Native engine ready', { pid: this.sidecar.pid, peerPort: this.sidecar.peerPort });
    await this.applySessionSettings(this.settings);
    await this.reconcile();
    this.statsTimer = setInterval(() => { void this.tick().catch((e) => log.warn('stats tick failed', { error: String(e) })); }, STATS_INTERVAL_MS);
    // After the stats loop: the throttle reads its upload rate from lastStats,
    // so starting it first would just feed it zeros for the first tick.
    this.adaptiveUploadEnabled = this.settings.adaptiveUpload ?? false;
    if (this.adaptiveUploadEnabled) this.startAdaptiveThrottle();
    for (const cb of this.listeningCbs) { try { cb(); } catch { /* ignore */ } }
  }

  private async whenReady(): Promise<void> {
    if (!this.ready) throw new TorrentError('engine not initialized', 'NOT_ACTIVE');
    await this.ready;
    if (!this.rpc) throw new TorrentError('engine not running', 'NOT_ACTIVE');
  }

  async destroy(): Promise<void> {
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    // Before the RPC handle goes: stop() can fire onCap, and that write would
    // otherwise land on a null rpc (applyUploadLimits no-ops, but the probe
    // interval must not outlive the manager either way).
    this.adaptive?.stop();
    this.adaptive = null;
    this.mediaServer?.close();
    this.mediaServer = null;
    if (this.blocklistServer) { try { this.blocklistServer.close(); } catch { /* ignore */ } this.blocklistServer = null; }
    this.rpc = null;
    this.seedCounts.clear();
    this.pendingStarts.clear();
    this.pendingFileSettings.clear();
    this.startingStreams.clear();
    await this.sidecar?.stop();
    this.sidecar = null;
  }

  // ── Session settings ────────────────────────────────────────────────────────
  private queueSettings(s: AppSettings): Record<string, unknown> {
    const limit = Number.isFinite(s.maxActiveDownloads) ? Math.max(0, Math.floor(s.maxActiveDownloads)) : 3;
    return {
      'download-queue-enabled': true,
      'download-queue-size': limit,
      // Idle torrents still hold a slot; otherwise a stalled swarm can exceed
      // the user's memory/connection budget when Transmission promotes others.
      'queue-stalled-enabled': false,
      // Seeding does not consume an active-download slot in either engine.
      'seed-queue-enabled': false,
    };
  }

  private async applySessionSettings(s: AppSettings): Promise<void> {
    const down = s.altSpeedEnabled ? s.altDownKbps ?? 0 : s.maxDownKbps ?? 0;
    const args: Record<string, unknown> = {
      'dht-enabled': s.enableDHT ?? true,
      'pex-enabled': s.enablePEX ?? true,   // real toggles at last — webtorrent ignored these
      'lpd-enabled': s.enableLSD ?? true,
      'utp-enabled': s.enableUtp ?? true,
      'encryption': normalizeProtocolEncryption(s.encryption),
      'peer-limit-per-torrent': s.maxConnections ?? 100,
      'peer-limit-global': s.maxConnectionsGlobal ?? 300,
      'speed-limit-down-enabled': down > 0,
      // Select the app's normal/alternative pair ourselves. Daemon alt mode has
      // no per-direction unlimited switch and can retain an old policy ceiling.
      'alt-speed-enabled': false,
      seedRatioLimited: (s.defaultSeedRatioLimit ?? 0) > 0,
      ...this.queueSettings(s),
      // The selected application's upload cap is composed with the adaptive
      // ceiling. Applying a raw manual value would lift the adaptive cap.
      ...this.uploadLimitArgs(s),
    };
    if (down > 0) args['speed-limit-down'] = down;
    if ((s.defaultSeedRatioLimit ?? 0) > 0) args['seedRatioLimit'] = s.defaultSeedRatioLimit;
    await this.rpc!.sessionSet(args);
    this.altSpeedEnabled = s.altSpeedEnabled ?? false;

    // DoH is honestly unsupported by the external daemon: transmission resolves
    // DNS in its own process via the OS resolver and exposes no DoH knob, so we
    // must NOT pretend it's active. Warn once; the webtorrent engine still
    // honors dohEnabled for users who switch back to it.
    if ((s.dohEnabled ?? false) && !this.dohWarned) {
      this.dohWarned = true;
      log.warn('DoH is not supported by the native (transmission) engine — DNS uses the OS resolver. Switch Settings → engine to "webtorrent" for DoH.');
    }
  }

  /** The daemon's normal limiter carries the application's selected speed pair. */
  private uploadLimitArgs(s: AppSettings): Record<string, unknown> {
    return composeUploadLimits({
      maxUpKbps: s.altSpeedEnabled ? s.altUpKbps ?? 0 : s.maxUpKbps ?? DEFAULT_MAX_UP_KBPS,
      altUpKbps: s.altUpKbps ?? 0,
      adaptiveUpBytes: this.adaptiveUpBytes,
    }) as unknown as Record<string, unknown>;
  }

  /**
   * Push ONLY the upload ceilings. The adaptive throttle re-caps every couple of
   * seconds, and a full applySessionSettings per tick would re-send a dozen
   * unrelated keys (and re-run the DoH warning path) for no reason.
   */
  private async applyUploadLimits(): Promise<void> {
    if (!this.rpc) return; // capped before the daemon is up — doInit applies it
    await this.rpc.sessionSet(this.uploadLimitArgs(this.settings));
  }

  async updateSettings(partial: Partial<AppSettings>): Promise<void> {
    await this.whenReady();
    const speedChanged = ['maxDownKbps', 'maxUpKbps', 'altDownKbps', 'altUpKbps', 'altSpeedEnabled'].some(
      key => partial[key as keyof AppSettings] !== undefined && partial[key as keyof AppSettings] !== this.settings[key as keyof AppSettings]
    );
    this.settings = { ...this.settings, ...partial };
    // Adaptive on/off takes effect live, like the webtorrent manager's does.
    // Checked BEFORE applySessionSettings so a just-stopped throttle has already
    // cleared its ceiling and the apply below writes the manual caps alone.
    const wantAdaptive = this.settings.adaptiveUpload ?? false;
    if (wantAdaptive !== this.adaptiveUploadEnabled) {
      this.adaptiveUploadEnabled = wantAdaptive;
      if (wantAdaptive) this.startAdaptiveThrottle();
      else this.stopAdaptiveThrottle();
    }
    await this.applySessionSettings(this.settings);
    if (speedChanged) log.info('Speed limits applied without stopping torrents', {
      maxDownKbps: this.settings.maxDownKbps ?? 0,
      maxUpKbps: this.settings.maxUpKbps ?? DEFAULT_MAX_UP_KBPS,
      altSpeedEnabled: this.altSpeedEnabled,
    });
  }

  // ── Adaptive upload throttle (bufferbloat protection) ───────────────────────

  private startAdaptiveThrottle(): void {
    if (!this.adaptive) {
      this.adaptive = new AdaptiveThrottle({
        // Aggregate upload across every torrent, straight out of the stats tick
        // we already run — rateUpload is in ENGINE_STAT_FIELDS, so this costs no
        // extra RPC round trip.
        getUploadBps: () => this.lastStats.reduce((a, s) => a + s.upSpeedBps, 0),
        onCap: (bytes) => {
          this.adaptiveUpBytes = bytes;
          // onCap is sync by contract; the RPC write is not. Never let a failed
          // write reject into the throttle's tick — it would kill the interval.
          void this.applyUploadLimits().catch((e) => {
            log.warn('Failed to apply adaptive upload cap', { error: e instanceof Error ? e.message : String(e) });
          });
        },
      });
    }
    this.adaptive.start();
  }

  /** Stop the throttle and clear its ceiling so the manual caps alone apply. */
  private stopAdaptiveThrottle(): void {
    this.adaptive?.stop();   // fires onCap(-1) if a cap was live
    this.adaptiveUpBytes = -1;
  }

  async setAltSpeed(enabled: boolean): Promise<{ altSpeedEnabled: boolean }> {
    await this.whenReady();
    const next = { ...this.settings, altSpeedEnabled: enabled };
    await this.applySessionSettings(next);
    this.settings = next;
    await db.updateSettings({ altSpeedEnabled: enabled });
    return { altSpeedEnabled: enabled };
  }

  isAltSpeedEnabled(): boolean { return this.altSpeedEnabled; }
  private async startTorrents(ids: string | string[]): Promise<void> {
    assertTransfersAllowed();
    await this.rpc!.torrentStart(ids);
  }
  getListeningPort(): number { return this.sidecar?.peerPort ?? 0; }
  getVpnBindStatus(): VpnBindStatus { return this.vpnBind; }
  get ffmpegBinary(): string | null { return this.ffmpegPath; }

  // ── Restore / identity mapping ──────────────────────────────────────────────
  private link(id: string, hash: string): void {
    this.idToHash.set(id, hash);
    this.hashToId.set(hash, id);
  }

  /**
   * Boot reconciliation. The daemon restores its own torrents from its resume
   * state; the DB records are the app's source of truth. Marry the two by
   * infoHash: sync run-state for matches, re-add active records the daemon
   * lost, drop daemon strays the app no longer knows.
   */
  private async reconcile(): Promise<void> {
    const all = await db.getAllDownloads();
    const daemonList = await this.rpc!.torrentGet(['hashString', 'name', 'status', 'percentDone']);
    const daemonByHash = new Map(daemonList.map((t) => [t.hashString.toLowerCase(), t]));
    const claimed = new Set<string>();

    // Give higher-priority records the first chance at a download slot.
    all.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const d of all) {
      if (d.status === 'removed') { await db.deleteDownload(d.id); continue; } // boot purge, same as webtorrent manager
      this.records.set(d.id, d);
      if (transfersBlocked() && ACTIVE.has(d.status)) await this.setStatus(d, 'paused');
      const hash = d.infoHash?.toLowerCase()
        ?? (d.sourceType === 'magnet' ? extractInfoHashFromMagnet(d.sourceUri) ?? undefined : undefined);
      const t = hash ? daemonByHash.get(hash) : undefined;
      const wantActive = ACTIVE.has(d.status);
      try {
        if (d.seedPaths?.length && wantActive) {
          claimed.add(await this.addToDaemon(d, false));
        } else if (hash && t) {
          this.link(d.id, hash);
          claimed.add(hash);
          if (!d.infoHash) await db.updateDownloadField(d.id, 'infoHash', hash);
          // Persisted intent wins over whatever run-state the daemon resumed with.
          if (!wantActive && t.status !== TrStatus.Stopped) await this.rpc!.torrentStop(hash);
          else if (wantActive && t.status === TrStatus.Stopped) {
            await this.startTorrents(hash);
            this.noteStart(d);
          }
        } else if (wantActive) {
          claimed.add(await this.addToDaemon(d, false));
        }
        // paused/completed/error rows stay daemon-less until resumed (ensureInDaemon)
      } catch (e) {
        log.error('Failed to restore torrent', { id: d.id, error: e instanceof Error ? e.message : String(e) });
        await this.setStatus(d, 'error', e instanceof Error ? e.message : 'Failed to restore');
      }
    }

    for (const t of daemonList) {
      const h = t.hashString.toLowerCase();
      if (!claimed.has(h)) {
        log.warn('Removing stray daemon torrent (unknown to the app)', { hash: h, name: t.name });
        await this.rpc!.torrentRemove(h, false).catch(() => undefined);
      }
    }
    log.info('Reconciled downloads with daemon', { records: this.records.size, daemon: daemonList.length });
  }

  /** Re-add a DB record to the daemon from its source (restore / lazy resume). */
  private async addToDaemon(d: Download, paused: boolean, rejectDuplicate = false): Promise<string> {
    // A fresh re-add loses the daemon-side root rename AND the resume state, so
    // "start seeding" records go in PAUSED, get their root remapped onto the
    // on-disk name, then verify before (optionally) starting — otherwise the
    // daemon would look for data under the torrent's name and re-download it.
    const isSeed = (d.seedPaths?.length ?? 0) > 0;
    let res;
    if (d.torrentFilePath) {
      let file = d.torrentFilePath;
      if (!fs.existsSync(file)) {
        // Heal pre-rebrand/pre-move profile paths — the copy lives in THIS profile.
        const healed = path.join(getHostEnv().userDataDir, 'torrents', path.basename(file));
        if (!fs.existsSync(healed)) throw new TorrentError('Torrent file not found', 'FILE_NOT_FOUND', d.id);
        file = healed;
        d.torrentFilePath = healed;
        await db.updateDownloadField(d.id, 'torrentFilePath', healed);
      }
      if (isSeed) {
        const { metadata, paths } = await prepareSeed(file, d.seedPaths!, d.infoHash);
        const root = nativeSeedRoot(metadata, paths);
        res = await this.attachSeedPaused(metadata, root, !rejectDuplicate);
        if (!res.duplicate || !rejectDuplicate) {
          d.savePath = path.dirname(root);
          await db.updateDownloadField(d.id, 'savePath', d.savePath);
          await this.verifySeed(metadata.infoHash, metadata.length);
          // Existing seed data is already complete. In particular, legacy rows
          // may still have progress=0: resume must not queue them as downloads
          // and emit a second completion when the next daemon poll arrives.
          d.progress = 1;
          d.totalSize = metadata.length;
          await db.updateDownloadFields(d.id, { progress: 1, totalSize: metadata.length });
        }
      } else {
        const buf = fs.readFileSync(file);
        res = await this.rpc!.torrentAdd({ metainfo: buf, downloadDir: d.savePath, paused: true, filesUnwanted: unwantedIndices(buf, d.selectedFiles) });
      }
    } else {
      if (isSeed) throw new TorrentError('Original torrent metadata is missing; recreate this seed', 'FILE_NOT_FOUND', d.id);
      res = await this.rpc!.torrentAdd({ filename: d.sourceUri, downloadDir: d.savePath, paused: true });
    }
    const hash = res.hashString.toLowerCase();
    // Undo must never attach to a daemon entry owned outside the removed record.
    if (rejectDuplicate && res.duplicate) throw new DownloadUndoFailure('conflict');
    if (d.nativeSessionBase && !res.duplicate) {
      d.nativeSessionBase = { downloaded: d.downloadedBytes, uploaded: d.uploadedBytes };
      await db.updateDownloadField(d.id, 'nativeSessionBase', d.nativeSessionBase);
    }
    this.link(d.id, hash);
    if (d.infoHash !== hash) { d.infoHash = hash; await db.updateDownloadField(d.id, 'infoHash', hash); }
    // Re-apply the user's tracker edits — the daemon's own resume state has them
    // only if it kept the torrent across the restart; on a fresh re-add it doesn't.
    if (d.customTrackers?.length || d.removedTrackers?.length) {
      await this.applyTrackerListEdit(hash, { add: d.customTrackers, remove: d.removedTrackers })
        .catch((e) => log.warn('tracker re-apply failed', { id: d.id, error: String(e) }));
    }
    if (d.seedRatioLimit != null) {
      await this.rpc!.torrentSet(hash, {
        seedRatioLimit: d.seedRatioLimit,
        seedRatioMode: d.seedRatioLimit > 0 ? 1 : 2,
      });
    }
    if (d.sequentialDownload !== undefined) await this.rpc!.torrentSet(hash, await this.sequentialSettings(hash, d.sequentialDownload));
    await this.applyFileSettings(d);
    if (!paused) { await this.startTorrents(hash); this.noteStart(d); }
    return hash;
  }

  /** Hash for a record, (re-)adding it to the daemon paused if it isn't live. */
  private async ensureInDaemon(d: Download): Promise<string> {
    const existing = this.idToHash.get(d.id);
    if (existing) return existing;
    return this.addToDaemon(d, true);
  }

  private getRecord(id: string): Download {
    const d = this.records.get(id);
    if (!d || d.status === 'removed') throw new TorrentError('Download not found', 'NOT_FOUND', id);
    return d;
  }

  private async setStatus(d: Download, status: Download['status'], lastError?: string): Promise<void> {
    d.status = status;
    d.lastError = lastError ?? null;
    await db.updateDownloadStatus(d.id, status, lastError);
  }

  // ── Add ─────────────────────────────────────────────────────────────────────
  async addDownload(params: import('../../../shared/types').AddDownloadRequest): Promise<Download> {
    await this.whenReady();
    const savePath = params.savePath || this.settings.defaultDownloadDir;
    const paused = !!params.paused;

    // Magnet duplicates are knowable before touching the daemon.
    if (params.sourceType === 'magnet') {
      const pre = extractInfoHashFromMagnet(params.sourceUri);
      if (pre && this.hashToId.has(pre)) throw new TorrentError('This torrent is already in your downloads', 'DUPLICATE', this.hashToId.get(pre));
    }

    let localTorrentPath: string | null = null;
    let tempToCleanup: string | null = null;
    if (params.sourceType === 'torrent_file') {
      localTorrentPath = params.sourceUri;
      if (/^https?:\/\//i.test(params.sourceUri)) {
        localTorrentPath = await this.fetchTorrentToTemp(params.sourceUri);
        tempToCleanup = localTorrentPath;
      }
    }

    try {
      let res;
      if (localTorrentPath) {
        const buf = fs.readFileSync(localTorrentPath);
        res = await this.rpc!.torrentAdd({ metainfo: buf, downloadDir: savePath, paused: true, filesUnwanted: unwantedIndices(buf, params.selectedFiles) });
      } else {
        // Unpaused magnet adds bypass Transmission's queue to fetch metadata.
        // Add stopped and request a normal start after the record is durable.
        res = await this.rpc!.torrentAdd({ filename: params.sourceUri, downloadDir: savePath, paused: true });
      }
      const hash = res.hashString.toLowerCase();
      if (res.duplicate) throw new TorrentError('This torrent is already in your downloads', 'DUPLICATE', this.hashToId.get(hash));

      const storedTorrentPath = localTorrentPath ? this.copyTorrentIntoAppData(localTorrentPath) : null;
      const download = await db.createDownload({
        automation: params.automation,
        name: params.name || res.name,
        sourceType: params.sourceType,
        sourceUri: params.sourceUri,
        torrentFilePath: storedTorrentPath ?? undefined,
        savePath,
        status: paused ? 'paused' : 'queued',
        selectedFiles: params.selectedFiles,
        category: params.categoryId ?? null,
        seedRatioLimit: params.seedRatioLimit,
        seedTimeLimitMinutes: params.seedTimeLimitMinutes,
        sequentialDownload: params.sequentialDownload,
      });
      download.infoHash = hash;
      download.status = paused ? 'paused' : 'queued';
      await db.updateDownloadField(download.id, 'infoHash', hash);
      this.records.set(download.id, download);
      this.link(download.id, hash);
      try {
        if (params.seedRatioLimit !== undefined) await this.rpc!.torrentSet(hash, { seedRatioLimit: params.seedRatioLimit, seedRatioMode: params.seedRatioLimit > 0 ? 1 : 2 });
        if (params.sequentialDownload !== undefined) await this.rpc!.torrentSet(hash, await this.sequentialSettings(hash, params.sequentialDownload));
      } catch (error) {
        await this.setStatus(download, 'error', error instanceof Error ? error.message : String(error)); throw error;
      }
      if (!paused) {
        try { await this.startTorrents(hash); this.noteStart(download); }
        catch (e) { await this.setStatus(download, 'error', e instanceof Error ? e.message : String(e)); throw e; }
      }
      log.info('Download added', { id: download.id, hash, name: download.name });
      return download;
    } finally {
      if (tempToCleanup) { try { fs.unlinkSync(tempToCleanup); } catch { /* ignore */ } }
    }
  }

  // Same param shape as the webtorrent manager — the renderer's add dialog
  // calls this with { torrentPath } or { magnetUri }.
  async getTorrentInfo(params: { torrentPath?: string; magnetUri?: string }): Promise<TorrentInfo> {
    await this.whenReady();
    if (params.torrentPath) return this.torrentInfoFromFile(params.torrentPath);
    if (params.magnetUri) return this.torrentInfoFromMagnet(params.magnetUri);
    throw new TorrentError('No torrent path or magnet URI provided', 'INVALID_INPUT');
  }

  /** .torrent on disk (or via http) — parsed locally, the daemon isn't touched. */
  private async torrentInfoFromFile(source: string): Promise<TorrentInfo> {
    let file = source;
    let temp: string | null = null;
    if (/^https?:\/\//i.test(file)) { file = await this.fetchTorrentToTemp(file); temp = file; }
    try {
      const meta = parseTorrent(fs.readFileSync(file));
      const files = (meta.files ?? []).map((f, index) => ({ path: f.path, size: f.length, index }));
      return { name: meta.name ?? path.basename(file, '.torrent'), files, totalSize: meta.length ?? files.reduce((a, f) => a + f.size, 0) };
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch { /* ignore */ } }
    }
  }

  /** In-flight magnet probes, deduped by infoHash so a double-open of the add
   *  dialog doesn't race two temp-adds of the same magnet. */
  private readonly metaProbes = new Map<string, Promise<TorrentInfo>>();

  private torrentInfoFromMagnet(magnetUri: string): Promise<TorrentInfo> {
    const key = extractInfoHashFromMagnet(magnetUri) ?? magnetUri;
    const inFlight = this.metaProbes.get(key);
    if (inFlight) return inFlight;
    const probe = this.probeMagnetMetadata(magnetUri).finally(() => this.metaProbes.delete(key));
    this.metaProbes.set(key, probe);
    return probe;
  }

  /**
   * Resolve a magnet's metadata through the daemon. If the magnet is already a
   * real download its info is served from that torrent (and it is left alone);
   * otherwise the magnet is temp-added and removed — with any stray piece data
   * — BEFORE resolving, so a follow-up addDownload of the same magnet can't
   * collide with the probe as a duplicate.
   */
  private async probeMagnetMetadata(magnetUri: string): Promise<TorrentInfo> {
    const hash = extractInfoHashFromMagnet(magnetUri);
    if (hash) {
      const known = await this.rpc!.torrentGet(META_PROBE_FIELDS, hash);
      if (known.length > 0) return this.awaitDaemonMetadata(known[0].hashString);
    }
    const probeDir = path.join(getHostEnv().tempDir, 'meta-probe');
    assertTransfersAllowed();
    fs.mkdirSync(probeDir, { recursive: true });
    const rpc = this.rpc!;
    let ownedHash: string | undefined, canceled = false, removing: Promise<unknown> | undefined;
    const removeOwned = () => ownedHash ? (removing ??= rpc.torrentRemove(ownedHash, true).catch(() => {})) : Promise.resolve();
    const off = onTransfersBlocked(() => { canceled = true; void removeOwned(); });
    try {
      const res = await rpc.torrentAdd({ filename: magnetUri, downloadDir: probeDir, paused: false });
      // A duplicate belongs to a real download; never remove it as probe data.
      if (!res.duplicate) ownedHash = res.hashString;
      if (canceled || transfersBlocked()) throw new TorrentError('Metadata fetch canceled by transfer protection', 'TRANSFER_BLOCKED');
      return await this.awaitDaemonMetadata(res.hashString, () => canceled);
    } finally {
      off(); await removeOwned();
    }
  }

  private async awaitDaemonMetadata(hash: string, canceled = () => false): Promise<TorrentInfo> {
    const deadline = Date.now() + METADATA_TIMEOUT_MS;
    for (;;) {
      if (canceled()) throw new TorrentError('Metadata fetch canceled by transfer protection', 'TRANSFER_BLOCKED');
      assertTransfersAllowed();
      const [t] = await this.rpc!.torrentGet(META_PROBE_FIELDS, hash);
      if (canceled()) throw new TorrentError('Metadata fetch canceled by transfer protection', 'TRANSFER_BLOCKED');
      assertTransfersAllowed();
      if (!t) throw new TorrentError('Torrent disappeared while fetching metadata', 'LOAD_ERROR');
      if (t.metadataPercentComplete >= 1 && (t.files?.length ?? 0) > 0) return mapTorrentInfo(t);
      if (Date.now() >= deadline) throw new TorrentError('Timeout loading torrent information', 'TIMEOUT');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async fetchTorrentToTemp(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new TorrentError(`Failed to fetch .torrent (http ${res.status})`, 'LOAD_ERROR');
    const limit = 10 * 1024 * 1024;
    if (Number(res.headers.get('content-length')) > limit) {
      await res.body?.cancel(); throw new TorrentError('Torrent file too large', 'INVALID_INPUT');
    }
    if (!res.body) throw new TorrentError('Torrent response is empty', 'LOAD_ERROR');
    const reader = res.body.getReader(), chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader.cancel(); throw new TorrentError('Torrent file too large', 'INVALID_INPUT'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const dest = path.join(getHostEnv().tempDir, `havvn-${crypto.randomUUID()}.torrent`);
    fs.writeFileSync(dest, Buffer.concat(chunks), { flag: 'wx' });
    return dest;
  }

  /** Same convention as the webtorrent manager: restarts survive the source moving. */
  private copyTorrentIntoAppData(localTorrentPath: string): string {
    const dir = path.join(getHostEnv().userDataDir, 'torrents');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${crypto.randomUUID()}.torrent`);
    fs.copyFileSync(localTorrentPath, dest, fs.constants.COPYFILE_EXCL);
    return dest;
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  async pauseDownload(id: string): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = this.idToHash.get(id);
    this.pendingStarts.delete(id);
    if (hash) await this.rpc!.torrentStop(hash);
    log.info('Torrent pause requested by app', { id, previousStatus: d.status });
    await this.setStatus(d, 'paused');
    this.seedCounts.delete(id);
  }

  async resumeDownload(id: string): Promise<void> {
    await this.whenReady();
    assertTransfersAllowed();
    const d = this.getRecord(id);
    const rpc = this.rpc!;
    const starting = this.noteStart(d);
    starting.awaitingStop = !!d.seedPaths?.length || d.status === 'paused' || d.status === 'completed';
    const current = () => this.rpc === rpc && this.pendingStarts.get(id) === starting;
    try {
      const hash = d.seedPaths?.length ? await this.addToDaemon(d, true) : await this.ensureInDaemon(d);
      if (!current()) return;
      // torrent-stop returns before the daemon actually stops. A start issued
      // while it still reports Downloading is ignored as "already started",
      // then the delayed stop lands. Wait for the stop itself before starting.
      const deadline = Date.now() + 10_000;
      while (starting.awaitingStop && current()) {
        const [torrent] = await rpc.torrentGet(['status'], hash);
        if (!current()) return;
        if (!torrent) throw new TorrentError('Torrent disappeared from the engine', 'NOT_FOUND', id);
        if (torrent.status === TrStatus.Stopped) break;
        if (Date.now() >= deadline) throw new TorrentError('Torrent is still stopping. Try resuming again.', 'NOT_ACTIVE', id);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!current()) return;
      await this.startTorrents(hash);
      if (!current()) {
        if (this.rpc === rpc && !this.pendingStarts.has(id)) await rpc.torrentStop(hash);
        return;
      }
      starting.awaitingStop = false;
      starting.poll = this.pollGeneration;
      starting.until = Date.now() + 30_000;
      starting.retryAt = Date.now() + 1000;
      await this.setStatus(d, d.progress >= 1 ? 'seeding' : 'queued');
    } catch (error) {
      if (d.seedPaths?.length && current()) await this.setStatus(d, 'error', error instanceof Error ? error.message : String(error));
      if (this.pendingStarts.get(id) === starting) this.pendingStarts.delete(id);
      throw error;
    }
  }

  async removeDownload(id: string, deleteFiles: boolean, signature?: string, approvedPlan?: DownloadDeletionPlan): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    if (signature) {
      const persisted = await db.getDownloadById(id);
      if (!persisted) throw new DownloadUndoFailure('conflict');
      d.category = persisted.category; d.priority = persisted.priority;
      if (signature !== downloadRemovalSignature(d)) throw new DownloadUndoFailure('conflict');
    }
    const deletion = deleteFiles ? approvedPlan ?? await prepareDownloadDeletion(await this.captureDownloadRemoval(id)) : undefined;
    if (deletion) {
      if (deletion.downloadId !== id || deletion.signature !== downloadRemovalSignature(d)) throw new DeletionPreviewError('changed');
      await checkDownloadDeletion(deletion);
    }
    let hash = this.idToHash.get(id);
    if (!hash && deleteFiles && !d.seedPaths?.length) {
      hash = await this.ensureInDaemon(d);
    }
    if (hash && deleteFiles && !d.seedPaths?.length) {
      const [torrent] = await this.rpc!.torrentGet(['metadataPercentComplete', 'totalSize', 'haveValid', 'haveUnchecked', 'downloadedEver', 'files'], hash);
      // A dead magnet that never obtained metadata has no payload to delete.
      // Let the daemon remove its empty entry; never guess a path from its name.
      // Retain the metadata guard for restored/previously downloaded data.
      const emptyMagnet = d.sourceType === 'magnet' && d.totalSize === 0 && d.downloadedBytes === 0 && d.progress === 0
        && torrent && torrent.metadataPercentComplete >= 0 && torrent.metadataPercentComplete < 1
        && torrent.totalSize === 0 && torrent.haveValid === 0 && torrent.haveUnchecked === 0 && torrent.downloadedEver === 0
        && Array.isArray(torrent.files) && torrent.files.length === 0;
      if (deletion?.metadata ? !(torrent?.metadataPercentComplete >= 1) : !emptyMagnet) {
        throw new TorrentError('Torrent metadata is unavailable; cannot delete its files yet', 'NOT_ACTIVE', id);
      }
    }
    let recoveryMetadata: string | undefined;
    if (deletion?.metadata) {
      // Removing a daemon entry also discards its metainfo. Keep an app-owned
      // recovery copy and a paused record until every reviewed file is removed.
      const directory = path.join(getHostEnv().userDataDir, 'torrents');
      const previousRecovery = d.torrentFilePath && path.dirname(d.torrentFilePath) === directory
        && /^delete-recovery-[a-f0-9-]{36}\.torrent$/i.test(path.basename(d.torrentFilePath)) ? d.torrentFilePath : undefined;
      await fs.promises.mkdir(directory, { recursive: true });
      recoveryMetadata = path.join(directory, `delete-recovery-${crypto.randomUUID()}.torrent`);
      const recovery = await fs.promises.open(recoveryMetadata, 'wx', 0o600);
      try { await recovery.writeFile(Buffer.from(deletion.metadata, 'base64')); await recovery.sync(); }
      catch (error) { await recovery.close(); await fs.promises.unlink(recoveryMetadata).catch(() => {}); throw error; }
      await recovery.close();
      try { await db.updateDownloadFields(id, { torrentFilePath: recoveryMetadata, status: 'paused' }); }
      catch (error) { await fs.promises.unlink(recoveryMetadata).catch(() => {}); throw error; }
      d.torrentFilePath = recoveryMetadata; d.status = 'paused';
      if (previousRecovery) await fs.promises.unlink(previousRecovery).catch(() => {});
    } else if (deletion) await this.setStatus(d, 'paused');
    let removedFromDaemon = false;
    try {
      if (hash) {
        await this.rpc!.torrentRemove(hash, false); removedFromDaemon = true;
        this.idToHash.delete(id);
        this.hashToId.delete(hash);
      }
      if (deletion) await executeDownloadDeletion(deletion);
    } catch (error) {
      if (removedFromDaemon && hash) { this.idToHash.delete(id); this.hashToId.delete(hash); }
      if (deletion) await this.setStatus(d, 'error', 'Some files could not be deleted. Review the remaining files and retry.').catch(() => {});
      throw error;
    }
    this.metaCache.delete(id);
    this.pendingStarts.delete(id);
    this.pendingFileSettings.delete(id);
    this.seedCounts.delete(id);
    this.streamHeads.delete(id); // any pinned stream head goes away with the torrent
    // Tombstone until next boot (same as webtorrent manager) so late stats
    // ticks/UI reads don't resurrect the row; reconcile() purges it.
    await this.setStatus(d, 'removed');
    if (recoveryMetadata) await fs.promises.unlink(recoveryMetadata).catch(() => {});
  }

  async captureDownloadRemoval(id: string): Promise<DownloadRemovalSnapshot> {
    await this.whenReady();
    const d = this.getRecord(id);
    const persisted = await db.getDownloadById(id);
    if (!persisted) throw new DownloadUndoFailure('conflict');
    d.category = persisted.category; d.priority = persisted.priority;
    const hash = this.idToHash.get(id) ?? d.infoHash;
    const [live] = hash ? await this.rpc!.torrentGet([...ENGINE_STAT_FIELDS, 'files', 'fileStats'], hash) : [];
    const stats = mapStats(d, live);
    const download = { ...d, progress: stats.progress, downloadedBytes: stats.downloadedBytes,
      uploadedBytes: stats.uploadedBytes, infoHash: hash ?? d.infoHash };
    return captureRemovalSnapshot(download, await readNativeRemovalMetadata(download, getHostEnv().engineStateDir), live ? mapFiles(live) : []);
  }

  async restoreRemovedDownload(snapshot: DownloadRemovalSnapshot, recordOnly = false): Promise<{ warnings: DownloadUndoWarning[] }> {
    await this.whenReady();
    const id = snapshot.download.id, existing = this.records.get(id);
    const owner = snapshot.download.infoHash ? this.hashToId.get(snapshot.download.infoHash) : undefined;
    if ((existing && existing.status !== 'removed') || (owner && owner !== id)) throw new DownloadUndoFailure('conflict');
    const d = await persistRemovalSnapshot({ ...snapshot, download: { ...snapshot.download,
      nativeSessionBase: { downloaded: snapshot.download.downloadedBytes, uploaded: snapshot.download.uploadedBytes },
    } }, getHostEnv().userDataDir, db.restoreDownload);
    this.records.set(id, d);
    const warnings: DownloadUndoWarning[] = d.category !== snapshot.download.category ? ['category-missing'] : [];
    if (recordOnly) return { warnings };
    try {
      if (snapshot.metadata) {
        const hash = await this.addToDaemon(d, true, true);
        const groups: Record<string, number[]> = { 'files-wanted': [], 'files-unwanted': [], 'priority-low': [], 'priority-normal': [], 'priority-high': [] };
        snapshot.files.forEach((file, index) => {
          const priority = file.priority ?? 'normal';
          groups[priority === 'skip' ? 'files-unwanted' : 'files-wanted'].push(index);
          if (priority !== 'skip') groups[`priority-${priority}`].push(index);
        });
        await this.rpc!.torrentSet(hash, { ...Object.fromEntries(Object.entries(groups).filter(([, indices]) => indices.length)),
          ...(d.sequentialDownload !== undefined ? await this.sequentialSettings(hash, d.sequentialDownload) : {}),
          ...(d.maxDownloadSpeed !== undefined ? { downloadLimited: d.maxDownloadSpeed > 0, downloadLimit: d.maxDownloadSpeed } : {}),
          ...(d.maxUploadSpeed !== undefined ? { uploadLimited: d.maxUploadSpeed > 0, uploadLimit: d.maxUploadSpeed } : {}),
        });
        await this.rpc!.torrentVerify(hash);
        const deadline = Date.now() + 60_000;
        let stoppedObservations = 0;
        for (;;) {
          const [live] = await this.rpc!.torrentGet(['status', 'recheckProgress', 'percentDone', 'error', 'errorString', 'files', 'fileStats'], hash);
          if (this.records.get(id) !== d || d.status === 'removed') throw new DownloadUndoFailure('conflict');
          if (!live || (live.error !== 0 && live.error !== 1 && live.error !== 2)) throw new Error('Disk verification failed');
          // recheckProgress is an in-flight counter; the daemon may reset it to
          // zero when a fast check finishes between polls. The confirmed stopped
          // activity after verify, not a permanent 100%, completes this wait.
          stoppedObservations = live.status === TrStatus.Stopped ? stoppedObservations + 1 : 0;
          if (stoppedObservations >= 2) {
            if (removalDataChanged(snapshot, mapFiles(live))) warnings.push('data-changed');
            d.progress = live.percentDone;
            await db.updateDownloadFields(id, { progress: d.progress });
            break;
          }
          if (Date.now() >= deadline) { warnings.push('verification-pending'); break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (snapshot.download.status === 'completed' && !warnings.includes('data-changed') && !warnings.includes('verification-pending')) await this.setStatus(d, 'completed');
      else if (snapshot.download.status === 'error') await this.setStatus(d, 'error', snapshot.download.lastError ?? undefined);
    } catch (error) {
      if (this.records.get(id) !== d || d.status === 'removed') throw error;
      warnings.push('engine');
      await this.setStatus(d, 'error', error instanceof Error ? error.message : 'Restore failed').catch(() => {});
    }
    return { warnings };
  }

  async activateRestoredDownload(id: string, previous: Download['status']): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    if (d.status !== 'paused') return;
    if (d.seedPaths?.length) { await this.resumeDownload(id); return; }
    if (previous === 'seeding' && this.idToHash.has(id)) {
      await this.startTorrents(this.idToHash.get(id)!); this.noteStart(d); await this.setStatus(d, 'seeding');
    } else await this.resumeDownload(id);
  }

  recheckDownload(id: string): Promise<void> {
    const pending = this.recheckRequests.get(id);
    if (pending) return pending;
    const work = this.performRecheck(id).finally(() => { if (this.recheckRequests.get(id) === work) this.recheckRequests.delete(id); });
    this.recheckRequests.set(id, work);
    return work;
  }

  private async performRecheck(id: string): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    if (d.seedPaths?.length) {
      if (ACTIVE.has(d.status)) await this.resumeDownload(id);
      else await this.addToDaemon(d, true);
      return;
    }
    const hash = await this.ensureInDaemon(d);
    const [live] = await this.rpc!.torrentGet(['status'], hash);
    if (live?.status === TrStatus.CheckWait || live?.status === TrStatus.Checking) return;
    if (this.records.get(id) !== d || d.status === 'removed') return;
    await this.rpc!.torrentVerify(hash);
  }

  async retryDownload(id: string): Promise<void> {
    await this.resumeDownload(id);
  }

  async stopSeeding(id: string): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = this.idToHash.get(id);
    if (hash) await this.rpc!.torrentStop(hash);
    this.pendingStarts.delete(id);
    await this.setStatus(d, 'completed');
  }

  async pauseAllActive(): Promise<number> {
    await this.whenReady();
    let n = 0;
    for (const d of this.records.values()) {
      if (ACTIVE.has(d.status)) { await this.pauseDownload(d.id); n++; }
    }
    return n;
  }

  async resumeAllPaused(): Promise<number> {
    await this.whenReady();
    let n = 0;
    for (const d of this.records.values()) {
      if (d.status === 'paused') { await this.resumeDownload(d.id); n++; }
    }
    return n;
  }

  // ── Reads ───────────────────────────────────────────────────────────────────
  getDownloads(): Promise<Download[]> { return db.getAllDownloads(); }
  getStats(): DownloadStats[] { return this.lastStats; }

  private async externalTorrent(hash: string): Promise<TrTorrent | undefined> {
    const cached = this.externalSnapshots.get(hash);
    if (cached && Date.now() - cached.at < 250) return cached.value;
    const pending = this.externalPending.get(hash); if (pending) return pending;
    const request = this.rpc!.torrentGet(['files', 'fileStats', 'pieceSize', 'pieceCount', 'pieces', 'status'], hash).then(([value]) => {
      this.externalSnapshots.set(hash, { at: Date.now(), value });
      if (this.externalSnapshots.size > 16) this.externalSnapshots.delete(this.externalSnapshots.keys().next().value!);
      return value;
    }).finally(() => this.externalPending.delete(hash));
    this.externalPending.set(hash, request); return request;
  }
  async getExternalMedia(id: string, relativePath: string): Promise<ExternalMedia> {
    const rel = mediaPath(relativePath); if (!rel) return { ok: false, reason: 'invalid-file' };
    await this.whenReady();
    const d = this.records.get(id), hash = this.idToHash.get(id);
    if (!d || !hash || d.status === 'removed') return { ok: false, reason: 'missing-file' };
    if (d.status !== 'downloading' && d.status !== 'seeding') return { ok: false, reason: 'paused-file' };
    const t = await this.externalTorrent(hash);
    const current = this.records.get(id);
    if (!current || current !== d || this.idToHash.get(id) !== hash || current.status === 'removed') return { ok: false, reason: 'missing-file' };
    if (current.status !== 'downloading' && current.status !== 'seeding') return { ok: false, reason: 'paused-file' };
    if (!t || (t.status !== TrStatus.Downloading && t.status !== TrStatus.Seeding)) return { ok: false, reason: 'paused-file' };
    const index = t.files?.findIndex(f => f.name.replace(/\\/g, '/') === rel) ?? -1;
    if (index < 0) return { ok: false, reason: 'missing-file' };
    if (!this.fileShouldDownload(d, index) || t.fileStats?.[index]?.wanted === false) return { ok: false, reason: 'excluded-file' };
    const meta = this.externalDisk.load(hash, d.torrentFilePath, getHostEnv().engineStateDir);
    if (!meta || !t.files || meta.files.length !== t.files.length || meta.pieceLength !== t.pieceSize || meta.pieces.length !== t.pieceCount || meta.files.some((f, i) => f.path.replace(/\\/g, '/') !== t.files![i].name.replace(/\\/g, '/') || f.length !== t.files![i].length)) return { ok: false, reason: 'unavailable' };
    return { ok: true, key: this.externalEpoch + ':' + hash + ':' + d.savePath, name: path.basename(rel), length: meta.files[index].length };
  }
  async readExternalMedia(id: string, relativePath: string, key: string, start: number, max: number): Promise<ExternalMediaRead> {
    const info = await this.getExternalMedia(id, relativePath);
    if (!info.ok) return { reason: info.reason };
    if (key !== info.key) return { reason: 'unavailable' };
    if (!Number.isSafeInteger(start) || start < 0 || start >= info.length || !Number.isSafeInteger(max) || max < 1 || max > 256 * 1024) return { reason: 'invalid-file' };
    const d = this.records.get(id), hash = this.idToHash.get(id);
    if (!d || !hash || d.status === 'removed') return { reason: 'missing-file' };
    const t = await this.externalTorrent(hash), meta = this.externalDisk.load(hash, d.torrentFilePath, getHostEnv().engineStateDir);
    if (!meta || this.idToHash.get(id) !== hash) return { reason: 'unavailable' };
    if (d.status !== 'downloading' && d.status !== 'seeding') return { reason: 'paused-file' };
    const index = meta.files.findIndex(f => f.path.replace(/\\/g, '/') === mediaPath(relativePath));
    const piece = Math.floor((meta.files[index].offset + start) / meta.pieceLength);
    if (!hasPiece(t?.pieces || '', piece)) return { wait: true };
    const data = await this.externalDisk.read(meta, d.savePath, index, start, max);
    return data ? { data: data.toString('base64') } : { wait: true };
  }

  async getHistoryFiles(id: string): Promise<TorrentFile[]> {
    await this.whenReady();
    const hash = this.idToHash.get(id);
    if (!hash || !this.rpc) return [];
    const [t] = await this.rpc.torrentGet(['files', 'fileStats'], hash);
    if (t?.files?.length) this.metaCache.set(id, t.files);
    return t ? mapFiles(t) : [];
  }

  async getFiles(id: string): Promise<TorrentFile[]> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = await this.ensureInDaemon(d);
    const [t] = await this.rpc!.torrentGet(['files', 'fileStats'], hash);
    if (!t) return [];
    if (t.files?.length) this.metaCache.set(id, t.files);
    return mapFiles(t);
  }

  async getPeers(id: string): Promise<PeerInfo[]> {
    await this.whenReady();
    const hash = this.idToHash.get(id);
    if (!hash) return [];
    const [t] = await this.rpc!.torrentGet(['peers'], hash);
    const peers = t ? mapPeers(t) : [];
    this.ensureGeoInit();
    const raw = t?.peers ?? [];
    for (let i = 0; i < peers.length; i++) {
      const cc = this.lookupCountry(raw[i]?.address ?? '');
      if (cc) peers[i].country = cc;
    }
    return peers;
  }

  async getTrackers(id: string): Promise<TrackerInfo[]> {
    await this.whenReady();
    const hash = this.idToHash.get(id);
    if (!hash) return [];
    const [t] = await this.rpc!.torrentGet(['trackerStats'], hash);
    return t ? mapTrackers(t) : [];
  }

  async reannounceDownload(id: string): Promise<void> {
    await this.whenReady();
    const hash = this.idToHash.get(id);
    if (!hash) throw new TorrentError('Download not found', 'NOT_FOUND', id);
    await this.rpc!.torrentReannounce(hash);
  }

  async getPieces(id: string): Promise<TorrentPieces> {
    await this.whenReady();
    const hash = this.idToHash.get(id);
    if (!hash) return EMPTY_PIECES;
    const [t] = await this.rpc!.torrentGet(['pieceCount', 'pieceSize', 'pieces'], hash);
    if (!t || !(t.pieceCount ?? 0)) return EMPTY_PIECES;
    return summarizePieces(t.pieces ?? '', t.pieceCount ?? 0, t.pieceSize ?? 0);
  }

  async setDownloadLocation(id: string, location: string, move: boolean): Promise<void> {
    await this.whenReady();
    const dest = location.trim();
    if (!dest) throw new TorrentError('Location is empty', 'INVALID_INPUT', id);
    const d = this.getRecord(id);
    if (d.seedPaths?.length) throw new TorrentError('Moving original seed sources is not supported. Their saved source paths must stay unchanged.', 'UNSUPPORTED', id);
    const hash = await this.ensureInDaemon(d);
    fs.mkdirSync(dest, { recursive: true });
    await this.rpc!.torrentSetLocation(hash, dest, move);
    d.savePath = dest;
    await db.updateDownloadField(id, 'savePath', dest);
  }

  /**
   * SYNCHRONOUS by contract (the cast server resolves in-process without an
   * async hop) — served from metaCache, which is warmed when metadata completes,
   * on completion, and by every getFiles() (the cast dialog lists files first).
   */
  getCastFileInfo(id: string, fileIndex: number): {
    name: string; length: number; diskPath: string; complete: boolean;
    kind: 'video' | 'audio' | 'other'; direct: boolean;
  } | null {
    const d = this.records.get(id);
    const files = this.metaCache.get(id);
    const f = files?.[fileIndex];
    if (!d || !f) return null;
    const name = path.basename(f.name);
    return {
      name,
      length: f.length,
      diskPath: path.join(d.savePath, f.name),
      complete: f.bytesCompleted >= f.length,
      kind: classifyMediaKind(name),
      direct: isDirectlyPlayable(name),
    };
  }

  // ── Per-torrent knobs ───────────────────────────────────────────────────────
  async setFilePriority(id: string, fileIndex: number, priority: FilePriority): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = await this.ensureInDaemon(d);
    if (priority === 'skip') {
      await this.rpc!.torrentSet(hash, { 'files-unwanted': [fileIndex] });
    } else {
      const key = priority === 'low' ? 'priority-low' : priority === 'high' ? 'priority-high' : 'priority-normal';
      await this.rpc!.torrentSet(hash, { 'files-wanted': [fileIndex], [key]: [fileIndex] });
    }
    const priorities = [...(d.filePriorities ?? [])];
    priorities[fileIndex] = priority;
    d.filePriorities = priorities;
    await db.updateDownloadField(id, 'filePriorities', priorities);
  }

  private async sequentialSettings(hash: string, enabled: boolean): Promise<Record<string, unknown>> {
    const [torrent] = await this.rpc!.torrentGet(['metadataPercentComplete', 'pieceCount'], hash);
    // Before a magnet has metadata (or for an empty torrent), even piece 0 is
    // outside its piece range. The mode itself may still be set immediately.
    const hasPieces = torrent?.metadataPercentComplete >= 1 && (torrent.pieceCount ?? 0) > 0;
    return { sequential_download: enabled, ...(hasPieces ? { sequential_download_from_piece: 0 } : {}) };
  }

  async setSequentialDownload(id: string, enabled: boolean): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = await this.ensureInDaemon(d);
    // Reset a previous stream offset only when the torrent has a piece range.
    await this.rpc!.torrentSet(hash, await this.sequentialSettings(hash, enabled));
    d.sequentialDownload = enabled;
    await db.updateDownloadField(id, 'sequentialDownload', enabled);
  }

  async setSeedRatioLimit(id: string, ratio: number): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const hash = this.idToHash.get(id);
    // Enforced by the daemon itself when live; persisted either way.
    if (hash) await this.rpc!.torrentSet(hash, { seedRatioLimit: ratio, seedRatioMode: ratio > 0 ? 1 : 2 });
    d.seedRatioLimit = ratio;
    await db.updateDownloadField(id, 'seedRatioLimit', ratio);
  }

  async setSeedTimeLimit(id: string, minutes: number): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    d.seedTimeLimitMinutes = minutes;
    await db.updateDownloadField(id, 'seedTimeLimitMinutes', minutes); // enforced by the stats tick
  }

  // ── IP blocklist ────────────────────────────────────────────────────────────
  /**
   * Push the app's merged [startInt,endInt] IPv4 ranges into the daemon.
   * transmission can't load a file:// blocklist, and won't hot-reload a dropped
   * file — but blocklist-update fetches from blocklist-url and compiles + activates
   * live. So serve the generated P2P list from a tiny loopback endpoint and point
   * the daemon at it. Awaited so a Peers-tab ban is in the daemon before the UI
   * refreshes; startup still fire-and-forgets via the same path.
   */
  applyIpBlocklist(ranges: Array<[number, number]>): Promise<void> {
    return this.applyBlocklist(ranges);
  }

  private async applyBlocklist(ranges: Array<[number, number]>): Promise<void> {
    await this.whenReady();
    if (!this.rpc) return;
    try {
      if (ranges.length === 0) { await this.rpc.sessionSet({ 'blocklist-enabled': false }); return; }
      this.blocklistBody = buildBlocklistP2P(ranges);
      const port = await this.ensureBlocklistServer();
      await this.rpc.sessionSet({ 'blocklist-url': `http://127.0.0.1:${port}/${this.blocklistToken}`, 'blocklist-enabled': true });
      const res = await this.rpc.blocklistUpdate();
      log.info('IP blocklist applied to daemon', { rules: res['blocklist-size'], ranges: ranges.length });
    } catch (e) {
      log.warn('blocklist apply failed', { error: String(e) });
      throw e;
    }
  }

  private ensureBlocklistServer(): Promise<number> {
    const existing = this.blocklistServer;
    if (existing) return Promise.resolve((existing.address() as { port: number }).port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Loopback-only + unguessable path; content is public IP ranges anyway.
        if (req.socket.remoteAddress && !/^(::1|::ffff:127\.|127\.)/.test(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return; }
        if ((req.url || '').endsWith(this.blocklistToken)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(this.blocklistBody); }
        else { res.writeHead(404); res.end(); }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { this.blocklistServer = server; resolve((server.address() as { port: number }).port); });
    });
  }

  // ── Swarm map ─────────────────────────────────────────────────────────────
  async getSwarmGeo(): Promise<SwarmGeo> {
    await this.whenReady();
    this.ensureGeoInit();
    const torrents = await this.rpc!.torrentGet(['hashString', 'peers']);
    const geo = aggregateSwarmGeo(torrents.map((t) => t.peers ?? []), (ip) => this.lookupCountry(ip));
    geo.dht = this.settings.enableDHT !== false;
    return geo;
  }

  private ensureGeoInit(): void {
    if (this.geoReady) return;
    try { ip3country.init(); this.geoReady = true; }
    catch (e) { log.warn('Country geo DB init failed (swarm map degraded)', { error: String(e) }); }
  }

  /** transmission peer.address is a bare IP (no port). null = IPv6/private/unknown. */
  private lookupCountry(ip: string): string | null {
    if (!this.geoReady || !ip || isPrivateOrReservedIPv4(ip)) return null;
    try { const cc = ip3country.lookupStr(ip); return cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null; }
    catch { return null; }
  }

  // ── Tracker CRUD (torrent-set trackerList RMW; 4.0+ replaces trackerAdd/Remove) ──
  async addTracker(id: string, url: string): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const normalized = normalizeTrackerUrl(url);
    const custom = new Set(d.customTrackers ?? []); custom.add(normalized);
    const removed = new Set(d.removedTrackers ?? []); removed.delete(normalized);
    d.customTrackers = [...custom]; d.removedTrackers = [...removed];
    await db.updateDownloadFields(id, { customTrackers: d.customTrackers, removedTrackers: d.removedTrackers });
    const hash = this.idToHash.get(id);
    if (hash) await this.applyTrackerListEdit(hash, { add: [normalized] });
    log.info('Tracker added', { id, url: normalized });
  }

  async removeTracker(id: string, url: string): Promise<void> {
    await this.whenReady();
    const d = this.getRecord(id);
    const normalized = stripTrackerSlash(url); // no protocol validation — metadata trackers can be removed too
    const custom = new Set(d.customTrackers ?? []); custom.delete(normalized);
    const removed = new Set(d.removedTrackers ?? []); removed.add(normalized);
    d.customTrackers = [...custom]; d.removedTrackers = [...removed];
    await db.updateDownloadFields(id, { customTrackers: d.customTrackers, removedTrackers: d.removedTrackers });
    const hash = this.idToHash.get(id);
    if (hash) await this.applyTrackerListEdit(hash, { remove: [normalized] });
    log.info('Tracker removed', { id, url: normalized });
  }

  private async applyTrackerListEdit(hash: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const [t] = await this.rpc!.torrentGet(['trackerList'], hash);
    await this.rpc!.torrentSet(hash, { trackerList: editTrackerList(t?.trackerList, opts) });
  }

  // ── Seed the saved metadata from its actual on-disk layout ─────────────────
  async addSeed(params: { sourcePaths: string[]; name?: string; announceList?: string[][]; pieceLength?: number; torrentFilePath?: string; expectedInfoHash?: string; retryExisting?: boolean }): Promise<Download> {
    await this.whenReady();
    assertTransfersAllowed();
    const { metadata, paths } = await prepareSeed(params.torrentFilePath, params.sourcePaths, params.expectedInfoHash);
    const root = nativeSeedRoot(metadata, paths);
    const existingId = this.hashToId.get(metadata.infoHash);
    const existing = existingId ? this.records.get(existingId) : undefined;
    if (params.retryExisting && existing && sameSeedSources(existing.seedPaths, params.sourcePaths)) {
      await prepareSeed(existing.torrentFilePath ?? undefined, existing.seedPaths!, metadata.infoHash);
      if (['paused', 'queued', 'error', 'completed'].includes(existing.status)) await this.resumeDownload(existing.id);
      if (existing.status === 'error') throw new TorrentError(existing.lastError || 'Could not start seeding', 'ADD_FAILED', existing.id);
      return existing;
    }
    if (this.hashToId.has(metadata.infoHash)) throw new TorrentError('This torrent is already in your downloads', 'DUPLICATE', this.hashToId.get(metadata.infoHash));
    const stored = await persistSeedMetadata(metadata, getHostEnv().userDataDir);
    let attached = false, download: Download | undefined;
    try {
      const res = await this.attachSeedPaused(metadata, root);
      if (res.duplicate) throw new TorrentError('This torrent is already in your downloads', 'DUPLICATE', this.hashToId.get(metadata.infoHash));
      attached = true;
      await this.verifySeed(metadata.infoHash, metadata.length);
      download = await db.createDownload({ name: metadata.name, infoHash: metadata.infoHash,
        sourceType: 'torrent_file', sourceUri: params.sourcePaths[0], torrentFilePath: stored,
        savePath: path.dirname(root), status: 'queued', seedPaths: params.sourcePaths });
      download.totalSize = metadata.length;
      download.progress = 1;
      download.seedingStartedAt = Date.now();
      await db.updateDownloadFields(download.id, { totalSize: metadata.length, progress: 1, seedingStartedAt: download.seedingStartedAt });
      this.records.set(download.id, download);
      this.link(download.id, metadata.infoHash);
      await this.startTorrents(metadata.infoHash);
      await this.setStatus(download, 'seeding');
      this.noteStart(download);
      void this.warmMetaCache(download.id);
      return download;
    } catch (error) {
      if (attached) await this.rpc!.torrentRemove(metadata.infoHash, false).catch(() => {});
      if (download) {
        this.records.delete(download.id);
        this.idToHash.delete(download.id); this.hashToId.delete(metadata.infoHash);
        await db.deleteDownload(download.id).catch(() => {});
      }
      await fs.promises.unlink(stored).catch(() => {});
      throw error;
    }
  }

  /** Remap inside an EMPTY directory first: rename-path must never move an
   * unrelated existing folder that happens to have the chosen torrent name. */
  private async attachSeedPaused(metadata: SeedMetadata, root: string, reuse = false) {
    const mappingParent = path.join(getHostEnv().userDataDir, 'seed-mapping');
    await fs.promises.mkdir(mappingParent, { recursive: true });
    const mapping = await fs.promises.mkdtemp(path.join(mappingParent, 'map-'));
    let createdHash: string | undefined;
    try {
      const res = await this.rpc!.torrentAdd({ metainfo: metadata.bytes, downloadDir: mapping, paused: true });
      if (res.duplicate && !reuse) return res;
      const hash = res.hashString.toLowerCase();
      if (!res.duplicate) createdHash = hash;
      if (hash !== metadata.infoHash) throw new TorrentError('The engine returned a different torrent identity', 'INVALID_INPUT');
      // Even paused additions may trigger automatic verification. Stop that
      // work before changing paths. The sidecar disables incomplete-dir, so
      // rename-path resolves against this empty download directory only.
      await this.rpc!.torrentStop(hash);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [live] = await this.rpc!.torrentGet(['status'], hash);
        if (!live) throw new TorrentError('Seed disappeared before remapping', 'NOT_FOUND');
        if (live.status === TrStatus.Stopped) break;
        if (Date.now() > deadline) throw new TorrentError('Seed has not stopped yet; retry remapping', 'NOT_ACTIVE');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const place = async (directory: string) => {
        await this.rpc!.torrentSetLocation(hash, directory, false);
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [live] = await this.rpc!.torrentGet(['downloadDir'], hash);
          if (!live) throw new TorrentError('Seed disappeared during remapping', 'NOT_FOUND');
          if (live.downloadDir && torrentSourceKey(live.downloadDir) === torrentSourceKey(directory)) return;
          if (Date.now() > deadline) throw new TorrentError('Seed directory remapping timed out', 'TIMEOUT');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      await place(mapping);
      const diskName = path.basename(root);
      if (!diskName) throw new TorrentError('Cannot use a filesystem volume as a torrent root', 'INVALID_INPUT');
      if (res.name !== diskName) await this.rpc!.torrentRenamePath(hash, res.name, diskName);
      await place(path.dirname(root));
      return res;
    } catch (error) {
      if (createdHash) await this.rpc!.torrentRemove(createdHash, false).catch(() => {});
      throw error;
    } finally {
      // This directory was created above and never contains user data. rmdir
      // only removes an empty directory, even if the daemon behaved unexpectedly.
      await fs.promises.rmdir(mapping).catch(error => log.warn('Seed mapping directory retained', { mapping, error: String(error) }));
    }
  }

  /** Do not start a download into the original files when verification fails. */
  private async verifySeed(hash: string, expectedSize: number): Promise<void> {
    await this.rpc!.torrentVerify(hash);
    const requestedAt = Date.now();
    let previous = '', changedAt = requestedAt, sawChecking = false;
    for (;;) {
      const [torrent] = await this.rpc!.torrentGet(['hashString', 'status', 'recheckProgress', 'leftUntilDone', 'totalSize', 'haveValid', 'haveUnchecked', 'error', 'errorString'], hash);
      if (!torrent || torrent.hashString?.toLowerCase() !== hash) throw new TorrentError('Seed disappeared during verification', 'NOT_FOUND');
      if (torrent.error === 3) throw new TorrentError(torrent.errorString || 'Could not read the seed files', 'FILE_NOT_FOUND');
      const progress = torrent.status + ':' + torrent.recheckProgress;
      if (progress !== previous) { previous = progress; changedAt = Date.now(); }
      const checking = torrent.status === TrStatus.CheckWait || torrent.status === TrStatus.Checking;
      if (checking) sawChecking = true;
      // Transmission resets recheckProgress after checking. The completed
      // state and verified byte count, rather than a retained 100%, are decisive.
      // Stats can be cached for the current second. Do not accept the old
      // stopped/verified snapshot before the requested verify has become visible.
      if (!checking && (sawChecking || Date.now() - requestedAt >= 1100)) {
        if (torrent.totalSize !== expectedSize || torrent.leftUntilDone !== 0 || torrent.haveUnchecked !== 0 || torrent.haveValid !== expectedSize) throw new TorrentError('Source files no longer match the saved torrent. Restore the originals or recreate the torrent.', 'INVALID_INPUT');
        return;
      }
      if (Date.now() - changedAt > 5 * 60_000) throw new TorrentError('Seed verification stopped making progress', 'TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  // ── In-app streaming ─────────────────────────────────────────────────────────
  async getStreamUrl(id: string, fileIndex: number, opts?: { transcode?: boolean; audioTrack?: number; startTime?: number; noResume?: boolean }): Promise<{ url: string; name: string; kind: 'video' | 'audio' | 'other'; transcoded: boolean; startTime?: number }> {
    const requestedStart = streamStartSeconds(opts?.startTime);
    await this.whenReady();
    const d = this.getRecord(id);
    if (opts?.noResume && (d.status !== 'downloading' && d.status !== 'seeding' || !this.idToHash.has(id))) throw new TorrentError('Media unavailable: resume the download manually', 'NOT_ACTIVE', id);
    const hash = opts?.noResume ? this.idToHash.get(id)! : await this.ensureInDaemon(d);
    this.startingStreams.set(id, (this.startingStreams.get(id) ?? 0) + 1);
    try {
      // ensureInDaemon re-adds a non-live record PAUSED — a stream needs it running
      // or the head never downloads.
      if (!opts?.noResume) {
        assertTransfersAllowed();
        await this.rpc!.torrentStartNow(hash);
        this.noteStart(d);
      }
      if (d.status === 'paused' || d.status === 'queued') await this.setStatus(d, d.progress >= 1 ? 'seeding' : 'downloading');
      if (!this.metaCache.get(id)?.[fileIndex]) await (opts?.noResume ? this.getHistoryFiles(id) : this.getFiles(id)); // read-only history must never re-add a daemon record
      const info = this.getCastFileInfo(id, fileIndex);
      if (!info) throw new TorrentError('Invalid file index', 'INVALID_INPUT', id);
      await this.prioritizeStreamHead(hash, id, fileIndex);

      const port = await this.ensureMediaServer();
      const q = `k=${this.streamToken}&t=${Date.now()}`;
      const wantTranscode = opts?.transcode === true || !info.direct;
      const mode = wantTranscode && this.ffmpegPath ? 'transcode' : 'direct';
      // Audio-track choice rides the URL (a new URL remounts <video key={url}> in
      // the renderer, which closes the old response and thereby kills the old
      // ffmpeg — the same restart mechanism forceTranscode already uses). Only
      // meaningful for transcode; the guard only checks k=, extra params are safe.
      const audio = mode === 'transcode' ? audioTrackParam(opts?.audioTrack) : '';
      const startTime = mode === 'transcode' ? requestedStart : 0;
      return {
        url: `http://127.0.0.1:${port}/${mode}/${encodeURIComponent(id)}/${fileIndex}?${q}${audio}${streamStartParam(startTime)}`,
        name: info.name,
        kind: info.kind,
        transcoded: mode === 'transcode',
        startTime,
      };
    } finally {
      const remaining = (this.startingStreams.get(id) ?? 1) - 1;
      if (remaining > 0) this.startingStreams.set(id, remaining);
      else this.startingStreams.delete(id);
    }
  }

  async stopStream(id: string, _fileIndex?: number): Promise<void> {
    await this.whenReady();
    const d = this.records.get(id);
    const streamed = this.streamHeads.get(id);
    this.streamHeads.delete(id);
    const hash = this.idToHash.get(id);
    if (!d || !hash || !streamed) return;
    // Revert to the user's intent: restore sequential mode AND the sequential
    // start offset (a stream steers it to the file's first piece — leaving it
    // there permanently corrupts a later whole-torrent sequential download), and
    // restore each streamed file to its PERSISTED priority (not a blanket
    // 'normal', which would silently erase a user-set high/low), re-deselecting
    // any file that shouldn't download.
    const args = await this.sequentialSettings(hash, d.sequentialDownload === true)
      .catch(() => ({ sequential_download: d.sequentialDownload === true } as Record<string, unknown>));
    const unwanted: number[] = [], high: number[] = [], low: number[] = [], normal: number[] = [];
    for (const idx of streamed) {
      if (!this.fileShouldDownload(d, idx)) { unwanted.push(idx); continue; }
      const p = d.filePriorities?.[idx];
      (p === 'high' ? high : p === 'low' ? low : normal).push(idx);
    }
    if (unwanted.length) args['files-unwanted'] = unwanted;
    if (high.length) args['priority-high'] = high;
    if (low.length) args['priority-low'] = low;
    if (normal.length) args['priority-normal'] = normal;
    await this.rpc!.torrentSet(hash, args).catch((e) => log.warn('stopStream revert failed', { id, error: String(e) }));
  }

  private async prioritizeStreamHead(hash: string, id: string, fileIndex: number): Promise<void> {
    await this.rpc!.torrentSet(hash, { 'files-wanted': [fileIndex], 'priority-high': [fileIndex], sequential_download: true });
    // Steer the sequential start to the file's first piece (0 for a single/first
    // file) so a file inside a MULTI-file torrent streams head-first. ALWAYS set
    // it (incl. 0) so a prior stream's offset can't linger; stopStream resets to
    // 0. Separate call: an unsupported field on an older daemon must not fail the
    // essential priority set above.
    let begin = 0;
    try {
      const [t] = await this.rpc!.torrentGet(['pieceSize', 'files'], hash);
      const pieceSize = t?.pieceSize ?? 0;
      if (pieceSize > 0) begin = fileBeginPiece((t?.files ?? []).map((f) => f.length), fileIndex, pieceSize);
    } catch { /* keep begin = 0 */ }
    await this.rpc!.torrentSet(hash, { sequential_download_from_piece: begin }).catch(() => undefined);
    let set = this.streamHeads.get(id);
    if (!set) { set = new Set(); this.streamHeads.set(id, set); }
    set.add(fileIndex);
  }

  getEngineCapabilities() { return engineCapabilities('native'); }
  getEpisodePrefetchSupport(): { supported: boolean } { return { supported: this.getEngineCapabilities().features.boundedEpisodePrefetch.supported }; }
  async prefetchEpisode(_id: string, request: EpisodePrefetchRequest): Promise<EpisodePrefetchResult> {
    validateEpisodePrefetch(request);
    return { state: 'unsupported', bytes: 0 };
  }
  async stopEpisodePrefetch(_id: string, _lease: string): Promise<void> { /* no bounded selection API */ }

  private ensureMediaServer(): Promise<number> {
    if (!this.mediaServer) {
      this.mediaServer = new NativeMediaServer(
        (id, idx) => {
          const info = this.getCastFileInfo(id, idx);
          return info ? { diskPath: info.diskPath, length: info.length, name: info.name, kind: info.kind } : null;
        },
        () => this.ffmpegPath,
        (id, idx) => this.fileBytesCompleted(id, idx),
        this.streamToken,
      );
    }
    return this.mediaServer.ensure();
  }

  /** Contiguous downloaded bytes of a file (from the live daemon — files are sparse). */
  private async fileBytesCompleted(id: string, fileIndex: number): Promise<number> {
    const hash = this.idToHash.get(id);
    if (!hash || !this.rpc) return 0;
    const [t] = await this.rpc.torrentGet(['files'], hash);
    return t?.files?.[fileIndex]?.bytesCompleted ?? 0;
  }

  private fileShouldDownload(d: Download, fileIndex: number): boolean {
    return torrentFilePriority(d, fileIndex) !== 'skip';
  }

  // ── Audio tracks (multi-audio MKV — selection restarts the transcode with -map) ──
  async getAudioTracks(id: string, fileIndex: number): Promise<AudioTrackListItem[]> {
    await this.whenReady();
    if (!this.metaCache.get(id)?.[fileIndex]) await this.getFiles(id).catch(() => undefined);
    const info = this.getCastFileInfo(id, fileIndex);
    if (!info) throw new TorrentError('Audio source is unavailable', 'NOT_FOUND', id);
    return audioTrackList(await probeAudioStreams(this.ffmpegPath, info.diskPath, true));
  }

  // ── Subtitles (disk + ffmpeg — engine-agnostic, ported from the webtorrent manager) ──
  async getSubtitleTracks(id: string, fileIndex: number): Promise<SubtitleTrack[]> {
    await this.whenReady();
    if (!this.metaCache.get(id)?.[fileIndex]) await this.getFiles(id).catch(() => undefined);
    const info = this.getCastFileInfo(id, fileIndex);
    return info ? listSubtitleTracks(this.ffmpegPath, info.diskPath) : [];
  }

  async getSubtitleVtt(id: string, fileIndex: number, key: string): Promise<string> {
    await this.whenReady();
    if (!this.metaCache.get(id)?.[fileIndex]) await this.getFiles(id).catch(() => undefined);
    const info = this.getCastFileInfo(id, fileIndex);
    if (!info) throw new TorrentError('File not found', 'NOT_FOUND', id);
    return extractSubtitleVtt(this.ffmpegPath, info.diskPath, key);
  }

  /**
   * Null: the daemon applies dht/pex/lpd/utp live over session-set, so a changed
   * transport toggle is never owed a restart here and the renderer must not
   * offer one. The asymmetry with webtorrent is the engine's, not the setting's.
   */
  getRunningTransport(): RunningTransport | null {
    return null;
  }

  /** Live snapshot for the adaptive-throttle indicator in the UI. */
  getNetworkHealth(): NetworkHealth {
    const st = this.adaptive?.getState() ?? null;
    return {
      adaptive: {
        active: this.adaptiveUploadEnabled && !!st?.active,
        latencyMs: st?.latencyMs ?? null,
        baselineMs: st?.baselineMs != null ? Math.round(st.baselineMs) : null,
        capKbps: st && st.capBytes > 0 ? Math.round(st.capBytes / 1024) : -1,
        congested: st?.congested ?? false,
      },
      uploadBps: this.lastStats.reduce((a, s) => a + s.upSpeedBps, 0),
    };
  }

  // ── Events ──────────────────────────────────────────────────────────────────
  onStats(cb: (s: DownloadStats[]) => void): () => void { this.statsCbs.add(cb); return () => this.statsCbs.delete(cb); }
  onComplete(cb: (i: { id: string; name: string }) => void): () => void { this.completeCbs.add(cb); return () => this.completeCbs.delete(cb); }
  onListening(cb: () => void): () => void { this.listeningCbs.add(cb); return () => this.listeningCbs.delete(cb); }

  // ── Stats loop ──────────────────────────────────────────────────────────────
  private noteStart(d: Download) {
    // An RPC acknowledgement can precede the daemon's actual state change.
    // Ignore the current poll and briefly retain start intent across Stopped
    // snapshots, rather than persisting a spurious pause after resume.
    const starting = { poll: this.pollGeneration, until: Date.now() + 30_000, retryAt: Date.now() + 1000, awaitingStop: false };
    this.pendingStarts.set(d.id, starting);
    return starting;
  }
  /** Lowering the limit must also defer downloads which are already running.
   * Playback holds its slot even if several viewers temporarily exceed the cap. */
  private async enforceDownloadLimit(rpc: TransmissionRpc, torrents: TrTorrent[]): Promise<void> {
    const running = torrents.flatMap(t => {
      const id = this.hashToId.get(t.hashString.toLowerCase());
      const d = id ? this.records.get(id) : undefined;
      return d && ACTIVE.has(d.status) && t.status === TrStatus.Downloading && t.percentDone < 1 ? [{ d, t }] : [];
    });
    const limit = this.queueSettings(this.settings)['download-queue-size'] as number;
    if (running.length <= limit) return;
    const isStreaming = (d: Download) => this.streamHeads.has(d.id) || this.startingStreams.has(d.id);
    const streams = running.filter(({ d }) => isStreaming(d));
    const ordinary = running.filter(({ d }) => !isStreaming(d))
      .sort((a, b) => (b.d.priority ?? 0) - (a.d.priority ?? 0));
    const overflow = ordinary.slice(Math.max(0, limit - streams.length));
    if (!overflow.length || this.rpc !== rpc) return;
    const hashes = overflow.map(({ t }) => t.hashString);
    await rpc.torrentStop(hashes);
    if (this.rpc !== rpc) return;
    // A pause/remove while RPC was in flight takes precedence over re-queuing.
    const pending = overflow.filter(({ d, t }) => ACTIVE.has(d.status) && this.idToHash.get(d.id) === t.hashString.toLowerCase());
    if (pending.length) await this.startTorrents(pending.map(({ t }) => t.hashString));
    for (const { d, t } of pending) {
      if (this.rpc !== rpc) return;
      if (!ACTIVE.has(d.status)) {
        // A user pause which arrived during restart still wins.
        if (d.status === 'paused' || d.status === 'completed') await rpc.torrentStop(t.hashString);
        continue;
      }
      this.noteStart(d);
      await this.setStatus(d, 'queued');
    }
  }

  private async tick(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.tickInFlight) return;
    this.tickInFlight = true;
    const poll = ++this.pollGeneration;
    try {
      const withPeers = Date.now() >= this.nextPeerStatsAt;
      const torrents = await rpc.torrentGet(withPeers ? [...ENGINE_STAT_FIELDS, 'peers'] : ENGINE_STAT_FIELDS);
      if (this.rpc !== rpc) return; // shutdown/restart invalidates the response
      await this.enforceDownloadLimit(rpc, torrents);
      if (this.rpc !== rpc) return;
      if (withPeers) this.nextPeerStatsAt = Date.now() + PEER_STATS_INTERVAL_MS;
      const byHash = new Map(torrents.map((t) => [t.hashString.toLowerCase(), t]));
      const stats: DownloadStats[] = [];
      for (const d of this.records.values()) {
        if (d.status === 'removed') continue;
        const hash = this.idToHash.get(d.id);
        let t = hash ? byHash.get(hash) : undefined;
        const starting = this.pendingStarts.get(d.id);
        if (starting) {
          const fatal = t && t.error !== 0 && t.error !== 1 && t.error !== 2;
          if (starting.awaitingStop || poll <= starting.poll) t = undefined;
          else if (t?.status === TrStatus.Stopped && !fatal && Date.now() < starting.until) {
            // Stop acknowledgement can precede the end of asynchronous stop I/O.
            // A start during that window can be lost. Retry the user's pending
            // intent at most once a second, until activity actually confirms it.
            if (hash && ACTIVE.has(d.status) && Date.now() >= starting.retryAt) {
              starting.retryAt = Date.now() + 1000;
              await this.startTorrents(hash);
              if (this.rpc !== rpc) return;
              // A new pause during this RPC still wins over the old start.
              if ((d.status === 'paused' || d.status === 'completed') && this.pendingStarts.get(d.id) !== starting) {
                await rpc.torrentStop(hash);
                if (this.rpc !== rpc) return;
              }
            }
            t = undefined;
          }
          else this.pendingStarts.delete(d.id);
        }
        // Explicit stop intent wins while Transmission asynchronously closes
        // peers. It must not resurrect a paused/completed record in the DB.
        const checking = t?.status === TrStatus.Checking || t?.status === TrStatus.CheckWait;
        if ((d.status === 'paused' || d.status === 'completed') && t?.status !== TrStatus.Stopped && !checking) t = undefined;
        if (t && (!checking || (t.error !== 0 && t.error !== 1 && t.error !== 2))) await this.applyTransitions(d, t);
        if (this.rpc !== rpc) return;
        if ((d.status === 'paused' || d.status === 'completed') && t?.status !== TrStatus.Stopped && !checking) t = undefined;
        if (!t || !t.peersConnected || t.status === TrStatus.Stopped || t.status === TrStatus.DownloadWait) this.seedCounts.delete(d.id);
        else if (t.peers) this.seedCounts.set(d.id, t.peers.reduce((count, peer) => count + (peer.progress >= 1 ? 1 : 0), 0));
        stats.push(mapStats(d, t, this.seedCounts.get(d.id)));
      }
      this.lastStats = stats;
      for (const cb of this.statsCbs) { try { cb(stats); } catch { /* ignore */ } }
      if (++this.persistCounter >= PERSIST_EVERY_TICKS) {
        this.persistCounter = 0;
        await db.updateDownloadsProgressBatch(stats.map((s) => ({
          id: s.id, progress: s.progress, downloadedBytes: s.downloadedBytes, uploadedBytes: s.uploadedBytes,
          downSpeedBps: s.downSpeedBps, upSpeedBps: s.upSpeedBps, etaSeconds: s.etaSeconds, peers: s.peers, seeds: s.seeds,
        })));
      }
    } finally { this.tickInFlight = false; }
  }

  /** Detect and persist lifecycle transitions surfaced by the daemon. */
  private async applyTransitions(d: Download, t: TrTorrent): Promise<void> {
    const rpc = this.rpc;
    // totalSize is the complete torrent's metadata size. sizeWhenDone depends
    // on wanted files and must not become the persisted total (including on
    // restore). Repair old values once; an unchanged size needs no DB write.
    if (t.metadataPercentComplete >= 1 && Number.isSafeInteger(t.totalSize) && t.totalSize > 0 && d.totalSize !== t.totalSize) {
      const metadataArrived = !(Number.isFinite(d.totalSize) && d.totalSize > 0);
      const fields: Partial<Download> = { totalSize: t.totalSize };
      d.totalSize = t.totalSize;
      if (metadataArrived) {
        d.name = t.name;
        fields.name = t.name;
      }
      await db.updateDownloadFields(d.id, fields);
      if (this.rpc !== rpc || d.status === 'removed') return;
      // First metadata arrival also resolves the name/cast cache and the
      // add-dialog's selection. A size repair must not reapply that selection.
      if (metadataArrived) {
        void this.warmMetaCache(d.id);
        if (d.selectedFiles?.length || d.filePriorities?.length) this.pendingFileSettings.add(d.id);
      }
    }
    if (t.metadataPercentComplete >= 1 && this.pendingFileSettings.has(d.id)) {
      await this.applyFileSettings(d).catch(error => log.warn('File selection retry failed', { id: d.id, error: String(error) }));
    }

    // A user control may have arrived while metadata was being persisted.
    if (this.rpc !== rpc || d.status === 'removed') return;
    if ((d.status === 'paused' || d.status === 'completed') && t.status !== TrStatus.Stopped) return;
    const starting = this.pendingStarts.get(d.id);
    if (starting && starting.poll >= this.pollGeneration) return;

    d.progress = t.percentDone;
    d.downloadedBytes = (d.nativeSessionBase?.downloaded ?? 0) + t.downloadedEver;
    d.uploadedBytes = (d.nativeSessionBase?.uploaded ?? 0) + t.uploadedEver;

    const mapped = mapStatus(t, d.status);
    if (mapped !== d.status) {
      log.info('Torrent state changed in daemon', {
        id: d.id, previousStatus: d.status, status: mapped,
        daemonStatus: t.status, errorCode: t.error, progress: t.percentDone,
        maxDownKbps: this.settings.maxDownKbps ?? 0,
        altSpeedEnabled: this.altSpeedEnabled,
      });
      const wasDownloading = d.status === 'downloading' || d.status === 'queued';
      if (mapped === 'error') {
        await this.setStatus(d, 'error', t.errorString || 'engine error');
      } else {
        await this.setStatus(d, mapped);
        if (wasDownloading && (mapped === 'seeding' || mapped === 'completed')) {
          d.seedingStartedAt = Date.now();
          await db.updateDownloadFields(d.id, { seedingStartedAt: d.seedingStartedAt, automationCompletedAt: Date.now() });
          void this.warmMetaCache(d.id); // refresh `complete` flags for cast
          log.info('Torrent completed', { id: d.id, name: d.name });
          for (const cb of this.completeCbs) { try { cb({ id: d.id, name: d.name }); } catch { /* ignore */ } }
        }
      }
    }

    // The daemon enforces ordinary ratios. Undo re-adds its entry with fresh
    // counters, so restored records also need the original lifetime ratio here.
    if (d.status === 'seeding') {
      const ratioLimit = d.seedRatioLimit ?? this.settings.defaultSeedRatioLimit ?? 0;
      if (d.nativeSessionBase && ratioLimit > 0 && d.downloadedBytes > 0 && d.uploadedBytes / d.downloadedBytes >= ratioLimit) {
        await this.stopSeeding(d.id);
        return;
      }
      const limitMin = d.seedTimeLimitMinutes ?? this.settings.defaultSeedTimeLimitMinutes ?? 0;
      if (limitMin > 0 && d.seedingStartedAt && Date.now() - d.seedingStartedAt > limitMin * 60_000) {
        log.info('Seed time limit reached — stopping', { id: d.id, limitMin });
        await this.stopSeeding(d.id);
      }
    }
  }

  private async warmMetaCache(id: string): Promise<void> {
    try {
      const hash = this.idToHash.get(id);
      if (!hash || !this.rpc) return;
      const [t] = await this.rpc.torrentGet(['files'], hash);
      if (t?.files?.length) this.metaCache.set(id, t.files);
    } catch { /* cast cache is best-effort */ }
  }

  /** Restore the latest intent, including after metadata returns to a recreated magnet. */
  private async applyFileSettings(d: Download): Promise<void> {
    if (!d.selectedFiles?.length && !d.filePriorities?.length) return;
    this.pendingFileSettings.add(d.id);
    const hash = this.idToHash.get(d.id), rpc = this.rpc;
    if (!hash || !rpc) return;
    const [torrent] = await rpc.torrentGet(['files'], hash);
    if (!torrent?.files?.length || this.rpc !== rpc || this.idToHash.get(d.id) !== hash || d.status === 'removed') return;
    const unwanted: number[] = [], wanted: number[] = [], low: number[] = [], normal: number[] = [], high: number[] = [];
    const priorities = d.filePriorities, selectedFiles = d.selectedFiles;
    const selected = new Set(selectedFiles ?? []);
    for (let index = 0; index < torrent.files.length; index++) {
      const priority = torrentFilePriority(d, index, selected);
      if (priority === 'skip') unwanted.push(index);
      else { wanted.push(index); (priority === 'high' ? high : priority === 'low' ? low : normal).push(index); }
    }
    const args: Record<string, unknown> = {};
    if (unwanted.length) args['files-unwanted'] = unwanted;
    if (wanted.length) args['files-wanted'] = wanted;
    if (low.length) args['priority-low'] = low;
    if (normal.length) args['priority-normal'] = normal;
    if (high.length) args['priority-high'] = high;
    await rpc.torrentSet(hash, args);
    if (this.rpc === rpc && this.idToHash.get(d.id) === hash && d.filePriorities === priorities && d.selectedFiles === selectedFiles) this.pendingFileSettings.delete(d.id);
  }
}

/** Complement of `selected` over the torrent's file list (undefined = keep all). */
function unwantedIndices(torrentBuf: Buffer, selected?: number[]): number[] | undefined {
  if (!selected || selected.length === 0) return undefined;
  try {
    const total = parseTorrent(torrentBuf).files?.length ?? 0;
    const keep = new Set(selected);
    const unwanted = Array.from({ length: total }, (_, i) => i).filter((i) => !keep.has(i));
    return unwanted.length > 0 ? unwanted : undefined;
  } catch {
    return undefined; // unparseable → let the daemon decide; selection can be fixed post-add
  }
}
