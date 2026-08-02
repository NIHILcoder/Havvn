/**
 * The Minecraft game module (trust tier A — first-party code in this bundle).
 *
 * Everything game-specific lives here: which Java a version needs, what
 * server.properties looks like, what "Done (12.3s)!" means, how to shut down
 * politely, and the LAN announcement a dedicated server does not send for
 * itself. The core knows none of it.
 *
 * Nothing here performs an effect. planInstall/planLaunch/stopPlan return plans,
 * parseLine/parseConfig/scanImport are pure — which is why the whole module is
 * unit-tested with no JVM, no network and no Electron.
 *
 * EVERY USER-FACING STRING IS A TRANSLATION KEY. This code runs in the main
 * process and has no dictionary; returning English prose would make the settings
 * form the one part of a Russian UI that stayed in English.
 */
import {
  parseProperties, serializeProperties, propInt,
} from './properties';
import { parseMinecraftLine } from './log-parser';
import { minecraftCatalog, resolveMinecraftRef } from './catalog';
import { minecraftAnnouncePlan } from './announce';
import { minecraftLaunchPlan, scanMinecraftTree, SERVER_JAR } from './launch';
import type {
  AnnouncePlan, CatalogCtx, ConfigField, ContentSlot, GameEvent, GameModule,
  GameVersionRef, ImportCandidate, InstallStep, InstanceView, LaunchPlan, ProbePlan,
  RelPath, StopPlan,
} from '../../../../shared/gameserver-types';

const PROPERTIES: RelPath = 'server.properties';

export const DEFAULT_PORT = 25565;
const DEFAULT_MEMORY_MB = 2048;

/** Where a loader installer is parked while it runs, and removed from afterwards.
 *  Inside the instance so the core's path containment covers it. */
const INSTALLER_JAR: RelPath = 'havvn-installer.jar';

/** Loader installers download the vanilla server and a few hundred libraries.
 *  Ten minutes is generous for a slow line and still bounded, so a hung installer
 *  surfaces as a failed install rather than an instance stuck at "installing". */
const INSTALLER_TIMEOUT_MS = 10 * 60_000;

/** Minecraft's licence gate. The core refuses to install until this is accepted
 *  and NEVER accepts it automatically — agreeing to a licence on the user's
 *  behalf is not something an installer gets to do quietly. */
const EULA_GATE = {
  id: 'minecraft-eula',
  labelKey: 'rooms.server.eula.name',
  url: 'https://aka.ms/MinecraftEULA',
};

function memoryMb(inst: InstanceView): number {
  const fromConfig = propInt(inst.config, 'havvn-memory-mb', 0);
  return fromConfig || inst.memoryMb || DEFAULT_MEMORY_MB;
}

