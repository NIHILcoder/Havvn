/**
 * Shared TypeScript contract for the Havvn Game Servers feature — the ONE type
 * module every process imports (the main-process manager, the supervisor, each
 * game module, and the renderer panel). Like shared/lan-types.ts it MUST stay
 * dependency-free: no electron, no node:fs, no node:crypto, no runtime side
 * effects. Only ambient `Buffer` appears, and only in type position.
 *
 * ─ THE CENTRAL INVARIANT: A MODULE RETURNS A PLAN, THE CORE EXECUTES IT ──────
 * A GameModule never downloads, never spawns, never touches the filesystem. It
 * answers questions ("what should be fetched", "how should this be launched",
 * "what does this log line mean") and the core performs the effects. That is not
 * a style preference:
 *
 *   • Hash pinning becomes unbypassable. Every byte written to disk goes through
 *     ONE fetcher that refuses a mismatched digest, so a module cannot forget.
 *   • Path containment becomes unbypassable. Every path a module names is a
 *     RelPath resolved under the instance root by the core, so no module can
 *     write outside it — even by accident.
 *   • Modules become node-testable. parseLine / parseConfig / planInstall are
 *     pure functions over data, so the whole Minecraft module is unit-tested
 *     with no Java, no network and no Electron — the discipline that makes
 *     shared/lan-router.ts and shared/lan-session-core.ts testable.
 *
 * ─ THE THREE TRUST TIERS ────────────────────────────────────────────────────
 *   A. MODULES  — first-party code, compiled into the bundle. Fully trusted.
 *   B. PRESETS  — DATA a module interprets. Shareable between room members. A
 *                 preset picks a GameVersionRef out of the module's catalog and
 *                 sets config values; it can name NO url, NO argv, NO exe path.
 *                 That is why a hostile preset has no attack surface.
 *   C. CONTENT  — mods / worlds / configs arriving over the room manifest.
 *                 Untrusted data. Lands only inside one instance's profile, and
 *                 executable content needs a one-per-hash user consent.
 *
 * Anything that would let tier B or C widen into tier A is a security bug, not a
 * feature request.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A path RELATIVE to an instance (or runtime) root, always with '/' separators.
 * Never absolute, never containing '..'. Validated by isSafeRelPath() in
 * shared/gameserver-core.ts before the core resolves it — a module cannot escape
 * its instance directory because it never gets to name an absolute path at all.
 */
export type RelPath = string;

/**
 * How the integrity of a downloaded artifact is established.
 *
 * 'sha256' / 'sha1' — the digest is pinned in OUR source (the scripts/fetch-*.mjs
 * discipline, moved to runtime). This is the strong form and is used for
 * everything we can pin: JVM runtimes, loader installers of a fixed version.
 *
 * 'vendor' — the digest comes from the upstream vendor's own manifest, fetched
 * over TLS moments earlier (Mojang's version_manifest_v2 publishes a sha1 per
 * artifact; the Paper API publishes a sha256). Pinning every Minecraft version
 * that will ever exist into this repository is impossible, so for those the root
 * of trust is HTTPS to the vendor plus the digest THEY declare. That is a real,
 * weaker trust assumption and it MUST be stated in the UI — not buried here.
 */
export type HashRef =
  | { algo: 'sha256'; hex: string }
  | { algo: 'sha1'; hex: string }
  | { algo: 'vendor'; from: VendorTrust; digest: 'sha1' | 'sha256' | 'sha512'; hex: string };

/** Which upstream vouched for a 'vendor' digest (shown to the user verbatim). */
export type VendorTrust = 'mojang' | 'paper' | 'fabric' | 'forge' | 'neoforge' | 'adoptium';

/** Reference to a managed runtime the core has installed (e.g. a JRE). */
export interface RuntimeRef {
  /** Runtime family, e.g. 'java'. */
  id: string;
  /** Major version the module requires, e.g. 21. */
  major: number;
}

/** One selectable entry in a module's version catalog (tier-B presets may only
 *  reference these, never fabricate one). */
