/**
 * How a Minecraft server tree is launched — the one piece of knowledge that
 * differs between vanilla, Paper, Forge, NeoForge, Fabric and whatever a user
 * hands us in a zip.
 *
 * ─ TWO SHAPES, AND ONLY TWO ─────────────────────────────────────────────────
 *   JAR      `java -Xmx… -jar <file> nogui`
 *            Vanilla, Paper, Fabric, and Forge up to Minecraft 1.16.5.
 *
 *   ARGFILE  `java -Xmx… @<argfile> nogui`
 *            Forge 1.17+ and every NeoForge. Their installers stopped producing
 *            a runnable fat jar and now emit `run.sh` / `run.bat` around a Java
 *            @argfile holding the module path, the classpath and the main class.
 *
 * We launch the argfile DIRECTLY rather than running the shipped `run.sh`. That
 * is not squeamishness about shell scripts: `runtime-exec` and `LaunchPlan` both
 * take an argv for a MANAGED runtime precisely so that no module and no imported
 * archive can name an executable. Running an installer-authored batch file would
 * hand that capability straight back. The scripts do nothing else — they set no
 * variables and cd nowhere — so nothing is lost by reading the argfile ourselves.
 *
 * ─ WHY THE HEAP FLAGS GO BEFORE THE ARGFILE ─────────────────────────────────
 * The installers put heap settings in `user_jvm_args.txt` and reference it as a
 * second @argfile. We pass -Xms/-Xmx on the command line instead, because the
 * memory ceiling is a Havvn setting the user edits in the settings form, and a
 * value that lives in two places is a value that will disagree with itself.
 */
import type { ImportCandidate, InstanceView, LaunchPlan, RelPath } from '../../../../shared/gameserver-types';
import { javaMajorFor, neoforgeMinecraftVersion } from './versions';

/** Where an install puts the jar when there is one. Vanilla/Paper are renamed to
 *  this at fetch time so most flavours need no branching at all. */
export const SERVER_JAR: RelPath = 'server.jar';

/**
 * Point a Forge/NeoForge argfile at the variant this platform can actually use.
 *
 * The two files are NOT interchangeable. They are the same LENGTH — which is
 * what made "byte-identical" look true — but the classpath inside is joined with
 * `:` in unix_args.txt and `;` in win_args.txt, and the JVM does not translate
 * separators for an @argfile: it takes the string as given. Hand Windows the unix
 * file and the whole classpath collapses into one nonexistent path, so the loader
 * starts and dies with
 *
 *     Error: Could not find or load main class net.neoforged.fml.startup.Server
 *
 * which reads like a broken download and is not one — reinstalling reproduces it
 * exactly.
 *
 * Corrected HERE, at launch, rather than where the path is chosen. The ref's meta
 * is persisted with the instance and travels inside a shared preset, so a path
 * fixed at install time would keep every already-created server broken and would
 * hand a Linux-made preset to a Windows host. Normalising at use makes the stored
 * value platform-agnostic and repairs existing instances with no reinstall.
 */
export function platformArgfile(rel: string, platform: string = process.platform): string {
  const want = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  return rel.replace(/(unix|win)_args\.txt$/, want);
}

/**
 * Read the launch shape off a resolved ref's meta.
 *
 * `meta` is the channel the catalog (or the import scan) uses to hand launch
 * facts to planLaunch, which is PURE and therefore cannot look at the disk. Both
 * producers write one of exactly two keys, so an unrecognised ref is a bug in
 * this module rather than a state the user can reach.
 */
export function launchArgsFor(inst: InstanceView, heapMb: number): string[] {
  const heap = [`-Xms${heapMb}M`, `-Xmx${heapMb}M`];
  const meta = inst.ref.meta ?? {};

  const argfile = typeof meta.argfile === 'string' ? meta.argfile : null;
  if (argfile) {
    // Forge's modern argfile ends in the main class and its own program args, so
    // `nogui` must follow it — exactly where run.sh puts "$@".
    return [...heap, `@${platformArgfile(argfile)}`, 'nogui'];
  }

  const jar = typeof meta.launchJar === 'string' ? meta.launchJar : SERVER_JAR;
  return [...heap, '-jar', jar, 'nogui'];
}

