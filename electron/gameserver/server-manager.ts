/**
 * ServerManager — the main-process facade for game servers, in the same role
 * RoomManager plays for rooms: it owns the live objects, mediates every IPC
 * call, and pushes one derived state object to the renderer.
 *
 * ONE INSTANCE = ONE SUPERVISOR + ONE ANNOUNCER + ONE PROBE TIMER. Everything
 * per-instance hangs off the entry below, so teardown is a single loop and there
 * is no way to leak a process, a socket or a timer past dispose().
 *
 * The vIP is injected rather than imported: the LAN session lives in the room
 * engine and this module has no business reaching into it, so main wires a
 * getter at startup. Absent vIP simply means "no tunnel" — the server still
 * runs, it just cannot be advertised to anyone else, and the panel says so.
 */
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../utils';
import { Supervisor } from './supervisor';
import { Announcer } from './announcer';
import { runInstallPlan, InstallCancelled } from './installer';
import { resolveRuntime, ensureRuntime, detectSystemJava, forgetSystemJava } from './runtime-store';
import { fetchJsonCached, fetchTextCached } from './fetcher';
import { getModule, moduleSummaries } from './modules';
import { pingMinecraft } from './modules/minecraft/slp';
import {
  commitImport, discardImport, purgeStaging, stageImport, stagingExists,
} from './import-store';
import {
  ensureInstanceDirs, importStagingDir, instancePaths, listTree, removeInstanceDir, resolveUnder,
} from './paths';
import { estimateInstallBytes, findFreePort, freeBytes } from './host-resources';
import {
  getInstance, getInstances, listInstancesForRoom, upsertInstance, removeInstance,
  isLegalAccepted, acceptLegal, hasContentConsent, recordContentConsent,
  listOperators, grantOperator, revokeOperator, roleFor,
  type PersistedInstance,
} from '../db/servers-store';
import type {
  CatalogCtx, ConfigField, ConsoleLine, ContentSyncState, GameEvent, GameModule, GameVersionRef,
  ImportScanResult, InstanceView, PendingContentConsent, RoomServerInstance, RoomServerState,
  ServerAccessState, ServerContentSlotView, ServerContentState, ServerRole, ServerScheduleRule,
  ServerScheduleState, ServerStatus, ServerPlayersState, ServerAlert,
  MirroredServerInstance, ServerMirrorState, WorldBackupEntry,
} from '../../shared/gameserver-types';
import { IMPORT_JAVA_MAJORS } from '../../shared/gameserver-types';
import { validateConfigValues } from '../../shared/gameserver-core';
import { ServerActionError } from '../../shared/gameserver-errors';
import {
  computeContentManifest, filesInFolder, syncContentSlots, type RoomContentFile,
} from './content-sync';
import { backupTagNow, backupWorldDir, listWorldBackups, createWorldBackup, restoreWorldBackup, deleteWorldBackup, backupsFolder } from './world-backup';
import { findDueScheduleActions, minutesToEvaluate, sanitizeScheduleRule } from './server-scheduler';
import { readWhitelist, writeWhitelist, readBannedPlayers, writeBannedPlayers } from './minecraft-access';
import { buildMirrorPayload, mirrorFingerprint, mirroredRole, type ConsoleTailSample } from './server-mirror';
import { alertOnStatusChange, alertOnLowDisk, AlertThrottle } from './server-alerts';

const log = logger.child('ServerManager');

/** How often a running instance is probed for its real population. */
const PROBE_INTERVAL_MS = 15_000;
/** How often scheduled start/stop rules are evaluated. Rules match an exact
 *  minute, so this ticks well inside one and the catch-up covers the rest. */
const SCHEDULE_TICK_MS = 15_000;
/** Console lines carried in a gossiped mirror — enough to see what just happened. */
const MIRROR_TAIL_LINES = 8;

interface Entry {
  persisted: PersistedInstance;
  module: GameModule;
  supervisor: Supervisor;
  announcer: Announcer;
  probeTimer: NodeJS.Timeout | null;
  /** Cancels an install in flight. */
  installAbort: AbortController | null;
  installPct: number | undefined;
  /** Populated from the last successful probe. */
  players: { online: number; max: number; names: string[] } | undefined;
  /** Status while installing, before a Supervisor FSM is meaningful. */
  installing: boolean;
  installFailure: string | undefined;
  /** A newer build found by checkForUpdate, pinned but not yet installed. Held in
   *  memory only: an offer the user did not accept should not survive a restart
   *  and become an update applied without a fresh look at the catalog. */
  pendingUpdate: GameVersionRef | undefined;
  /** How bound room content compares to the last sync. */
  contentSync: ContentSyncState;
  contentPending: PendingContentConsent[];
  /** Previous supervisor status — drives crash/OOM alerts. */
  lastStatus?: ServerStatus;
}

export interface ServerManagerDeps {
  /** Virtual-LAN address for a room, when a session is up. */
  getRoomVip(roomId: string): string | undefined;
  /** Our own memberId, for role checks. */
  getSelfId(): string;
  /** Push updated state for a room to the renderer. */
  onRoomUpdate(roomId: string): void;
  /** Room files for content sync (best-effort local paths). */
  getRoomContentFiles(roomId: string): RoomContentFile[];
  /** Ask the elevated LAN helper to scope a firewall rule to an executable. */
  allowFirewallApp?(roomId: string, exePath: string): Promise<{ ok: boolean; message?: string }>;
  /** Gossiped mirrors from OTHER members hosting in this room — several members
   *  may host at once, so this is a list, never a single slot. */
  getServerMirrors?(roomId: string): ServerMirrorState[];
  /** Host publishes instance state to peers. */
  publishServerMirror?(roomId: string, payload: ServerMirrorState): void;
  /** Operator sends a console command to the host. */
  publishRemoteCommand?(roomId: string, instanceId: string, command: string): void;
  /** Surface crash/OOM/disk alerts in the renderer. */
  onServerAlert?(roomId: string, alert: ServerAlert): void;
}