export interface GameVersionRef {
  /** Stable id, unique within the module, e.g. 'paper:1.21.4:118'. */
  id: string;
  /** Human label, e.g. 'Paper 1.21.4 (build 118)'. */
  label: string;
  /** Flavour/edition within the game, e.g. 'vanilla' | 'paper' | 'fabric'. */
  flavour: string;
  /** Upstream game version, e.g. '1.21.4'. */
  version: string;
  /**
   * Version FAMILY this belongs to, e.g. '1.21' for 1.21.4 or '26.1' for 26.1.2.
   *
   * Exists so the UI can offer a two-step choice — family, then version — instead
   * of one flat list. That is not cosmetic: the flat list was capped at 25 entries
   * per flavour, which today stops at Minecraft 1.19.3, and 1.16.5 and 1.12.2 are
   * exactly the versions old Forge modpacks target. Grouping is what makes a
   * complete catalog navigable rather than a 700-row dropdown.
   */
  family?: string;
  /** Which managed runtime this entry needs. */
  runtime: RuntimeRef;
  /** Marks a stable/recommended entry — the UI defaults to the newest one. */
  stable: boolean;
  /** Module-private payload (download urls + digests resolved from the catalog).
   *  Opaque to the core; passed straight back into planInstall. NEVER persisted
   *  as authority — a re-resolved catalog wins on reinstall. */
  meta?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Plans — the only way a module causes an effect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step of an installation, executed in order by electron/gameserver/installer.ts.
 * A CLOSED union on purpose: there is deliberately no 'run arbitrary command'
 * arm, because that is precisely the capability the trust model must withhold.
 */
export type InstallStep =
  /** Download `url` and store it at `into`, ABORTING unless the digest matches. */
  | { t: 'fetch'; url: string; hash: HashRef; into: RelPath; label?: string }
  /** Expand a previously fetched archive. `strip` drops N leading components. */
  | { t: 'unzip'; from: RelPath; into: RelPath; strip?: number }
  /**
   * Write a small text file (config, EULA, launch marker). Text only — a module
   * never emits binary, so this can never smuggle an executable.
   *
   * `ifAbsent` seeds a default without clobbering: an imported server arrives
   * with its own server.properties, and an install that overwrote it would reset
   * the port, the MOTD and the whitelist of a world the user has been running
   * for a year.
   */
  | { t: 'write'; path: RelPath; text: string; ifAbsent?: boolean }
  /** Delete a file or directory inside the instance (installer leftovers). */
  | { t: 'remove'; path: RelPath }
  /**
   * Run a MANAGED runtime — the single privileged step, needed because Fabric and
   * Forge ship installers rather than plain jars. It is bounded on every side:
   * the executable is the core's own hash-verified runtime (never a module- or
   * preset-supplied path), argv comes from first-party module code, cwd is inside
   * the instance, and a timeout applies. `produces` is checked afterwards, so a
   * silently-failed installer surfaces as an error instead of a broken instance.
   */
  | { t: 'runtime-exec'; runtime: RuntimeRef; args: string[]; cwd: RelPath;
      timeoutMs: number; produces: RelPath[]; label?: string };

/** How to start the server process. `exe` is resolved by the core from `runtime`
 *  — a module never names an executable path. */
export interface LaunchPlan {
  runtime: RuntimeRef;
  args: string[];
  /** Working directory, relative to the instance root ('' = the root itself). */
  cwd: RelPath;
  /** Extra environment entries merged over a MINIMAL base env (never process.env
   *  wholesale — a game server has no business inheriting our secrets). */
  env?: Readonly<Record<string, string>>;
}

/** How to stop the server gracefully before the core resorts to killing it. */
export interface StopPlan {
  /** Line written to stdin, e.g. 'stop'. Absent ⇒ go straight to signalling. */
  command?: string;
  /** How long the process may take to exit on its own. Minecraft saves the world
   *  during shutdown and legitimately needs tens of seconds on a big map. */
  graceMs: number;
}

/** A periodic UDP broadcast/multicast advertising the server on the local link —
 *  what lets a dedicated server appear in a game's LAN list. */
export interface AnnouncePlan {
  host: string;
  port: number;
  /** Payload rebuilt each tick from live state (motd/port can change). */
  payload: Buffer;
  intervalMs: number;
  /** Send with multicast TTL 1 and loopback on, so it stays on the link. */
  multicast: boolean;
}

/** An out-of-band liveness/population probe (e.g. Minecraft's Server List Ping).
 *  More robust than log scraping, which misses lines across a restart. */
export interface ProbePlan {
  kind: 'minecraft-slp';
  host: string;
  port: number;
  timeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Config descriptors — modules describe fields, the core renders them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single editable setting. Modules ship DESCRIPTORS rather than React, so a new
 * module never drags UI code — and never has to re-learn this app's portal /
 * realm / container-type rules, which is where room UI bugs come from.
 *
 * EVERY HUMAN-READABLE STRING HERE IS A TRANSLATION KEY, never prose. A module
 * runs in the main process and has no dictionary; if it returned English text the
 * settings form would be the one part of a Russian UI that is not in Russian.
 * Keys live in renderer/i18n/*.json under `rooms.server.cfg.*` and are resolved
 * by ServerConfigForm — the same `labelKey` discipline the dock registry uses.
 */
export interface ConfigFieldBase {
  key: string;
  labelKey: string;
  helpKey?: string;
  /** Hidden behind "advanced" — most servers never need it. */
  advanced?: boolean;
  /** Renders with a visible warning banner. For settings with a security
   *  consequence, e.g. Minecraft's `online-mode`, which turns off account
   *  verification: the user must see WHY before flipping it, not afterwards. */
  warnKey?: string;
}

export type ConfigField =
  | (ConfigFieldBase & { t: 'text'; placeholderKey?: string; maxLength?: number })
  | (ConfigFieldBase & { t: 'int'; min?: number; max?: number })
  | (ConfigFieldBase & { t: 'bool' })
  | (ConfigFieldBase & { t: 'select'; options: { value: string; labelKey: string }[] });

// ─────────────────────────────────────────────────────────────────────────────
// 4. Structured events — the shared vocabulary the core understands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a log line MEANT, produced by the module's pure parseLine(). The core
 * never pattern-matches game text itself; it only reacts to these.
 */
export type GameEvent =
  /** The server finished starting and is accepting connections. */
  | { t: 'ready'; tookMs?: number }
  | { t: 'player-join'; name: string }
  | { t: 'player-leave'; name: string }
  | { t: 'chat'; name: string; text: string }
  /** Long-running startup work (world generation, mod loading), 0..100. */
  | { t: 'progress'; label: string; pct: number }
  | { t: 'warn'; text: string }
  /** `fatal` ⇒ restarting will hit the same wall (OOM, port in use, bad mod), so
   *  the core stops instead of burning through its restart budget. */
  | { t: 'error'; text: string; fatal?: boolean };

/** One line of console output, as buffered and shown in the UI. */
export interface ConsoleLine {
  /** Monotonic per-instance sequence — lets the renderer append without dupes. */
  seq: number;
  at: number;
  stream: 'out' | 'err' | 'sys';
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Content slots — how room files map into an instance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A place inside the instance that accepts shared content (mods, plugins,
 * datapacks, resource packs). Content arrives through the ordinary room manifest
 * (one infoHash per file), so this feature adds NO new transport — only the
 * mapping from "a room folder" to "this directory", plus the compatibility facts
 * the UI needs to warn about a mod built for the wrong loader.
 */
export interface ContentSlot {
  id: string;
  /** Translation key, not prose — see ConfigFieldBase. */
  labelKey: string;
  /** Destination inside the instance, e.g. 'mods'. */
  into: RelPath;
  /** Accepted extensions, lowercase with the dot, e.g. ['.jar']. */
  extensions: string[];
  /** True when the files here are executed by the game (mods/plugins). Drives the
   *  one-per-hash consent prompt: a resource pack is data, a mod is code. */
  executable: boolean;
  /** Free-form compatibility tag the UI matches across members, e.g.
   *  'fabric:1.21.4'. A mismatch is a warning, never a silent failure. */
  compat?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The module seam
// ─────────────────────────────────────────────────────────────────────────────

/** What the core exposes to a module while it builds a catalog. Deliberately
 *  minimal: a module gets HTTP-read and logging, and nothing else. */
export interface CatalogCtx {
  /** GET + JSON.parse through the core's fetcher (timeouts, size cap, caching). */
  fetchJson(url: string, opts?: { ttlMs?: number }): Promise<unknown>;
  /**
   * GET a SMALL text document — in practice a Maven `<artifact>.sha256`, which is
   * how Forge, NeoForge and Fabric publish the digests that make their installers
   * verifiable. Capped far below fetchJson's ceiling: a checksum is under 200
   * bytes, so anything larger is a wrong URL or a captive-portal login page, and
   * failing loudly beats hashing an HTML error document.
   */
  fetchText(url: string, opts?: { ttlMs?: number }): Promise<string>;
  log(msg: string): void;
}

/** The instance facts a module may read while building a plan. Read-only: a
 *  module mutates nothing, it returns a plan describing the mutation. */
export interface InstanceView {
  instanceId: string;
  moduleId: string;
  ref: GameVersionRef;
  /** Current config values (already parsed from the module's own format). */
  config: Readonly<Record<string, string>>;
  /** Memory ceiling in MiB the user allocated, if the module honours one. */
  memoryMb?: number;
  /** Virtual-LAN address this instance should advertise on, when a LAN session
   *  is up. Absent ⇒ no tunnel, so the server is reachable only locally. */
  vip?: string;
}

/** Optional capabilities, so the UI can hide what a module cannot do. */
export interface GameCaps {
  /** Has a console that accepts typed commands on stdin. */
  console: boolean;
  /** Exposes editable configuration. */
  config: boolean;
  /** Accepts shared content (mods etc.). */
  content: boolean;
  /** Can advertise itself on the local link (announcePlan). */
  announce: boolean;
  /** Supports an out-of-band population probe (probePlan). */
  probe: boolean;
  /** Can adopt server files the user supplies (scanImport). */
  import: boolean;
}

/**
 * A game module. First-party code (trust tier A). Every method is either pure or
 * a plan-builder; the two async ones only read through the supplied ctx.
 */
export interface GameModule {
  readonly id: string;
  readonly displayName: string;
  readonly caps: GameCaps;

