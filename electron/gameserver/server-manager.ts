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
import { resolveRuntime, ensureRuntime } from './runtime-store';
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
  isLegalAccepted, acceptLegal, type PersistedInstance,
} from '../db/servers-store';
import type {
  CatalogCtx, ConfigField, ConsoleLine, GameEvent, GameModule, GameVersionRef, ImportScanResult,
  InstanceView, RoomServerInstance, RoomServerState, ServerRole, ServerStatus,
} from '../../shared/gameserver-types';
import { IMPORT_JAVA_MAJORS } from '../../shared/gameserver-types';
import { validateConfigValues } from '../../shared/gameserver-core';
import { ServerActionError } from '../../shared/gameserver-errors';

const log = logger.child('ServerManager');

/** How often a running instance is probed for its real population. */
const PROBE_INTERVAL_MS = 15_000;

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
}

export interface ServerManagerDeps {
  /** Virtual-LAN address for a room, when a session is up. */
  getRoomVip(roomId: string): string | undefined;
  /** Our own memberId, for role checks. */
  getSelfId(): string;
  /** Push updated state for a room to the renderer. */
  onRoomUpdate(roomId: string): void;
  /** Ask the elevated LAN helper to scope a firewall rule to an executable. */
  allowFirewallApp?(roomId: string, exePath: string): Promise<{ ok: boolean; message?: string }>;
}

export class ServerManager extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  private deps: ServerManagerDeps | null = null;
  private disposed = false;

  init(deps: ServerManagerDeps): void {
    this.deps = deps;
    // Anything left in staging is debris from a crash mid-import: it belongs to a
    // dialog that no longer exists, and it can be gigabytes.
    purgeStaging();
    this.restoreAll();
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
      resolveRuntime: (ref) => resolveRuntime(ref),
      instanceRoot: paths.root,
      logsDir: paths.logs,
      onChange: () => this.pushUpdate(persisted.roomId),
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
    };
    this.entries.set(persisted.instanceId, entry);
    return entry;
  }

  private entry(instanceId: string): Entry {
    const e = this.entries.get(instanceId);
    if (!e) throw new ServerActionError('unknown-instance', instanceId);
    return e;
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
    const exe = resolveRuntime((entry.persisted.ref as GameVersionRef).runtime);
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

  sendCommand(instanceId: string, command: string): { ok: true; command: string } | { ok: false; reason: string } {
    const entry = this.entry(instanceId);
    // Only the host may type into the console today. Operator write access is a
    // later slice and needs a host-signed grant plus an audit trail; until it
    // exists, refusing is the honest behaviour.
    if (entry.persisted.roomId && this.roleOf(entry) !== 'host') {
      return { ok: false, reason: 'host-only' };
    }
    return entry.supervisor.sendCommand(command);
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

  consoleSnapshot(instanceId: string, after = 0): ConsoleLine[] {
    return this.entry(instanceId).supervisor.console.snapshot(after);
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

  // ── state for the renderer ────────────────────────────────────────────────

  /**
   * Our role for an instance. Every instance this manager supervises is one WE
   * created, so it is always 'host'. Remote members' instances arrive as
   * mirrored state and are never supervised here — which is why there is no
   * operator branch yet: granting one is meaningless until the gossip that
   * carries a remote instance exists.
   */
  private roleOf(_entry: Entry): ServerRole {
    return 'host';
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
      autoRestart: entry.persisted.autoRestart,
      updatable: (entry.persisted.ref as GameVersionRef).flavour !== 'imported' && Boolean(entry.module.resolve),
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
    this.deps?.onRoomUpdate(roomId);
    this.emit('update', roomId);
  }

  // ── teardown ───────────────────────────────────────────────────────────────

  /** Stop everything. Called on app quit, so it must not leave a JVM behind
   *  holding the world files and the port. */
  dispose(): void {
    this.disposed = true;
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