/** The default launch plan shared by every flavour. */
export function minecraftLaunchPlan(inst: InstanceView, heapMb: number): LaunchPlan {
  return {
    runtime: inst.ref.runtime,
    // -Xms equal to -Xmx: a server that grows its heap gradually spends the first
    // minutes garbage-collecting instead of generating chunks, and the memory is
    // committed for the session either way.
    args: launchArgsFor(inst, heapMb),
    cwd: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Import scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything below answers ONE question — "given the names of the files in this
 * folder, what would start a server?" — and answers it over a `string[]`, with
 * no filesystem anywhere. That is what makes "does Havvn understand a NeoForge
 * server pack" a unit test instead of a 2 GB download.
 */

/** `libraries/net/neoforged/neoforge/21.1.209/unix_args.txt` and the Forge
 *  equivalent. The version is the second-to-last component. */
const ARGFILE = /^libraries\/net\/(neoforged\/neoforge|minecraftforge\/forge)\/([^/]+)\/(unix|win)_args\.txt$/;

/** A modern Forge install also leaves its shim jar in the root. Recognised so an
 *  import of a Forge pack whose argfile was pruned still starts. */
const FORGE_SHIM = /^forge-(.+)-shim\.jar$/;

/** Legacy Forge's runnable jar: `forge-1.16.5-36.2.42.jar`. Deliberately does
 *  NOT match `-installer` or `-shim`, which are different files entirely. */
const LEGACY_FORGE_JAR = /^forge-([0-9][^-]*)-([^-]+)\.jar$/;

/** Fabric's installer output. */
const FABRIC_LAUNCH = 'fabric-server-launch.jar';

/** Paper names its jar after the build; people also just call it server.jar. */
const PAPER_JAR = /^paper(?:-[\w.]+)*\.jar$/i;

/** A plain vanilla download, under either name Mojang has used. */
const VANILLA_JAR = /^(server|minecraft_server(?:\.[\w.]+)?)\.jar$/i;

/** Anything else at the root that is a jar and is not obviously not a server. */
const NOT_A_SERVER = /(installer|shim|-sources|-javadoc|bootstrap)/i;

interface Found {
  id: string;
  flavour: string;
  version: string;
  label: string;
  javaMajor?: number;
  meta: Record<string, unknown>;
  /** Higher wins. Ordering matters: a Forge pack contains a vanilla server jar
   *  too, and offering that first would start Minecraft with none of the mods. */
  rank: number;
}

/**
 * Identify every launchable shape in a listing of relative paths.
 *
 * Ranked rather than filtered: a modded server pack legitimately contains more
 * than one runnable jar (the loader's, and the vanilla one it was built against),
 * so the honest answer is an ordered list the user can override — not a guess
 * presented as a fact.
 */
export function scanMinecraftTree(files: readonly RelPath[]): ImportCandidate[] {
  const found: Found[] = [];
  const root = files.filter((f) => !f.includes('/'));

  for (const file of files) {
    const arg = ARGFILE.exec(file);
    if (!arg) continue;
    const neo = arg[1].startsWith('neoforged');
    const coord = arg[2];
    // Forge's argfile coordinate is `<mcver>-<forgever>`; NeoForge's is its own
    // version, which encodes the Minecraft one.
    const mc = neo ? neoforgeMinecraftVersion(coord) : coord.split('-')[0];
    found.push({
      id: `argfile:${coord}`,
      flavour: neo ? 'neoforge' : 'forge',
      version: mc,
      label: `${neo ? 'NeoForge' : 'Forge'} ${coord}`,
      javaMajor: mc ? javaMajorFor(mc) : undefined,
      // The listing may contain either variant (installers write both), and they
      // are NOT interchangeable — see platformArgfile, which picks the runnable
      // one at launch. Storing whichever we saw is therefore fine.
      meta: { argfile: file },
      rank: 100,
    });
  }

  for (const file of root) {
    if (file === FABRIC_LAUNCH) {
      found.push({
        id: 'jar:fabric', flavour: 'fabric', version: '', label: 'Fabric server',
        meta: { launchJar: file }, rank: 90,
      });
      continue;
    }

    const shim = FORGE_SHIM.exec(file);
    if (shim) {
      const mc = shim[1].split('-')[0];
      found.push({
        id: `jar:${file}`, flavour: 'forge', version: mc, label: `Forge ${shim[1]}`,
        javaMajor: javaMajorFor(mc), meta: { launchJar: file }, rank: 95,
      });
      continue;
    }

    const legacy = LEGACY_FORGE_JAR.exec(file);
    if (legacy) {
      found.push({
        id: `jar:${file}`, flavour: 'forge', version: legacy[1], label: `Forge ${legacy[1]}-${legacy[2]}`,
        javaMajor: javaMajorFor(legacy[1]), meta: { launchJar: file }, rank: 95,
      });
      continue;
    }

    if (PAPER_JAR.test(file)) {
      found.push({
        id: `jar:${file}`, flavour: 'paper', version: '', label: `Paper (${file})`,
        meta: { launchJar: file }, rank: 80,
      });
      continue;
    }

    if (VANILLA_JAR.test(file)) {
      found.push({
        id: `jar:${file}`, flavour: 'vanilla', version: '', label: `Minecraft server (${file})`,
        meta: { launchJar: file }, rank: 50,
      });
      continue;
    }

    // A last resort so an unusual but perfectly good jar is not rejected outright.
    // Ranked below everything named, and excluded when the name says it is a
    // build artefact rather than a server.
    if (file.toLowerCase().endsWith('.jar') && !NOT_A_SERVER.test(file)) {
      found.push({
        id: `jar:${file}`, flavour: 'unknown', version: '', label: file,
        meta: { launchJar: file }, rank: 10,
      });
    }
  }

  // Stable: equal ranks keep listing order, so the same zip always scans the same.
  return found
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (b.f.rank - a.f.rank) || (a.i - b.i))
    .map(({ f }) => ({
      id: f.id,
      flavour: f.flavour,
      version: f.version,
      label: f.label,
      ...(f.javaMajor !== undefined ? { javaMajor: f.javaMajor } : {}),
      meta: f.meta,
    }));
}