export function portOf(inst: InstanceView): number {
  const port = propInt(inst.config, 'server-port', DEFAULT_PORT);
  return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

/** The EULA file, written as accepted ONLY because the core refused to reach this
 *  point without a recorded user consent for EULA_GATE. Writing it up front skips
 *  the deliberate failed first launch every Minecraft server does otherwise. */
function eulaStep(): InstallStep {
  return {
    t: 'write',
    path: 'eula.txt',
    text: `# Accepted through Havvn on ${new Date().toISOString()}\neula=true\n`,
  };
}

/** server.properties seeded from whatever the create form collected, so the first
 *  boot already has the user's port and MOTD rather than the defaults. */
function propertiesStep(inst: InstanceView, ifAbsent = false): InstallStep {
  return {
    t: 'write',
    path: PROPERTIES,
    ...(ifAbsent ? { ifAbsent: true } : {}),
    text: serializeProperties({
      'server-port': String(portOf(inst)),
      motd: inst.config.motd || 'A Havvn server',
      'max-players': inst.config['max-players'] || '10',
      difficulty: inst.config.difficulty || 'normal',
      gamemode: inst.config.gamemode || 'survival',
      pvp: inst.config.pvp || 'true',
      'online-mode': inst.config['online-mode'] || 'true',
      'view-distance': inst.config['view-distance'] || '10',
      'simulation-distance': inst.config['simulation-distance'] || '10',
      'level-seed': inst.config['level-seed'] || '',
      'white-list': inst.config['white-list'] || 'false',
      'enable-command-block': inst.config['enable-command-block'] || 'false',
      'spawn-protection': inst.config['spawn-protection'] || '0',
    }),
  };
}

/**
 * Vanilla and Paper: one jar, fetched under a fixed name.
 *
 * Renaming to `server.jar` at fetch time is what lets planLaunch stay free of
 * flavour branching — the alternative is a launch plan that has to know Paper
 * names its download `paper-1.21.4-118.jar`.
 */
function planPlainJar(ref: GameVersionRef, inst: InstanceView): InstallStep[] {
  const url = typeof ref.meta?.jarUrl === 'string' ? ref.meta.jarUrl : null;
  const sha256 = typeof ref.meta?.jarSha256 === 'string' ? ref.meta.jarSha256 : null;
  const sha1 = typeof ref.meta?.jarSha1 === 'string' ? ref.meta.jarSha1 : null;
  if (!url || (!sha256 && !sha1)) {
    // resolve() must run first; reaching here is a bug in the manager, not a
    // user-facing condition, so it fails loudly rather than downloading
    // something unverified.
    throw new Error(`Minecraft ref ${ref.id} was not resolved to a verifiable download`);
  }
  return [
    {
      t: 'fetch',
      url,
      hash: sha256
        ? { algo: 'vendor', from: 'paper', digest: 'sha256', hex: sha256 }
        : { algo: 'vendor', from: 'mojang', digest: 'sha1', hex: sha1 as string },
      into: SERVER_JAR,
      label: `downloading ${ref.label}`,
    },
    eulaStep(),
    propertiesStep(inst),
  ];
}

/**
 * Forge, NeoForge and Fabric: fetch a verified INSTALLER, then run it.
 *
 * `runtime-exec` is the single privileged step in the whole system and this is
 * what it exists for. Note what is still true here: the executable is the core's
 * own hash-verified JRE, the jar being run was digest-checked moments earlier
 * against the publisher's Maven checksum, the cwd is inside the instance, and
 * `produces` is asserted afterwards — so an installer that exits 0 having done
 * nothing surfaces as a failed install rather than a server that never starts.
 */
function planLoaderInstall(ref: GameVersionRef, inst: InstanceView): InstallStep[] {
  const url = typeof ref.meta?.installerUrl === 'string' ? ref.meta.installerUrl : null;
  const sha256 = typeof ref.meta?.installerSha256 === 'string' ? ref.meta.installerSha256 : null;
  const sha512 = typeof ref.meta?.installerSha512 === 'string' ? ref.meta.installerSha512 : null;
  if (!url || (!sha256 && !sha512)) {
    throw new Error(`Minecraft ref ${ref.id} was not resolved to a verifiable installer`);
  }

  const vendor = ref.flavour === 'fabric' ? 'fabric' : ref.flavour === 'neoforge' ? 'neoforge' : 'forge';
  const produces = typeof ref.meta?.argfile === 'string'
    ? [ref.meta.argfile]
    : [typeof ref.meta?.launchJar === 'string' ? ref.meta.launchJar : SERVER_JAR];

  return [
    {
      t: 'fetch',
      url,
      hash: sha256
        ? { algo: 'vendor', from: vendor, digest: 'sha256', hex: sha256 }
        : { algo: 'vendor', from: vendor, digest: 'sha512', hex: sha512 as string },
      into: INSTALLER_JAR,
      label: `downloading ${ref.label}`,
    },
    // Written BEFORE the installer runs: Fabric's installer starts the server to
    // generate its config, and would stop on the licence prompt otherwise.
    eulaStep(),
    {
      t: 'runtime-exec',
      runtime: ref.runtime,
      args: installerArgs(ref),
      cwd: '',
      timeoutMs: INSTALLER_TIMEOUT_MS,
      produces,
      label: `installing ${ref.label}`,
    },
    // The installer is ~10 MB of no further use, and leaving it in the server root
    // means the next scanImport of this folder finds it and offers to launch it.
    { t: 'remove', path: INSTALLER_JAR },
    propertiesStep(inst),
  ];
}

/**
 * Argv for each loader's headless installer.
 *
 * Fabric's takes single-dash flags and a subcommand; Forge and NeoForge take a
 * GNU-style one. Both are first-party constants here — a module supplies argv,
 * never an executable, so this is data the core validates rather than a command
 * line anyone outside this file can influence.
 */
function installerArgs(ref: GameVersionRef): string[] {
  if (ref.flavour === 'fabric') {
    const loader = typeof ref.meta?.loaderVersion === 'string' ? ref.meta.loaderVersion : '';
    return [
      '-jar', INSTALLER_JAR, 'server',
      '-dir', '.',
      '-mcversion', ref.version,
      '-loader', loader,
      // Without this the vanilla jar is only fetched at first launch, which turns
      // a network failure into a crash loop instead of a failed install.
      '-downloadMinecraft',
    ];
  }
  return ['-jar', INSTALLER_JAR, '--installServer', '.'];
}

/**
 * The handful of settings worth asking before the first boot.
 *
 * Port first, because it is the one the core pre-fills with a free number and the
 * one that silently broke the second server in a room. Memory second, because it
 * is the setting people actually come looking for and the one they cannot change
 * without a restart. MOTD and max players are cheap to ask and annoying to fix
 * afterwards, since editing them means stopping a server you just started.
 *
 * Everything else stays in the settings tab. Difficulty, gamemode, view distance
 * and the rest are all changeable while nobody is connected, and a create form
 * that asks fourteen questions is a worse introduction than one that asks four.
 */
const CREATE_KEYS = ['server-port', 'havvn-memory-mb', 'motd', 'max-players'];

/** Every setting the form can show. Named separately from the GameModule method
 *  so createSchema can select from it without inventing an InstanceView it has no
 *  use for — the schema does not depend on the instance. */
function configFields(): ConfigField[] {
  return [
    { t: 'text', key: 'motd', labelKey: 'rooms.server.cfg.motd', maxLength: 59, helpKey: 'rooms.server.cfg.motd.help' },
    { t: 'int', key: 'server-port', labelKey: 'rooms.server.cfg.port', min: 1, max: 65535 },
    { t: 'int', key: 'max-players', labelKey: 'rooms.server.cfg.maxPlayers', min: 1, max: 1000 },
    {
      t: 'select',
      key: 'gamemode',
      labelKey: 'rooms.server.cfg.gamemode',
      options: [
        { value: 'survival', labelKey: 'rooms.server.cfg.gamemode.survival' },
        { value: 'creative', labelKey: 'rooms.server.cfg.gamemode.creative' },
        { value: 'adventure', labelKey: 'rooms.server.cfg.gamemode.adventure' },
        { value: 'spectator', labelKey: 'rooms.server.cfg.gamemode.spectator' },
      ],
    },
    {
      t: 'select',
      key: 'difficulty',
      labelKey: 'rooms.server.cfg.difficulty',
      options: [
        { value: 'peaceful', labelKey: 'rooms.server.cfg.difficulty.peaceful' },
        { value: 'easy', labelKey: 'rooms.server.cfg.difficulty.easy' },
        { value: 'normal', labelKey: 'rooms.server.cfg.difficulty.normal' },
        { value: 'hard', labelKey: 'rooms.server.cfg.difficulty.hard' },
      ],
    },
    { t: 'bool', key: 'pvp', labelKey: 'rooms.server.cfg.pvp' },
    { t: 'text', key: 'level-seed', labelKey: 'rooms.server.cfg.seed', helpKey: 'rooms.server.cfg.seed.help' },
    { t: 'int', key: 'havvn-memory-mb', labelKey: 'rooms.server.cfg.memory', min: 512, max: 65536, helpKey: 'rooms.server.cfg.memory.help' },
    { t: 'bool', key: 'white-list', labelKey: 'rooms.server.cfg.whitelist', advanced: true },
    { t: 'int', key: 'view-distance', labelKey: 'rooms.server.cfg.viewDistance', min: 3, max: 32, advanced: true },
    { t: 'int', key: 'simulation-distance', labelKey: 'rooms.server.cfg.simDistance', min: 3, max: 32, advanced: true },
    { t: 'int', key: 'spawn-protection', labelKey: 'rooms.server.cfg.spawnProtection', min: 0, max: 256, advanced: true },
    { t: 'bool', key: 'enable-command-block', labelKey: 'rooms.server.cfg.commandBlocks', advanced: true },
    {
      t: 'bool',
      key: 'online-mode',
      labelKey: 'rooms.server.cfg.onlineMode',
      advanced: true,
      warnKey: 'rooms.server.cfg.onlineMode.warn',
    },
  ];
}

export const minecraftModule: GameModule = {
  id: 'minecraft',
  displayName: 'Minecraft',
  caps: { console: true, config: true, content: true, announce: true, probe: true, import: true },
  legalGate: EULA_GATE,

  // 25565 is what the game's own client pre-fills, so the FIRST server in a room
  // should have it. The span covers a room hosting more servers than anyone
  // sensibly will, and running out is reported rather than silently wrapping back
  // onto a port a sibling already holds.
  portPlan: { configKey: 'server-port', base: DEFAULT_PORT, span: 64 },

  catalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
    return minecraftCatalog(ctx);
  },

  resolve(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
    return resolveMinecraftRef(ref, ctx);
  },

  planInstall(ref: GameVersionRef, inst: InstanceView): InstallStep[] {
    switch (ref.flavour) {
      case 'forge':
      case 'neoforge':
      case 'fabric':
        return planLoaderInstall(ref, inst);
      // The files are already in place — the core moved the user's own tree in.
      // Only the EULA and a properties seed are missing, and the seed is
      // ifAbsent, so an imported world keeps the port and whitelist it came with.
      case 'imported':
        return [eulaStep(), propertiesStep(inst, true)];
      default:
        return planPlainJar(ref, inst);
    }
  },

  planLaunch(inst: InstanceView): LaunchPlan {
    return minecraftLaunchPlan(inst, memoryMb(inst));
  },

  scanImport(files: readonly RelPath[]): ImportCandidate[] {
    return scanMinecraftTree(files);
  },

  configSchema(): ConfigField[] {
    return configFields();
  },

  createSchema(): ConfigField[] {
    // Selected from the same list rather than written out again, so a field cannot
    // be renamed in one place and go on being asked for under its old key in the
    // other. The order follows CREATE_KEYS, not the settings form's.
    const byKey = new Map(configFields().map((f) => [f.key, f]));
    return CREATE_KEYS
      .map((k) => byKey.get(k))
      .filter((f): f is ConfigField => f !== undefined)
      // 'advanced' is a settings-form affordance for hiding things; every field we
      // ask at creation is one we decided is worth asking.
      .map((f) => ({ ...f, advanced: false }));
  },

  configPath(): RelPath {
    return PROPERTIES;
  },

  parseConfig(text: string): Record<string, string> {
    return parseProperties(text);
  },

  serializeConfig(values: Readonly<Record<string, string>>, previous?: string): string {
    // Havvn-only keys are kept out of the game's file: Minecraft rewrites
    // server.properties on every shutdown and would not preserve them anyway.
    const gameValues = Object.fromEntries(
      Object.entries(values).filter(([k]) => !k.startsWith('havvn-')),
    );
    return serializeProperties(gameValues, previous);
  },

  parseLine(line: string): GameEvent[] {
    return parseMinecraftLine(line);
  },

  stopPlan(): StopPlan {
    // 'stop' triggers a world save. Sixty seconds sounds generous until you have
    // watched a large modded world flush to disk; killing early corrupts saves,
    // which is a far worse outcome than waiting.
    return { command: 'stop', graceMs: 60_000 };
  },

  contentSlots(inst: InstanceView): ContentSlot[] {
    const compat = `${inst.ref.flavour}:${inst.ref.version}`;
    const datapacks: ContentSlot = {
      id: 'datapacks', labelKey: 'rooms.server.slot.datapacks', into: 'world/datapacks',
      extensions: ['.zip'], executable: false, compat,
    };

    // Which folder the server actually reads depends on the loader, and offering
    // a mods folder to a server that cannot load mods is a way to waste an
    // evening. An imported tree gets both, because we cannot always tell which
    // it is and being wrong in the restrictive direction is the worse failure.
    switch (inst.ref.flavour) {
      case 'paper':
        return [
          { id: 'plugins', labelKey: 'rooms.server.slot.plugins', into: 'plugins', extensions: ['.jar'], executable: true, compat },
          datapacks,
        ];
      case 'forge':
      case 'neoforge':
      case 'fabric':
        return [
          { id: 'mods', labelKey: 'rooms.server.slot.mods', into: 'mods', extensions: ['.jar'], executable: true, compat },
          datapacks,
        ];
      case 'imported':
        return [
          { id: 'mods', labelKey: 'rooms.server.slot.mods', into: 'mods', extensions: ['.jar'], executable: true, compat },
          { id: 'plugins', labelKey: 'rooms.server.slot.plugins', into: 'plugins', extensions: ['.jar'], executable: true, compat },
          datapacks,
        ];
      default:
        return [datapacks];
    }
  },

  announcePlan(inst: InstanceView): AnnouncePlan | null {
    // No tunnel address means nothing to advertise: the announcement is only
    // useful to members reachable over the virtual LAN.
    if (!inst.vip) return null;
    return minecraftAnnouncePlan(inst.config.motd || 'A Havvn server', portOf(inst));
  },

  probePlan(inst: InstanceView): ProbePlan {
    // Probe over loopback rather than the vIP: the server is on THIS machine, and
    // loopback keeps working while the tunnel is down or restarting.
    return { kind: 'minecraft-slp', host: '127.0.0.1', port: portOf(inst), timeoutMs: 3000 };
  },
};