  /** Available versions. The core caches the result and handles offline. */
  catalog(ctx: CatalogCtx): Promise<GameVersionRef[]>;

  /**
   * Turn a catalog entry into a fully-specified one, immediately before install.
   *
   * This exists so planInstall can stay PURE. Upstreams publish the download url
   * and digest in a per-version document (Mojang) or behind a per-build endpoint
   * (Paper), and fetching one of those for every entry just to render a list
   * would mean dozens of requests to draw a dropdown. So the catalog stays cheap
   * and the expensive lookup happens once, for the entry actually chosen.
   *
   * Absent ⇒ the catalog entry is already complete.
   */
  resolve?(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef>;

  /** Steps to materialise `ref` into an empty instance directory. PURE. */
  planInstall(ref: GameVersionRef, inst: InstanceView): InstallStep[];

  /** How to launch. PURE. */
  planLaunch(inst: InstanceView): LaunchPlan;

  /** Field descriptors for the settings form. PURE. */
  configSchema(inst: InstanceView): ConfigField[];

  /**
   * The few settings worth asking about BEFORE the first install, as a subset of
   * configSchema's keys. PURE and instance-free, because no instance exists yet.
   *
   * planInstall already seeds the config file from `inst.config`, and the comment
   * on that code said "from whatever the create form collected" — but the form
   * collected nothing, so the seed always wrote defaults and the user's first act
   * after creating a server was to stop it and open Settings. These are the fields
   * that removes.
   *
   * Deliberately a SHORT list. A create form that asks thirty questions is a
   * worse first experience than one that asks four and leaves the rest to the
   * settings tab.
   */
  createSchema?(): ConfigField[];

  /**
   * Where this module's instances listen, so the core can hand each new instance
   * a port of its own instead of letting every one of them claim the default.
   *
   * The module owns the two facts it knows — which config key holds the port and
   * where the range starts — and the core owns the effect it cannot: asking the
   * OS whether a candidate is actually free. Absent ⇒ the module needs no port.
   */
  readonly portPlan?: { configKey: string; base: number; span: number };
  /** Where the config lives inside the instance (read/written by the core). */
  configPath(inst: InstanceView): RelPath | null;
  /** Parse the module's own config format. PURE. */
  parseConfig(text: string): Record<string, string>;
  /** Serialise back, PRESERVING keys the schema does not know about — otherwise
   *  a hand-edited setting silently disappears the first time the form saves. */
  serializeConfig(values: Readonly<Record<string, string>>, previous?: string): string;

  /** One log line → zero or more structured events. PURE. */
  parseLine(line: string): GameEvent[];

  /** Graceful-stop recipe. PURE. */
  stopPlan(): StopPlan;

  /** Where shared content goes. PURE. */
  contentSlots(inst: InstanceView): ContentSlot[];

  /** Local-link advertisement, when this module supports one. PURE. */
  announcePlan?(inst: InstanceView): AnnouncePlan | null;
  /** Out-of-band probe, when this module supports one. PURE. */
  probePlan?(inst: InstanceView): ProbePlan | null;

  /**
   * Identify server files the USER supplied, instead of downloading a catalog
   * entry. PURE over a listing of the unpacked tree — which is the whole point:
   * "is this a Forge server, and how is it launched" is a question about file
   * NAMES, so it is answered by a unit test over a string array rather than by
   * unpacking real modpacks. The core does the unpacking and hands the listing in.
   *
   * Returns every candidate it can justify, best first. Zero candidates means
   * "this is not a server tree I recognise", which the UI must say plainly rather
   * than importing something that will never start.
   */
  scanImport?(files: readonly RelPath[]): ImportCandidate[];

  /**
   * A legal gate the user must clear before the first install (Minecraft's EULA).
   * The core refuses to install until consent is recorded, and NEVER records it
   * automatically: accepting a licence on someone's behalf is not ours to do.
   */
  readonly legalGate?: { id: string; labelKey: string; url: string };
}

/**
 * One way a user-supplied tree could be launched, as identified by scanImport.
 *
 * This is how "bring your own server" stays inside the trust model. The user
 * already owns these files and already had to pick them in a native dialog, but
 * that is NOT a licence to run whatever they name: the module decides which file
 * in the tree is launchable, and the core still resolves it as a RelPath under the
 * instance root and still runs it with a MANAGED runtime. So an imported zip can
 * contribute a jar path and a heap size — never an executable, never an argv.
 */
export interface ImportCandidate {
  /** Stable within one scan, so the UI can offer a choice between candidates. */
  id: string;
  /** Flavour this looks like: 'vanilla' | 'paper' | 'forge' | 'neoforge' | … */
  flavour: string;
  /** Game version read out of the tree, or '' when it cannot be told. */
  version: string;
  /** What the user sees. Prose, NOT a key: it is built from the file names found
   *  (e.g. "Forge 1.20.1 — run via libraries/…/unix_args.txt"), which no
   *  dictionary can contain. The surrounding UI chrome is translated. */
  label: string;
  /** Java major this tree needs, when the files say. Absent ⇒ the UI asks. */
  javaMajor?: number;
  /** Module-private launch facts, stored on the ref and read back by planLaunch —
   *  the same `meta` channel a resolved catalog entry uses. */
  meta: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Runtime state — what the manager keeps and the renderer draws
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instance lifecycle. 'crashed' is terminal-ish: it means the process exited
 * unexpectedly AND the restart budget is spent, so the UI must explain why
 * rather than showing a spinner forever (the LAN 'failed' lesson).
 */
export type ServerStatus =
  | 'idle'        // installed, not running
  | 'installing'
  | 'starting'    // spawned, no 'ready' event yet
  | 'running'
  | 'stopping'    // graceful stop in flight
  | 'stopped'     // exited cleanly at our request
  | 'crashed';    // exited unexpectedly; failReason says what we know

/** Why an instance is in a bad state. Tagged so the UI can offer the right fix
 *  instead of printing a stack trace. */
export type ServerFailReason =
  | 'install-failed'
  | 'runtime-missing'
  | 'launch-failed'
  | 'exited-early'      // died before ever reaching 'ready'
  | 'crash-loop'        // restart budget exhausted
  | 'fatal-log'         // the module flagged an unrecoverable log line
  | 'stop-timeout'      // had to be killed
  | 'unknown';

/** Our role for one instance. Mirrors the LAN host/admitted split: hosting is a
 *  fact about whose machine runs the process, operator is a host-signed grant. */
export type ServerRole = 'host' | 'operator' | 'viewer';

/** How this install's copy of an instance's required content compares to the
 *  host's. */
export type ContentSyncState = 'ok' | 'syncing' | 'missing' | 'conflict';

/** One instance as the renderer sees it. */
export interface RoomServerInstance {
  instanceId: string;
  moduleId: string;
  /** User-visible name (defaults to the module label + version). */
  name: string;
  /** Catalog entry label, e.g. 'Paper 1.21.4 (build 118)'. */
  version: string;
  /** memberId of the install running the process. */
  hostId: string;
  isHost: boolean;
  role: ServerRole;
  status: ServerStatus;
  /** Since when the current status holds (ms epoch) — drives "up for 2h". */
  since: number;
  /** 0..100 while installing. */
  installPct?: number;
  /** `vip:port` once a LAN session is up; absent means "reachable locally only",
   *  which the panel must say out loud rather than showing a blank field. */
  address?: string;
  /** Port the server listens on, even when no address is publishable yet. */
  port?: number;
  players?: { online: number; max: number; names?: string[] };
  /** Bumped whenever the required content set changes — the signal for other
   *  members to re-sync. The set itself rides the ordinary room manifest. */
  contentRev?: number;
  contentSync?: ContentSyncState;
  failReason?: ServerFailReason;
  /** One-line human detail behind failReason (last fatal log line, exit code). */
  failDetail?: string;
  /** Restart attempts spent in the current window — visible so a flapping server
   *  is obvious before the budget runs out. */
  restarts?: number;
  /**
   * The persisted auto-restart preference. Sent because the UI has a switch for
   * it, and a switch that renders a value derived from `status` instead of the
   * stored one snaps back the moment anything else pushes an update — which is
   * exactly what it used to do.
   */
  autoRestart: boolean;
  /**
   * Whether there is an upstream that could have a newer build of this.
   *
   * False for a tree the user imported from their own disk: nothing published it,
   * so "check for a newer build" has no answer. Sent rather than inferred, because
   * the renderer sees only a version LABEL and would have to guess from its text.
   */
  updatable: boolean;
}

/**
 * Result of staging and scanning user-supplied server files.
 *
 * Staging is a real directory the core unpacked into, NOT a promise to unpack
 * later: the user has to see what was actually found before an instance exists,
 * and re-reading a 2 GB modpack zip twice to answer the same question is a worse
 * design than keeping the unpacked tree for the length of one dialog. The core
 * deletes it on cancel and on shutdown, and moves it into place on create.
 */
export interface ImportScanResult {
  /** Handle for createImported / discardImport. */
  stagingId: string;
  /** What the module recognised, best first. Empty ⇒ nothing launchable found,
   *  and the UI says so instead of importing a tree that will never start. */
  candidates: ImportCandidate[];
  /** Files unpacked, for a "this really is your modpack" sanity line. */
  fileCount: number;
  /** Total bytes staged. */
  bytes: number;
}

/** Java majors the user may pick for an import whose files do not say. Offered as
 *  a list rather than a free number because a typo here fails at launch with an
 *  UnsupportedClassVersionError nobody should have to decode. */
export const IMPORT_JAVA_MAJORS = [8, 11, 16, 17, 21, 25] as const;

/** The game-server surface of one room, as this install sees it. Session-derived
 *  like RoomLanState: pushed wholesale to the renderer, never merged. */
export interface RoomServerState {
  /** This platform can host at all (a runtime can be installed here). */
  available: boolean;
  /** Modules compiled into this build, for the "create server" picker. */
  modules: { id: string; displayName: string; caps: GameCaps }[];
  instances: RoomServerInstance[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Console lines kept in memory per instance (full history goes to logs/). */
export const CONSOLE_BUFFER_LINES = 2000;

/** Longest single console line retained; longer ones are truncated with a marker
 *  so one runaway line cannot pin memory. */
export const MAX_CONSOLE_LINE = 4000;

/** Longest command accepted from the UI into stdin. */
export const MAX_COMMAND_LENGTH = 512;

/** Unexpected exits tolerated inside RESTART_WINDOW_MS before 'crash-loop'.
 *  Same reasoning as LAN_MAX_PEER_REBUILDS: enough to ride out a one-off, short
 *  enough that a genuinely broken server stops flapping within minutes. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 5 * 60_000;

/** Delay before an automatic restart, so a fast-failing process cannot spin. */
export const RESTART_DELAY_MS = 5_000;

/** How long the core waits after the grace period before killing the process
 *  tree outright. */
export const KILL_GRACE_MS = 10_000;

/** Hard ceiling on a single downloaded artifact (a server jar is ~50 MB; a JRE
 *  ~200 MB). Bounds a hostile or misconfigured URL. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** Ceiling on a catalog JSON response. */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