export class ServerManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private deps: ServerManagerDeps | null = null;
  private disposed = false;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private readonly lastScheduleFire = new Map<string, string>();
  /** When the schedule was last evaluated, so a tick can catch up the minutes a
   *  drifting timer or a blocked event loop skipped over. */
  private lastScheduleCheck: Date | null = null;
  private readonly alertThrottle = new AlertThrottle();
  /** roomId → fingerprint of the mirror we last gossiped, so an unchanged
   *  payload is not re-flooded on every probe tick. */
  private readonly lastMirrorSent = new Map<string, string>();

  init(deps: ServerManagerDeps): void {
    this.deps = deps;
    // Anything left in staging is debris from a crash mid-import: it belongs to a
    // dialog that no longer exists, and it can be gigabytes.
    purgeStaging();
    this.restoreAll();
    this.startScheduleTicker();
  }

  private get selfId(): string {
    return this.deps?.getSelfId() ?? '';
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Rebuild supervisors for persisted instances. Nothing is auto-started: a
   *  server that starts itself on app launch would be a surprise, and a crashed
   *  one would loop unattended. */
  private restoreAll(): void {
    for (const persisted of Object.values(getInstances())) {
      try {
        this.attach(persisted);
      } catch (err) {
        log.warn('could not restore instance', { instanceId: persisted.instanceId, err: String(err) });
      }
    }
    log.info('restored instances', { count: this.entries.size });
  }

  private attach(persisted: PersistedInstance): Entry {
    const module = getModule(persisted.moduleId);
    if (!module) throw new ServerActionError('unknown-module', persisted.moduleId);
    const paths = instancePaths(persisted.instanceId);

    const supervisor = new Supervisor(module, this.viewOf(persisted, module), {
      resolveRuntime: (ref) => this.resolveRuntimeFor(persisted, ref),
      instanceRoot: paths.root,
      logsDir: paths.logs,
      onChange: () => {
        const live = this.entries.get(persisted.instanceId);
        if (live) this.onEntryStatusChange(live);
        this.pushUpdate(persisted.roomId);
      },
      onEvent: (e) => this.onGameEvent(persisted.instanceId, e),
    });
    supervisor.autoRestart = persisted.autoRestart;

    const entry: Entry = {
      persisted,
      module,
      supervisor,
      announcer: new Announcer(),
      probeTimer: null,
      installAbort: null,
      installPct: undefined,
      players: undefined,
      installing: false,
      installFailure: undefined,
      pendingUpdate: undefined,
      contentSync: 'ok',
      contentPending: [],
    };
    this.entries.set(persisted.instanceId, entry);
    this.refreshContentStatus(entry);
    return entry;
  }

  private entry(instanceId: string): Entry {
    const e = this.entries.get(instanceId);
    if (!e) throw new ServerActionError('unknown-instance', instanceId);
    return e;
  }

  /**
   * The executable to launch: a managed runtime, or the system Java the user
   * explicitly opted into.
   *
   * The system path is gated on the MAJOR. `resolveRuntime` installs exactly the
   * version a module asked for; PATH offers whatever happens to be there, and a
   * Java 8 running a server that needs 21 dies with an UnsupportedClassVersion
   * stack the user cannot act on. Refusing here, with the reason on their own
   * console, is the difference between a fixable message and a mystery.
   */
  private resolveRuntimeFor(persisted: PersistedInstance, ref: { id: string; major: number }): string | null {
    if (!persisted.useSystemJava) return resolveRuntime(ref);

    const say = (msg: string): void => {
      this.entries.get(persisted.instanceId)?.supervisor.console.system(msg);
      log.warn('system java refused', { instanceId: persisted.instanceId, msg });
    };
    const sys = detectSystemJava();
    if (!sys) {
      say('system Java is selected but none was found on PATH — turn it off to use the managed runtime');
      return null;
    }
    if (sys.major < ref.major) {
      say(`system Java is ${sys.major}, this server needs ${ref.major} — turn it off to use the managed runtime`);
      return null;
    }
    return sys.exe;
  }

  private onEntryStatusChange(entry: Entry): void {
    const snap = entry.supervisor.snapshot();
    const status: ServerStatus = entry.installing ? 'installing' : snap.status;
    const alert = alertOnStatusChange(
      entry.persisted.instanceId,
      entry.persisted.name,
      entry.lastStatus,
      status,
      snap.failDetail,
    );
    entry.lastStatus = status;
    if (alert) this.raiseAlert(entry.persisted.roomId, alert);
  }

  /** Surface an alert unless an identical one was just shown (crash loops). */
  private raiseAlert(roomId: string, alert: ServerAlert): void {
    if (!this.alertThrottle.allow(alert)) return;
    this.deps?.onServerAlert?.(roomId, alert);
  }

  /** Our role for a REMOTE instance — from the host's gossiped operator list,
   *  never from our own store (see `mirroredRole`). */
  private remoteRole(hostId: string, m: MirroredServerInstance): ServerRole {
    return mirroredRole(hostId, m, this.selfId);
  }

  private findRemoteInRoom(roomId: string, instanceId: string): { hostId: string; row: MirroredServerInstance } | null {
    for (const mirror of this.deps?.getServerMirrors?.(roomId) ?? []) {
      if (mirror.hostId === this.selfId) continue;
      const row = mirror.instances.find((i) => i.instanceId === instanceId);
      if (row) return { hostId: mirror.hostId, row };
    }
    return null;
  }

  private describeMirrored(hostId: string, m: MirroredServerInstance): RoomServerInstance {
    return {
      instanceId: m.instanceId,
      moduleId: m.moduleId,
      name: m.name,
      version: m.version,
      hostId,
      isHost: false,
      role: this.remoteRole(hostId, m),
      status: m.status,
      since: m.since,
      ...(m.address ? { address: m.address } : {}),
      ...(m.port !== undefined ? { port: m.port } : {}),
      ...(m.players ? { players: m.players } : {}),
      autoRestart: m.autoRestart,
      updatable: false,
      remote: true,
      ...(m.scheduleEnabled ? { scheduleEnabled: true } : {}),
      operators: m.operators,
      ...(m.consoleTail?.length && m.consoleTailSeq
        ? { consoleTail: m.consoleTail, consoleTailSeq: m.consoleTailSeq }
        : {}),
      ...(m.failReason ? { failReason: m.failReason, ...(m.failDetail ? { failDetail: m.failDetail } : {}) } : {}),
    };
  }

  /**
   * Gossip our instances in this room to the other members.
   *
   * Published on CHANGE, not on tick. This runs from every `pushUpdate`, which
   * a running instance triggers on each 15s probe — an unconditional broadcast
   * there re-flooded a signed payload across the mesh every fifteen seconds
   * whether or not anything about it had moved.
   *
   * An empty list is still published, once, if we had instances here before:
   * that is how "I deleted my last server" reaches peers. A room where we never
   * hosted anything publishes nothing at all.
   */
  private publishMirror(roomId: string): void {
    const publish = this.deps?.publishServerMirror;
    if (!publish) return;
    const local: RoomServerInstance[] = [];
    const tails: Record<string, ConsoleTailSample> = {};
    for (const entry of this.entries.values()) {
      if (entry.persisted.roomId !== roomId) continue;
      local.push(this.describe(entry));
      const lines = entry.supervisor.console.snapshot(0).slice(-MIRROR_TAIL_LINES);
      if (lines.length) {
        tails[entry.persisted.instanceId] = {
          lines: lines.map((l) => l.text),
          lastSeq: lines[lines.length - 1].seq,
        };
      }
    }
    const previous = this.lastMirrorSent.get(roomId);
    if (previous === undefined && !local.length) return;

    const payload = buildMirrorPayload(this.selfId, local, tails);
    const fingerprint = mirrorFingerprint(payload);
    if (previous === fingerprint) return;
    this.lastMirrorSent.set(roomId, fingerprint);
    publish(roomId, payload);
  }

  /**
   * Host-side handler for operator console commands received over gossip.
   *
   * `roomId` is the room the signature was verified against, and it is checked —
   * not decoration. An operator grant is per-instance, but a command is only
   * authenticated inside ONE room's topic; without this an operator of an
   * instance in room A could drive it from room B, where the host never offered
   * them anything. Refusing is free and keeps the grant where it was made.
   */
  handleRemoteCommand(by: string, roomId: string, instanceId: string, command: string): { ok: true; command: string } | { ok: false; reason: string } {
    const entry = this.entries.get(instanceId);
    if (!entry) return { ok: false, reason: 'unknown-instance' };
    if (entry.persisted.roomId !== roomId) return { ok: false, reason: 'unknown-instance' };
    if (!listOperators(instanceId).includes(by)) return { ok: false, reason: 'viewer-only' };
    // The audit trail operator write access was always meant to ship with: the
    // host's own console records WHO typed it, before the server sees it, so a
    // grant that turns out to be a mistake is legible after the fact.
    entry.supervisor.console.system(`remote command from ${by}: ${command}`);
    return entry.supervisor.sendCommand(command);
  }

  /** Build the read-only facts a module plans against. */
  private viewOf(persisted: PersistedInstance, module: GameModule): InstanceView {
    const paths = instancePaths(persisted.instanceId);
    let gameConfig: Record<string, string> = {};
    const rel = module.configPath({
      instanceId: persisted.instanceId,
      moduleId: persisted.moduleId,
      ref: persisted.ref as GameVersionRef,
      config: persisted.config,
    });
    if (rel) {
      try {
        gameConfig = module.parseConfig(fs.readFileSync(resolveUnder(paths.root, rel), 'utf8'));
      } catch {
        // Not installed yet, or the file was removed — the persisted Havvn-side
        // values still form a usable view.
      }
    }
    const vip = this.deps?.getRoomVip(persisted.roomId);
    return {
      instanceId: persisted.instanceId,
      moduleId: persisted.moduleId,
      ref: persisted.ref as GameVersionRef,
      // The game's own file wins for keys it owns (Minecraft rewrites
      // server.properties on shutdown), our store supplies the havvn-* keys.
      config: { ...persisted.config, ...gameConfig },
      ...(vip ? { vip } : {}),
    };
  }

  private refreshView(entry: Entry): void {
    entry.supervisor.updateView(this.viewOf(entry.persisted, entry.module));
  }

  // ── catalog ────────────────────────────────────────────────────────────────

  private catalogCtx(): CatalogCtx {
    return {
      fetchJson: (url, opts) => fetchJsonCached(url, opts?.ttlMs),
      // Forge / NeoForge / Fabric resolve() reads Maven `.sha256` / `.sha512`
      // sidecars through this. Without it the catalog lists those loaders but
      // every install fails the moment the digest is fetched.
      fetchText: (url, opts) => fetchTextCached(url, opts?.ttlMs),
      log: (msg) => log.info('catalog', { msg }),
    };
  }

  async listVersions(moduleId: string): Promise<GameVersionRef[]> {
    const module = getModule(moduleId);
    if (!module) throw new ServerActionError('unknown-module', moduleId);
    return module.catalog(this.catalogCtx());
  }

  /**
   * The settings the create form should ask for, pre-filled with what the core
   * already knows — most importantly a port nothing else on this machine holds.
   *
   * Asking here rather than letting the renderer guess is what keeps "which port
   * is free" a main-process question. A renderer cannot bind a socket, and a
   * hard-coded 25565 in the form would put the collision back.
   */
  async createForm(roomId: string, moduleId: string): Promise<{ schema: ConfigField[]; values: Record<string, string> }> {
    const module = getModule(moduleId);
    if (!module) throw new ServerActionError('unknown-module', moduleId);

    const schema = module.createSchema?.() ?? [];
    const values: Record<string, string> = {};
    if (module.portPlan) {
      const port = await this.allocatePort(module, roomId);
      if (port !== null) values[module.portPlan.configKey] = String(port);
    }
    return { schema, values };
  }

  /**
   * A port no sibling instance claims and the OS agrees is bindable.
   *
   * Siblings across EVERY room are considered, not just this one: they all run on
   * the same machine and a port is a machine-wide resource. Rooms are an access
   * boundary, not a network namespace.
   */
  private async allocatePort(module: GameModule, _roomId: string): Promise<number | null> {
    const plan = module.portPlan;
    if (!plan) return null;

    const taken = new Set<number>();
    for (const entry of this.entries.values()) {
      if (entry.module.id !== module.id) continue;
      const port = entry.module.probePlan?.(this.viewOf(entry.persisted, entry.module))?.port;
      if (Number.isInteger(port)) taken.add(port as number);
    }
    return findFreePort(plan.base, plan.span, taken);
  }

  // ── create / install ───────────────────────────────────────────────────────

  /** Legal gates must be cleared by the user, never inferred from a click on
   *  Install. Exposed so the UI can show the gate before anything downloads.
   *  `labelKey` is a translation key — the renderer localises it; returning
   *  English prose here would make the Russian UI the one place that stayed EN. */
  legalGateFor(moduleId: string): { id: string; labelKey: string; url: string; accepted: boolean } | null {
    const module = getModule(moduleId);
    if (!module?.legalGate) return null;
    return {
      id: module.legalGate.id,
      labelKey: module.legalGate.labelKey,
      url: module.legalGate.url,
      accepted: isLegalAccepted(moduleId),
    };
  }

  acceptLegalGate(moduleId: string): void {
    const module = getModule(moduleId);
    if (!module?.legalGate) throw new ServerActionError('unknown-module', moduleId);
    acceptLegal(moduleId);
    log.info('legal gate accepted', { moduleId, gate: module.legalGate.id });
  }

  /**
   * The initial config for a new instance: whatever the create form collected,
   * checked against the module's own schema, plus a free port when the form did
   * not name one.
   *
   * Validated HERE and not merely in the form, because the renderer is not a trust
   * boundary — and because the form is not the only caller: a future preset would
   * arrive through the same door.
   */
  private async seedConfig(
    module: GameModule,
    roomId: string,
    requested: Readonly<Record<string, unknown>> | undefined,
  ): Promise<Record<string, string>> {
    const schema = module.createSchema?.() ?? [];
    const { values, rejected } = validateConfigValues(schema, requested ?? {});
    for (const r of rejected) {
      // Dropped rather than fatal: a rejected field falls back to the module's own
      // default, which is a working server. Refusing to create one because the
      // MOTD was 300 characters would be the worse trade.
      log.warn('create setting rejected', { module: module.id, key: r.key, reason: r.reason });
    }

    const plan = module.portPlan;
    if (plan && !values[plan.configKey]) {
      const port = await this.allocatePort(module, roomId);
      if (port === null) throw new ServerActionError('port-exhausted', `${plan.base}-${plan.base + plan.span - 1}`);
      values[plan.configKey] = String(port);
    }
    return values;
  }

  async createInstance(opts: {
    roomId: string;
    moduleId: string;
    refId: string;
    name?: string;
    config?: Readonly<Record<string, unknown>>;
  }): Promise<{ instanceId: string }> {
    const module = getModule(opts.moduleId);
    if (!module) throw new ServerActionError('unknown-module', opts.moduleId);
    if (module.legalGate && !isLegalAccepted(module.id)) {
      throw new ServerActionError('legal-pending');
    }

    const catalog = await module.catalog(this.catalogCtx());
    const chosen = catalog.find((r) => r.id === opts.refId);
    // A preset may only name an entry the module itself published: this lookup
    // is what stops shared data from ever introducing a download url.
    if (!chosen) throw new ServerActionError('unknown-version', opts.refId);

    const resolved = module.resolve ? await module.resolve(chosen, this.catalogCtx()) : chosen;
    const config = await this.seedConfig(module, opts.roomId, opts.config);

    const instanceId = uuidv4().replace(/-/g, '').slice(0, 32);
    const persisted: PersistedInstance = {
      instanceId,
      moduleId: module.id,
      roomId: opts.roomId,
      name: opts.name?.trim().slice(0, 60) || `${module.displayName} ${resolved.version}`,
      ref: resolved,
      // Holds the game's own keys too, until the install writes them into the
      // game's config file — viewOf lets that file win from then on.
      config,
      createdAt: Date.now(),
      installed: false,
      autoRestart: true,
      contentRev: 0,
    };

    ensureInstanceDirs(instanceId);
    upsertInstance(persisted);
    this.attach(persisted);
    this.pushUpdate(opts.roomId);
    log.info('instance created', { instanceId, module: module.id, ref: resolved.id });

    // Install immediately; the UI follows progress through the pushed state.
    void this.install(instanceId).catch((err) => log.warn('install failed', { instanceId, err: String(err) }));
    return { instanceId };
  }

  /**
   * Stage a user-supplied jar/zip and ask the module what it can launch.
   * Nothing is committed: the caller either creates an instance from the result
   * or discards the staging directory.
   */
  async stageUserImport(moduleId: string, sourcePath: string): Promise<ImportScanResult> {
    const module = getModule(moduleId);
    if (!module) throw new ServerActionError('unknown-module', moduleId);
    if (!module.caps.import || !module.scanImport) {
      throw new ServerActionError('no-import-support', moduleId);
    }
    if (module.legalGate && !isLegalAccepted(module.id)) {
      throw new ServerActionError('legal-pending');
    }
    return stageImport(sourcePath, (files) => module.scanImport!(files));
  }

  discardUserImport(stagingId: string): void {
    discardImport(String(stagingId || ''));
  }

  /**
   * Turn a staged import into a real instance. The tree moves into place first,
   * then the module's light install plan (EULA + properties seed) runs so an
   * imported world keeps the port and whitelist it came with.
   */
  async createFromImport(opts: {
    roomId: string;
    moduleId: string;
    stagingId: string;
    candidateId: string;
    name?: string;
    javaMajor?: number;
  }): Promise<{ instanceId: string }> {
    const module = getModule(opts.moduleId);
    if (!module) throw new ServerActionError('unknown-module', opts.moduleId);
    if (!module.caps.import || !module.scanImport) {
      throw new ServerActionError('no-import-support', opts.moduleId);
    }
    if (module.legalGate && !isLegalAccepted(module.id)) {
      throw new ServerActionError('legal-pending');
    }
    if (!stagingExists(opts.stagingId)) {
      throw new ServerActionError('import-expired');
    }

    // Re-scan the staged tree rather than trusting a candidate id the renderer
    // remembered: the listing is what the module decided was launchable, and a
    // stale id from a previous dialog must not invent a launch plan.
    const { files } = listTree(importStagingDir(opts.stagingId));
    const candidates = module.scanImport(files);
    const chosen = candidates.find((c) => c.id === opts.candidateId) ?? candidates[0];
    if (!chosen) throw new ServerActionError('nothing-recognised');

    const javaMajor = resolveImportJavaMajor(chosen.javaMajor, opts.javaMajor);
    const version = chosen.version || 'imported';
    const resolved: GameVersionRef = {
      id: `imported:${opts.stagingId.slice(0, 8)}:${chosen.id}`,
      label: chosen.label,
      flavour: 'imported',
      version,
      runtime: { id: 'java', major: javaMajor },
      stable: true,
      meta: { ...chosen.meta, sourceFlavour: chosen.flavour },
    };

    const instanceId = uuidv4().replace(/-/g, '').slice(0, 32);
    const persisted: PersistedInstance = {
      instanceId,
      moduleId: module.id,
      roomId: opts.roomId,
      name: opts.name?.trim().slice(0, 60) || chosen.label.slice(0, 60),
      ref: resolved,
      config: {},
      createdAt: Date.now(),
      installed: false,
      autoRestart: true,
      contentRev: 0,
    };

    // Create logs/content beside the root, then move the staged tree into place.
    // Commit BEFORE attach: the instance root must hold the user's tree when
    // planInstall runs (imported plan only seeds eula/properties ifAbsent).
    const paths = ensureInstanceDirs(instanceId);
    commitImport(opts.stagingId, paths.root);
    upsertInstance(persisted);
    const entry = this.attach(persisted);
    await this.resolvePortConflict(entry);
    this.pushUpdate(opts.roomId);
    log.info('instance imported', { instanceId, module: module.id, candidate: chosen.id, java: javaMajor });

    void this.install(instanceId).catch((err) => log.warn('import install failed', { instanceId, err: String(err) }));
    return { instanceId };
  }

  /**
   * Move an imported server off a port something else already holds.
   *
   * An imported tree arrives with its OWN config, and the install plan seeds
   * properties `ifAbsent` precisely so a world the user has run for a year keeps
   * its port, MOTD and whitelist. That is right until two imports both say 25565,
   * at which point the second one cannot bind and the reason is invisible.
   *
   * So: only touch it when it actually collides, and then write the new port into
   * the file the user brought rather than into our store — that file is what the
   * server reads, and `viewOf` lets it win anyway.
   */
  private async resolvePortConflict(entry: Entry): Promise<void> {
    const plan = entry.module.portPlan;
    if (!plan) return;

    const view = this.viewOf(entry.persisted, entry.module);
    const current = entry.module.probePlan?.(view)?.port;
    if (!Number.isInteger(current)) return;

    const siblings = new Set<number>();
    for (const other of this.entries.values()) {
      if (other === entry || other.module.id !== entry.module.id) continue;
      const port = other.module.probePlan?.(this.viewOf(other.persisted, other.module))?.port;
      if (Number.isInteger(port)) siblings.add(port as number);
    }
    if (!siblings.has(current as number)) return;

    const free = await findFreePort(plan.base, plan.span, siblings);
    if (free === null) {
      entry.supervisor.console.system(`port ${current} is taken and no free port was found`);
      return;
    }

    const rel = entry.module.configPath(view);
    if (rel) {
      const abs = resolveUnder(instancePaths(entry.persisted.instanceId).root, rel);
      let previous: string | undefined;
      try { previous = fs.readFileSync(abs, 'utf8'); } catch { previous = undefined; }
      const merged = { ...view.config, [plan.configKey]: String(free) };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.module.serializeConfig(merged, previous), 'utf8');
    }
    entry.persisted.config = { ...entry.persisted.config, [plan.configKey]: String(free) };
    upsertInstance(entry.persisted);
    this.refreshView(entry);
    entry.supervisor.console.system(`moved to port ${free}: ${current} is already in use`);
    log.info('imported instance moved off a taken port', {
      instanceId: entry.persisted.instanceId, from: current, to: free,
    });
  }

  async install(instanceId: string): Promise<void> {
    const entry = this.entry(instanceId);
    if (entry.installing) throw new ServerActionError('install-running');
    if (entry.supervisor.status !== 'idle' && entry.supervisor.status !== 'stopped' && entry.supervisor.status !== 'crashed') {
      throw new ServerActionError('stop-first');
    }

    const abort = new AbortController();
    entry.installAbort = abort;
    entry.installing = true;
    entry.installPct = 0;
    entry.installFailure = undefined;
    this.pushUpdate(entry.persisted.roomId);

    const paths = instancePaths(instanceId);
    const ref = entry.persisted.ref as GameVersionRef;

    try {
      entry.supervisor.console.openLog();
      entry.supervisor.console.system(`installing ${ref.label}`);

      const needsRuntime = !resolveRuntime(ref.runtime);
      this.assertDiskSpace(entry, paths.root, needsRuntime);

      /**
       * Where the runtime phase ends and the plan's begins.
       *
       * Fixed at 40% only when the runtime actually has to be downloaded. It used
       * to be unconditional, so the common case — Java already installed from an
       * earlier server — showed a bar that began at 40% and every user's first
       * impression of the feature was a progress indicator that was visibly lying.
       */
      const runtimeShare = needsRuntime ? 40 : 0;

      if (needsRuntime) {
        entry.supervisor.console.system(`installing Java ${ref.runtime.major}`);
        await ensureRuntime(ref.runtime, (p) => {
          entry.installPct = Math.round((p.pct / 100) * runtimeShare);
          this.pushUpdate(entry.persisted.roomId);
        }, abort.signal);
      }

      const steps = entry.module.planInstall(ref, this.viewOf(entry.persisted, entry.module));
      await runInstallPlan(steps, {
        instanceRoot: paths.root,
        signal: abort.signal,
        onProgress: (p) => {
          entry.installPct = runtimeShare + Math.round((p.pct / 100) * (100 - runtimeShare));
          this.pushUpdate(entry.persisted.roomId);
        },
        onLine: (text) => entry.supervisor.console.system(text),
      });

      entry.persisted.installed = true;
      upsertInstance(entry.persisted);
      entry.supervisor.console.system('install complete');
      await this.requestFirewallRule(entry);
      log.info('instance installed', { instanceId, ref: ref.id });
    } catch (err) {
      const message = err instanceof InstallCancelled ? 'installation cancelled' : String(err);
      entry.installFailure = message;
      entry.supervisor.console.system(`install failed: ${message}`);
      throw err;
    } finally {
      entry.installing = false;
      entry.installPct = undefined;
      entry.installAbort = null;
      this.refreshView(entry);
      this.pushUpdate(entry.persisted.roomId);
    }
  }

  cancelInstall(instanceId: string): void {
    this.entry(instanceId).installAbort?.abort();
  }

  /**
   * Refuse an install that plainly will not fit, BEFORE anything downloads.
   *
   * Without this, running out of space surfaces halfway through as a failed
   * Expand-Archive or a rename error — a message about a temp path, from which
   * "your disk is full" is not a reasonable thing to expect anyone to deduce.
   *
   * An unmeasurable volume is allowed through deliberately: statfs is not
   * available everywhere, and blocking installs because we could not read the disk
   * would break the feature on the platforms it works fine on.
   */
  private assertDiskSpace(entry: Entry, root: string, needsRuntime: boolean): void {
    const ref = entry.persisted.ref as GameVersionRef;
    const runsInstaller = entry.module
      .planInstall(ref, this.viewOf(entry.persisted, entry.module))
      .some((s) => s.t === 'runtime-exec');

    const need = estimateInstallBytes({ needsRuntime, runsInstaller });
    const free = freeBytes(root);
    if (free === null || free >= need) return;

    const gb = (n: number): string => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    entry.supervisor.console.system(`not enough disk space: ${gb(free)} free, about ${gb(need)} needed`);
    throw new ServerActionError('disk-space', `${gb(free)} free, ~${gb(need)} needed`);
  }

  /**
   * Re-resolve this instance's version against the live catalog and report whether
   * the publisher has since shipped something newer.
   *
   * The type doc on GameVersionRef.meta always said a re-resolved catalog should
   * win on reinstall, but nothing ever re-resolved: `resolve()` ran once at
   * creation and its url and digest were persisted forever. So a Paper server
   * created in August stayed on that day's build for the rest of its life,
   * including the reinstall button, which faithfully re-downloaded the old one.
   *
   * Matched on flavour+version rather than on the catalog id, because the id
   * encodes the loader build for Forge and NeoForge — the very thing that changes
   * when an update exists.
   */
  async checkForUpdate(instanceId: string): Promise<{
    current: string;
    available: string | null;
  }> {
    const entry = this.entry(instanceId);
    const ref = entry.persisted.ref as GameVersionRef;

    // An imported tree came from the user's disk; there is no upstream that could
    // have a newer build of it.
    if (ref.flavour === 'imported') throw new ServerActionError('no-update-source');
    if (!entry.module.resolve) throw new ServerActionError('no-update-source');

    const catalog = await entry.module.catalog(this.catalogCtx());
    const match = catalog.find((r) => r.flavour === ref.flavour && r.version === ref.version);
    if (!match) throw new ServerActionError('unknown-version', `${ref.flavour} ${ref.version}`);

    const resolved = await entry.module.resolve(match, this.catalogCtx());
    const identity = (r: GameVersionRef): string => String(
      r.meta?.jarUrl ?? r.meta?.installerUrl ?? r.id,
    );

    if (identity(resolved) === identity(ref)) return { current: ref.label, available: null };

    // Pinned now, installed when the user says so: re-pinning without asking would
    // mean the next ordinary reinstall silently swapped the build under a world.
    entry.pendingUpdate = resolved;
    return { current: ref.label, available: resolved.label };
  }

  /**
   * Adopt the build found by checkForUpdate and reinstall onto it.
   *
   * The instance directory is NOT wiped: the world, the mods and the config all
   * belong to the user, and every install plan either overwrites only the
   * artifacts it owns or seeds config `ifAbsent`.
   */
  async applyUpdate(instanceId: string): Promise<void> {
    const entry = this.entry(instanceId);
    const pending = entry.pendingUpdate;
    if (!pending) throw new ServerActionError('no-update-source');
    if (entry.supervisor.status === 'running' || entry.supervisor.status === 'starting') {
      throw new ServerActionError('stop-first');
    }

    const backup = await backupWorldDir(instanceId, `pre-update-${backupTagNow()}`);
    if (backup) {
      log.info('world backed up before update', { instanceId, backup });
      entry.supervisor.console.system(`world backed up to ${path.basename(path.dirname(backup))}`);
    }

    entry.persisted.ref = pending;
    entry.persisted.installed = false;
    upsertInstance(entry.persisted);
    entry.pendingUpdate = undefined;
    this.refreshView(entry);
    log.info('instance updated', { instanceId, ref: pending.id });
    await this.install(instanceId);
  }

  /**
   * Scope a firewall allow-rule to the runtime that will host this server.
   *
   * Safer than the user-picked-exe path the LAN panel already offers: this
   * executable is one WE installed at a path we control, so nothing
   * renderer-supplied reaches the elevated side at all.
   */
  private async requestFirewallRule(entry: Entry): Promise<void> {
    const allow = this.deps?.allowFirewallApp;
    if (!allow) return;
    const exe = this.resolveRuntimeFor(entry.persisted, (entry.persisted.ref as GameVersionRef).runtime);
    if (!exe) return;
    try {
      const res = await allow(entry.persisted.roomId, exe);
      entry.supervisor.console.system(
        res.ok ? `firewall rule added for ${path.basename(exe)}` : `firewall rule not added: ${res.message ?? 'unknown reason'}`,
      );
    } catch (err) {
      // A missing rule degrades to "the game cannot connect", which the LAN
      // diagnostics already explain — not a reason to fail the install.
      entry.supervisor.console.system(`firewall rule not added: ${String(err)}`);
    }
  }

  // ── run ────────────────────────────────────────────────────────────────────

  start(instanceId: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(instanceId);
    if (!entry.persisted.installed) return { ok: false, reason: 'not-installed' };
    if (entry.installing) return { ok: false, reason: 'install-running' };

    const paths = instancePaths(instanceId);
    const diskAlert = alertOnLowDisk(instanceId, entry.persisted.name, freeBytes(paths.base));
    if (diskAlert) this.raiseAlert(entry.persisted.roomId, diskAlert);

    this.refreshView(entry);
    const res = entry.supervisor.start();
    if (res.ok) this.startProbing(entry);
    return res;
  }

  stop(instanceId: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(instanceId);
    this.stopProbing(entry);
    entry.announcer.stop();
    return entry.supervisor.stop();
  }

  restart(instanceId: string): { ok: true } | { ok: false; reason: string } {
    const entry = this.entry(instanceId);
    if (entry.supervisor.status === 'idle' || entry.supervisor.status === 'stopped' || entry.supervisor.status === 'crashed') {
      return this.start(instanceId);
    }
    const stopped = this.stop(instanceId);
    if (!stopped.ok) return stopped;
    // Wait for the exit rather than racing it: starting while the old process
    // still holds the port produces a confusing "address in use".
    entry.supervisor.once('exit', () => {
      const res = this.start(instanceId);
      if (!res.ok) entry.supervisor.console.system(`restart failed: ${res.reason}`);
    });
    return { ok: true };
  }

  sendCommand(instanceId: string, command: string, roomId?: string): { ok: true; command: string } | { ok: false; reason: string } {
    const local = this.entries.get(instanceId);
    if (local) {
      const role = this.roleOf(local);
      if (role === 'viewer') return { ok: false, reason: 'viewer-only' };
      return local.supervisor.sendCommand(command);
    }
    const rid = roomId || '';
    const remote = rid ? this.findRemoteInRoom(rid, instanceId) : null;
    if (!remote) return { ok: false, reason: 'unknown-instance' };
    if (this.remoteRole(remote.hostId, remote.row) === 'viewer') return { ok: false, reason: 'viewer-only' };
    this.deps?.publishRemoteCommand?.(rid, instanceId, command);
    return { ok: true, command };
  }

  clearFailure(instanceId: string): void {
    const entry = this.entry(instanceId);
    entry.installFailure = undefined;
    entry.supervisor.clearFailure();
  }

  setAutoRestart(instanceId: string, enabled: boolean): void {
    const entry = this.entry(instanceId);
    entry.persisted.autoRestart = enabled;
    entry.supervisor.autoRestart = enabled;
    upsertInstance(entry.persisted);
    this.pushUpdate(entry.persisted.roomId);
  }

  async deleteInstance(instanceId: string, opts: { deleteFiles: boolean }): Promise<void> {
    const entry = this.entry(instanceId);
    const { roomId } = entry.persisted;
    entry.installAbort?.abort();
    this.stopProbing(entry);
    entry.announcer.stop();
    // Dispose FIRST so the console log handle is gone before we touch the tree —
    // otherwise Windows reports ENOTEMPTY on a folder that looks empty.
    entry.supervisor.dispose();

    // Files BEFORE the store entry: the previous order removed the instance from
    // memory first, so a failed rm left a zombie folder and a "no such instance"
    // error on every retry. Keep the entry until the disk side succeeds.
    if (opts.deleteFiles) {
      try {
        removeInstanceDir(instanceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = /\bENOTEMPTY\b|\bEBUSY\b/i.test(msg) ? 'files-busy'
          : /\bEPERM\b|\bEACCES\b/i.test(msg) ? 'files-locked'
            : 'delete-failed';
        throw new ServerActionError(code, msg);
      }
    }

    this.entries.delete(instanceId);
    this.alertThrottle.forget(instanceId);
    removeInstance(instanceId);
    this.pushUpdate(roomId);
    log.info('instance deleted', { instanceId, deletedFiles: opts.deleteFiles });
  }

  // ── config ─────────────────────────────────────────────────────────────────

  getConfig(instanceId: string): { schema: ReturnType<GameModule['configSchema']>; values: Record<string, string> } {
    const entry = this.entry(instanceId);
    const view = this.viewOf(entry.persisted, entry.module);
    return { schema: entry.module.configSchema(view), values: { ...view.config } };
  }

  /**
   * Persist edited settings. Havvn-side keys go to our store; the game's own
   * keys are written back through the module's serializer, which preserves
   * comments and unknown keys — otherwise a hand-edited or plugin-added setting
   * would silently vanish on the first save from the form.
   */
  saveConfig(instanceId: string, values: Record<string, string>): void {
    const entry = this.entry(instanceId);
    if (entry.supervisor.status === 'running' || entry.supervisor.status === 'starting') {
      // Most servers read their config once at boot; writing under a live
      // process would show settings that are not actually in effect.
      throw new ServerActionError('stop-first');
    }

    // Checked against the module's schema, not merely for key SHAPE. The old
    // version accepted any value under a well-formed key, so `server-port=99999`
    // reached server.properties and was only clamped later at read time — the file
    // said one thing and the running server did another.
    const before = this.viewOf(entry.persisted, entry.module);
    const { values: clean, rejected } = validateConfigValues(entry.module.configSchema(before), values);
    for (const r of rejected) {
      log.warn('setting rejected', { instanceId, key: r.key, reason: r.reason });
      entry.supervisor.console.system(`ignored ${r.key}: ${r.reason}`);
    }

    entry.persisted.config = Object.fromEntries(
      Object.entries(clean).filter(([k]) => k.startsWith('havvn-')),
    );
    upsertInstance(entry.persisted);

    const view = this.viewOf(entry.persisted, entry.module);
    const rel = entry.module.configPath(view);
    if (rel) {
      const abs = resolveUnder(instancePaths(instanceId).root, rel);
      let previous: string | undefined;
      try { previous = fs.readFileSync(abs, 'utf8'); } catch { previous = undefined; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, entry.module.serializeConfig(clean, previous), 'utf8');
    }

    this.refreshView(entry);
    this.pushUpdate(entry.persisted.roomId);
  }

  // ── console ────────────────────────────────────────────────────────────────

  consoleSnapshot(instanceId: string, after = 0, roomId?: string): ConsoleLine[] {
    const local = this.entries.get(instanceId);
    if (local) return local.supervisor.console.snapshot(after);
    const remote = roomId ? this.findRemoteInRoom(roomId, instanceId) : null;
    const tail = remote?.row.consoleTail;
    const lastSeq = remote?.row.consoleTailSeq;
    if (!tail?.length || !lastSeq) return [];
    // The tail carries the HOST's sequence for its last line; the rest count
    // back from it. That is what makes `after` mean the same thing remotely as
    // it does locally — renumbering from 1 on every poll made every line look
    // new, so the viewer's console re-appended the same eight lines forever.
    const at = Date.now();
    const firstSeq = lastSeq - (tail.length - 1);
    return tail
      .map((text, i) => ({ seq: firstSeq + i, at, stream: 'out' as const, text }))
      .filter((l) => l.seq > after);
  }

  subscribeConsole(instanceId: string, fn: (line: ConsoleLine) => void): () => void {
    return this.entry(instanceId).supervisor.console.subscribe(fn);
  }

  openInstanceFolder(instanceId: string): string {
    return instancePaths(instanceId).root;
  }

  // ── probing and announcing ────────────────────────────────────────────────

  private onGameEvent(instanceId: string, e: GameEvent): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    if (e.t === 'ready') {
      this.updateAnnouncement(entry);
      void this.probe(entry);
    }
  }

  private startProbing(entry: Entry): void {
    this.stopProbing(entry);
    if (!entry.module.probePlan) return;
    entry.probeTimer = setInterval(() => void this.probe(entry), PROBE_INTERVAL_MS);
  }

  private stopProbing(entry: Entry): void {
    if (entry.probeTimer) { clearInterval(entry.probeTimer); entry.probeTimer = null; }
    entry.players = undefined;
  }

  private async probe(entry: Entry): Promise<void> {
    const plan = entry.module.probePlan?.(this.viewOf(entry.persisted, entry.module));
    if (!plan || entry.supervisor.status !== 'running') return;
    try {
      const res = await pingMinecraft(plan.host, plan.port, plan.timeoutMs);
      entry.players = { online: res.online, max: res.max, names: res.names };
      entry.supervisor.setPlayers(res.names);
    } catch {
      // A refused probe is normal while the world generates; leaving the last
      // known value alone beats flashing "0 players" at the user.
    }
  }

  /** (Re)build the local-link advertisement from current state. */
  private updateAnnouncement(entry: Entry): void {
    const view = this.viewOf(entry.persisted, entry.module);
    const plan = entry.module.announcePlan?.(view) ?? null;
    entry.announcer.set(plan, view.vip);
  }

  /** Called by main when a room's LAN session comes up or goes away. */
  onRoomVipChanged(roomId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.persisted.roomId !== roomId) continue;
      this.refreshView(entry);
      if (entry.supervisor.status === 'running') this.updateAnnouncement(entry);
      else entry.announcer.stop();
    }
    this.pushUpdate(roomId);
  }

  /** Re-evaluate content fingerprints when the room manifest changes. */
  onRoomContentChanged(roomId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.persisted.roomId !== roomId) continue;
      this.refreshContentStatus(entry);
      if (entry.persisted.contentAutoSync && entry.contentSync === 'missing') {
        const st = entry.supervisor.status;
        if (st !== 'running' && st !== 'starting' && !entry.installing) {
          void this.syncContent(entry.persisted.instanceId).catch((err) => {
            log.warn('auto content sync failed', { instanceId: entry.persisted.instanceId, err: String(err) });
          });
        }
      }
    }
    this.pushUpdate(roomId);
  }

  // ── room content sync ─────────────────────────────────────────────────────

  private roomFilesFor(entry: Entry): RoomContentFile[] {
    return this.deps?.getRoomContentFiles(entry.persisted.roomId) ?? [];
  }

  private contentSlotsOf(entry: Entry) {
    const view = this.viewOf(entry.persisted, entry.module);
    return entry.module.contentSlots?.(view) ?? [];
  }

  private bindingsOf(entry: Entry): Record<string, string> {
    return { ...(entry.persisted.contentBindings ?? {}) };
  }

  private refreshContentStatus(entry: Entry): void {
    const slots = this.contentSlotsOf(entry);
    if (!slots.length || !entry.module.caps.content) {
      entry.contentSync = 'ok';
      entry.contentPending = [];
      return;
    }
    const bindings = this.bindingsOf(entry);
    const bound = slots.some((s) => Object.prototype.hasOwnProperty.call(bindings, s.id));
    if (!bound) {
      entry.contentSync = 'ok';
      entry.contentPending = [];
      return;
    }
    const roomFiles = this.roomFilesFor(entry);
    const manifest = computeContentManifest(slots, bindings, roomFiles);
    if (entry.persisted.contentManifest && manifest !== entry.persisted.contentManifest) {
      entry.contentSync = 'missing';
      entry.contentPending = [];
      return;
    }
    entry.contentSync = entry.contentPending.length ? 'conflict' : 'ok';
  }

  contentState(instanceId: string): ServerContentState {
    const entry = this.entry(instanceId);
    const slots = this.contentSlotsOf(entry);
    const bindings = this.bindingsOf(entry);
    const roomFiles = this.roomFilesFor(entry);
    const views: ServerContentSlotView[] = slots.map((slot) => {
      const folderId = bindings[slot.id] ?? '';
      const bound = Object.prototype.hasOwnProperty.call(bindings, slot.id);
      const inFolder = bound ? filesInFolder(roomFiles, folderId) : [];
      const matched = inFolder.filter((f) => slot.extensions.some((e) => f.name.toLowerCase().endsWith(e.toLowerCase())));
      return {
        slotId: slot.id,
        labelKey: slot.labelKey,
        extensions: [...slot.extensions],
        executable: slot.executable,
        ...(slot.compat ? { compat: slot.compat } : {}),
        folderId: bound ? folderId : '',
        bound,
        fileCount: matched.length,
        readyCount: matched.filter((f) => Boolean(f.localPath)).length,
      };
    });
    return {
      slots: views,
      sync: entry.contentSync,
      pending: [...entry.contentPending],
      ...(entry.persisted.lastContentSyncAt ? { lastSyncAt: entry.persisted.lastContentSyncAt } : {}),
    };
  }

  setContentFolder(instanceId: string, slotId: string, folderId: string): void {
    const entry = this.entry(instanceId);
    const slots = this.contentSlotsOf(entry);
    if (!slots.some((s) => s.id === slotId)) throw new ServerActionError('unknown-instance', slotId);
    const bindings = this.bindingsOf(entry);
    bindings[slotId] = folderId ?? '';
    entry.persisted.contentBindings = bindings;
    upsertInstance(entry.persisted);
    this.refreshContentStatus(entry);
    this.pushUpdate(entry.persisted.roomId);
  }

  clearContentFolder(instanceId: string, slotId: string): void {
    const entry = this.entry(instanceId);
    const bindings = this.bindingsOf(entry);
    delete bindings[slotId];
    entry.persisted.contentBindings = Object.keys(bindings).length ? bindings : undefined;
    upsertInstance(entry.persisted);
    entry.contentSync = 'ok';
    entry.contentPending = [];
    this.pushUpdate(entry.persisted.roomId);
  }

  consentContent(hashes: string[]): void {
    const self = this.selfId;
    for (const sha of hashes) {
      if (/^[0-9a-f]{64}$/i.test(sha)) recordContentConsent(sha.toLowerCase(), self);
    }
  }

  async syncContent(instanceId: string): Promise<ServerContentState> {
    const entry = this.entry(instanceId);
    if (!entry.module.caps.content) throw new ServerActionError('unknown-module', entry.persisted.moduleId);
    const slots = this.contentSlotsOf(entry);
    const bindings = this.bindingsOf(entry);
    if (!slots.some((s) => Object.prototype.hasOwnProperty.call(bindings, s.id))) {
      throw new ServerActionError('no-content-bindings');
    }
    if (entry.supervisor.status === 'running' || entry.supervisor.status === 'starting') {
      throw new ServerActionError('stop-first');
    }

    entry.contentSync = 'syncing';
    this.pushUpdate(entry.persisted.roomId);

    const paths = instancePaths(instanceId);
    const roomFiles = this.roomFilesFor(entry);
    let result;
    try {
      result = await syncContentSlots({
        instanceRoot: paths.root,
        slots,
        bindings,
        roomFiles,
        hasConsent: hasContentConsent,
        isRunning: false,
      });
    } catch (err) {
      entry.contentSync = 'missing';
      if (String(err).includes('stop-first')) throw new ServerActionError('stop-first');
      throw err;
    }

    entry.contentPending = result.pending;
    entry.contentSync = result.state;
    if (result.pending.length === 0 && result.state !== 'missing') {
      const prevManifest = entry.persisted.contentManifest;
      entry.persisted.contentManifest = result.manifest;
      entry.persisted.lastContentSyncAt = Date.now();
      if (prevManifest !== result.manifest) {
        entry.persisted.contentRev = (entry.persisted.contentRev ?? 0) + 1;
      }
      upsertInstance(entry.persisted);
      entry.supervisor.console.system(
        `content synced (${result.copied} copied, ${result.removed} removed)`,
      );
    } else {
      upsertInstance(entry.persisted);
    }
    this.pushUpdate(entry.persisted.roomId);
    return this.contentState(instanceId);
  }

  // ── world backups ─────────────────────────────────────────────────────────

  backupState(instanceId: string): Promise<WorldBackupEntry[]> {
    return listWorldBackups(instanceId);
  }

  async createBackup(instanceId: string, label?: string): Promise<WorldBackupEntry> {
    const entry = this.entry(instanceId);
    const st = entry.supervisor.status;
    if (st === 'running' || st === 'starting') throw new ServerActionError('stop-first');
    return createWorldBackup(instanceId, label);
  }

  async restoreBackup(instanceId: string, backupId: string): Promise<void> {
    const entry = this.entry(instanceId);
    const st = entry.supervisor.status;
    if (st === 'running' || st === 'starting') throw new ServerActionError('stop-first');
    await restoreWorldBackup(instanceId, backupId);
    entry.supervisor.console.system(`world restored from backup ${backupId}`);
    this.pushUpdate(entry.persisted.roomId);
  }

  async removeBackup(instanceId: string, backupId: string): Promise<void> {
    // Resolved BEFORE the delete: an unknown instance must fail without having
    // already removed the directory.
    const roomId = this.entry(instanceId).persisted.roomId;
    await deleteWorldBackup(instanceId, backupId);
    this.pushUpdate(roomId);
  }

  openBackupsFolder(instanceId: string): string {
    return backupsFolder(instanceId);
  }

  // ── player lists (Minecraft) ───────────────────────────────────────────────

  playersState(instanceId: string): ServerPlayersState {
    const entry = this.entry(instanceId);
    if (entry.persisted.moduleId !== 'minecraft') {
      throw new ServerActionError('unknown-module', entry.persisted.moduleId);
    }
    const root = instancePaths(instanceId).root;
    const locked = entry.supervisor.status === 'running' || entry.supervisor.status === 'starting';
    const whitelistEnabled = entry.persisted.config['white-list'] === 'true';
    return {
      whitelistEnabled,
      whitelist: readWhitelist(root),
      banned: readBannedPlayers(root),
      locked,
    };
  }

  savePlayers(instanceId: string, patch: { whitelist?: { uuid: string; name: string }[]; banned?: { uuid: string; name: string }[]; whitelistEnabled?: boolean }): void {
    const entry = this.entry(instanceId);
    if (entry.persisted.moduleId !== 'minecraft') throw new ServerActionError('unknown-module', entry.persisted.moduleId);
    const st = entry.supervisor.status;
    if (st === 'running' || st === 'starting') throw new ServerActionError('stop-first');
    const root = instancePaths(instanceId).root;
    if (patch.whitelist) writeWhitelist(root, patch.whitelist);
    if (patch.banned) writeBannedPlayers(root, patch.banned);
    if (patch.whitelistEnabled !== undefined) {
      entry.persisted.config = { ...entry.persisted.config, 'white-list': patch.whitelistEnabled ? 'true' : 'false' };
      upsertInstance(entry.persisted);
      const rel = entry.module.configPath(this.viewOf(entry.persisted, entry.module));
      if (rel) {
        const abs = resolveUnder(root, rel);
        let previous: string | undefined;
        try { previous = fs.readFileSync(abs, 'utf8'); } catch { previous = undefined; }
        const game = entry.module.parseConfig(previous ?? '');
        game['white-list'] = patch.whitelistEnabled ? 'true' : 'false';
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, entry.module.serializeConfig(game, previous), 'utf8');
      }
    }
    this.pushUpdate(entry.persisted.roomId);
  }

  setUseSystemJava(instanceId: string, enabled: boolean): void {
    const entry = this.entry(instanceId);
    entry.persisted.useSystemJava = enabled === true;
    upsertInstance(entry.persisted);
    // Turning this on is exactly when someone has just installed Java, so drop
    // the cached probe rather than letting a five-minute-old "not found" decide.
    if (entry.persisted.useSystemJava) forgetSystemJava();
    this.pushUpdate(entry.persisted.roomId);
  }

  setContentAutoSync(instanceId: string, enabled: boolean): void {
    const entry = this.entry(instanceId);
    entry.persisted.contentAutoSync = enabled === true;
    upsertInstance(entry.persisted);
    this.pushUpdate(entry.persisted.roomId);
  }

  systemJavaInfo(): { available: boolean; version?: string; major?: number } {
    const detected = detectSystemJava();
    return detected
      ? { available: true, version: detected.version, major: detected.major }
      : { available: false };
  }

  // ── state for the renderer ────────────────────────────────────────────────

  /**
   * Our role for an instance WE supervise, which is always `host` — the process
   * is on this machine. Operator grants are the other direction entirely: they
   * are what this host hands to remote members, and a remote member reads their
   * own role off the gossiped mirror (`mirroredRole`), never from this store.
   */
  private roleOf(entry: Entry): ServerRole {
    return roleFor(entry.persisted.instanceId, this.selfId, this.selfId);
  }

  // ── schedule ───────────────────────────────────────────────────────────────

  private startScheduleTicker(): void {
    if (this.scheduleTimer) return;
    void this.scheduleTick();
    this.scheduleTimer = setInterval(() => void this.scheduleTick(), SCHEDULE_TICK_MS);
  }

  private stopScheduleTicker(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private async scheduleTick(): Promise<void> {
    if (this.disposed) return;
    const now = new Date();
    const minutes = minutesToEvaluate(now, this.lastScheduleCheck);
    this.lastScheduleCheck = now;
    if (!minutes.length) return;

    for (const entry of this.entries.values()) {
      if (!entry.persisted.scheduleEnabled) continue;
      const rules = entry.persisted.schedules ?? [];
      if (!rules.length) continue;
      // One instance's bad rule must not stop the others from being evaluated.
      try {
        for (const minute of minutes) {
          const due = findDueScheduleActions(minute, rules, this.lastScheduleFire, entry.persisted.instanceId);
          for (const { rule, fireKey, dedupKey } of due) {
            this.lastScheduleFire.set(dedupKey, fireKey);
            this.applyScheduledAction(entry, rule.action);
          }
        }
      } catch (err) {
        log.warn('schedule tick failed', { instanceId: entry.persisted.instanceId, err: String(err) });
      }
    }
  }

  private applyScheduledAction(entry: Entry, action: ServerScheduleRule['action']): void {
    const id = entry.persisted.instanceId;
    entry.supervisor.console.system(`schedule: ${action}`);
    // A schedule that silently does nothing is worse than one that fails loudly:
    // "start" on a server whose install never finished used to leave only the
    // line above, with no hint why the world never came up.
    const res = action === 'start' ? this.start(id)
      : action === 'stop' ? this.stop(id)
        : this.restart(id);
    if (!res.ok) {
      entry.supervisor.console.system(`schedule: ${action} refused — ${res.reason}`);
      log.warn('scheduled action refused', { instanceId: id, action, reason: res.reason });
    }
  }

  scheduleState(instanceId: string): ServerScheduleState {
    const entry = this.entry(instanceId);
    return {
      enabled: entry.persisted.scheduleEnabled === true,
      rules: [...(entry.persisted.schedules ?? [])],
    };
  }

  setScheduleEnabled(instanceId: string, enabled: boolean): void {
    const entry = this.entry(instanceId);
    entry.persisted.scheduleEnabled = enabled;
    upsertInstance(entry.persisted);
    this.pushUpdate(entry.persisted.roomId);
  }

  saveSchedule(instanceId: string, rules: unknown): void {
    const entry = this.entry(instanceId);
    if (!Array.isArray(rules)) throw new ServerActionError('unknown-instance', 'rules');
    const clean: ServerScheduleRule[] = [];
    for (const raw of rules.slice(0, 16)) {
      const rule = sanitizeScheduleRule(raw);
      if (rule) clean.push(rule);
    }
    entry.persisted.schedules = clean;
    upsertInstance(entry.persisted);
    this.pushUpdate(entry.persisted.roomId);
  }

  // ── operator access ────────────────────────────────────────────────────────

  accessState(instanceId: string): ServerAccessState {
    return { operators: listOperators(instanceId) };
  }

  grantOperatorAccess(instanceId: string, memberId: string): void {
    const entry = this.entry(instanceId);
    if (this.roleOf(entry) !== 'host') throw new ServerActionError('host-only');
    const id = String(memberId || '').trim();
    if (!id || id === this.selfId) return;
    grantOperator(instanceId, id);
    this.pushUpdate(entry.persisted.roomId);
  }

  revokeOperatorAccess(instanceId: string, memberId: string): void {
    const entry = this.entry(instanceId);
    if (this.roleOf(entry) !== 'host') throw new ServerActionError('host-only');
    const id = String(memberId || '').trim();
    if (!id) return;
    revokeOperator(instanceId, id);
    this.pushUpdate(entry.persisted.roomId);
  }


  private describe(entry: Entry): RoomServerInstance {
    const snap = entry.supervisor.snapshot();
    const view = this.viewOf(entry.persisted, entry.module);
    const status: ServerStatus = entry.installing ? 'installing' : snap.status;
    const plan = entry.module.probePlan?.(view);
    const port = plan?.port;

    return {
      instanceId: entry.persisted.instanceId,
      moduleId: entry.persisted.moduleId,
      name: entry.persisted.name,
      version: (entry.persisted.ref as GameVersionRef).label,
      hostId: this.selfId,
      isHost: true,
      role: this.roleOf(entry),
      status,
      since: snap.since,
      ...(entry.installPct !== undefined ? { installPct: entry.installPct } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(view.vip && port !== undefined && snap.status === 'running' ? { address: `${view.vip}:${port}` } : {}),
      ...(entry.players
        ? { players: { online: entry.players.online, max: entry.players.max, names: entry.players.names } }
        : {}),
      contentRev: entry.persisted.contentRev,
      ...(entry.module.caps.content && entry.contentSync !== 'ok' ? { contentSync: entry.contentSync } : {}),
      autoRestart: entry.persisted.autoRestart,
      updatable: (entry.persisted.ref as GameVersionRef).flavour !== 'imported' && Boolean(entry.module.resolve),
      ...(entry.persisted.scheduleEnabled ? { scheduleEnabled: true } : {}),
      ...(entry.persisted.schedules?.length
        ? { scheduleRules: entry.persisted.schedules.filter((r) => r.enabled).length }
        : {}),
      operators: listOperators(entry.persisted.instanceId),
      ...(entry.persisted.useSystemJava ? { useSystemJava: true } : {}),
      ...(entry.persisted.contentAutoSync ? { contentAutoSync: true } : {}),
      ...(entry.installFailure
        ? { failReason: 'install-failed' as const, failDetail: entry.installFailure }
        : snap.failReason
          ? { failReason: snap.failReason, ...(snap.failDetail ? { failDetail: snap.failDetail } : {}) }
          : {}),
      ...(snap.restarts ? { restarts: snap.restarts } : {}),
    };
  }

  /** The room's game-server surface, as this install sees it. */
  stateForRoom(roomId: string): RoomServerState {
    const instances: RoomServerInstance[] = [];
    for (const entry of this.entries.values()) {
      if (entry.persisted.roomId === roomId) instances.push(this.describe(entry));
    }
    // Every peer hosting here contributes, not just one: a room can have two
    // members each running a server and both must be listed.
    const seen = new Set(instances.map((i) => i.instanceId));
    for (const mirror of this.deps?.getServerMirrors?.(roomId) ?? []) {
      if (mirror.hostId === this.selfId) continue;
      for (const row of mirror.instances) {
        if (seen.has(row.instanceId)) continue;
        seen.add(row.instanceId);
        instances.push(this.describeMirrored(mirror.hostId, row));
      }
    }
    instances.sort((a, b) => a.name.localeCompare(b.name));
    return {
      // Hosting needs a runtime we can install, which today means a desktop OS
      // with a writable userData — true wherever this app runs.
      available: true,
      modules: moduleSummaries(),
      instances,
    };
  }

  /** Rebuild the persisted list for a room after an external change. */
  reloadRoom(roomId: string): void {
    for (const persisted of listInstancesForRoom(roomId)) {
      if (!this.entries.has(persisted.instanceId)) {
        try { this.attach(persisted); } catch (err) { log.warn('attach failed', { err: String(err) }); }
      }
    }
    this.pushUpdate(roomId);
  }

  private pushUpdate(roomId: string): void {
    if (this.disposed) return;
    this.publishMirror(roomId);
    this.deps?.onRoomUpdate(roomId);
    this.emit('update', roomId);
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  /** Stop everything. Called on app quit, so it must not leave a JVM behind
   *  holding the world files and the port. */
  dispose(): void {
    this.disposed = true;
    this.stopScheduleTicker();
    for (const entry of this.entries.values()) {
      entry.installAbort?.abort();
      this.stopProbing(entry);
      entry.announcer.stop();
      entry.supervisor.dispose();
    }
    this.entries.clear();
    this.removeAllListeners();
    // An unfinished "import server files" dialog must not leave gigabytes of
    // staging behind after the app exits.
    purgeStaging();
  }

  /** Instances that still have a live process, for a "servers are running"
   *  confirmation before quitting. */
  runningInstances(): { instanceId: string; name: string }[] {
    const out: { instanceId: string; name: string }[] = [];
    for (const entry of this.entries.values()) {
      const s = entry.supervisor.status;
      if (s === 'running' || s === 'starting' || s === 'stopping') {
        out.push({ instanceId: entry.persisted.instanceId, name: entry.persisted.name });
      }
    }
    return out;
  }
}

/** Pick a Java major for an import. Prefer what the files themselves said;
 *  fall back to the user's choice; then to 21 (current LTS for modern loaders). */
function resolveImportJavaMajor(fromFiles?: number, fromUser?: number): number {
  if (typeof fromFiles === 'number' && IMPORT_JAVA_MAJORS.includes(fromFiles as typeof IMPORT_JAVA_MAJORS[number])) {
    return fromFiles;
  }
  if (typeof fromUser === 'number' && IMPORT_JAVA_MAJORS.includes(fromUser as typeof IMPORT_JAVA_MAJORS[number])) {
    return fromUser;
  }
  return 21;
}

export const serverManager = new ServerManager();

export function instanceExists(instanceId: string): boolean {
  return getInstance(instanceId) !== null;
}
