/**
 * The 'generic' game module: run a plain command and treat its output as a log.
 *
 * IT EXISTS TO KEEP THE CORE HONEST. While Minecraft is the only module, the
 * core inevitably absorbs Minecraft assumptions — a hardcoded java runtime, a
 * server.properties shape, a LAN announce that "everything" needs — and by the
 * time a second module is attempted the seam has to be rebuilt. A deliberately
 * trivial second implementation makes those assumptions fail to compile instead.
 *
 * It is also the supervisor's test fixture: pointed at a small script it can
 * exercise readiness, graceful stop, the stop timeout, tree kill and the restart
 * budget with no JVM and no network, which is what keeps that machinery covered
 * in CI.
 *
 * NOT a user-facing escape hatch for arbitrary commands: `planLaunch` still goes
 * through a MANAGED runtime, so this cannot be pointed at an arbitrary .exe on
 * disk. Widening it to accept a user-supplied executable would move the trust
 * boundary, not add a feature.
 */
import type {
  ConfigField, GameEvent, GameModule, GameVersionRef, InstallStep, InstanceView,
  LaunchPlan, StopPlan, ContentSlot,
} from '../../../../shared/gameserver-types';

/** The single catalog entry: there is nothing to choose. */
const REF: GameVersionRef = {
  id: 'generic:script',
  label: 'Generic script server',
  flavour: 'script',
  version: '1',
  runtime: { id: 'java', major: 21 },
  stable: true,
};

export const genericModule: GameModule = {
  id: 'generic',
  displayName: 'Generic server',
  caps: { console: true, config: true, content: false, announce: false, probe: false, import: false },

  async catalog(): Promise<GameVersionRef[]> {
    return [REF];
  },

  planInstall(): InstallStep[] {
    // Nothing to install: the operator supplies the jar out of band. Returning an
    // empty plan is legal and exercises the installer's zero-step path.
    return [];
  },

  planLaunch(inst: InstanceView): LaunchPlan {
    const jar = inst.config.jar || 'server.jar';
    const memory = Number(inst.config.memoryMb || inst.memoryMb || 1024);
    return {
      runtime: REF.runtime,
      args: [`-Xmx${memory}M`, '-jar', jar, 'nogui'],
      cwd: '',
    };
  },

  configSchema(): ConfigField[] {
    return [
      { t: 'text', key: 'jar', labelKey: 'rooms.server.cfg.jar', helpKey: 'rooms.server.cfg.jar.help', placeholderKey: 'rooms.server.cfg.jar.placeholder' },
      { t: 'int', key: 'memoryMb', labelKey: 'rooms.server.cfg.memory', min: 256, max: 65536 },
    ];
  },

  configPath(): string | null {
    return null; // config lives in instance.json, not in a game-owned file
  },

  parseConfig(text: string): Record<string, string> {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      // Fall through: an unparseable config is treated as empty rather than
      // failing the instance, so a hand-edit typo is recoverable from the UI.
    }
    return {};
  },

  serializeConfig(values: Readonly<Record<string, string>>): string {
    return JSON.stringify(values, null, 2);
  },

  parseLine(line: string): GameEvent[] {
    // A minimal vocabulary, chosen so a test script can drive every FSM path.
    if (/^READY\b/.test(line)) return [{ t: 'ready' }];
    if (/^FATAL\b/.test(line)) return [{ t: 'error', text: line.slice(6).trim() || line, fatal: true }];
    if (/^ERROR\b/.test(line)) return [{ t: 'error', text: line.slice(6).trim() || line }];
    if (/^WARN\b/.test(line)) return [{ t: 'warn', text: line.slice(5).trim() || line }];
    return [];
  },

  stopPlan(): StopPlan {
    return { command: 'stop', graceMs: 10_000 };
  },

  contentSlots(): ContentSlot[] {
    return [];
  },
};
