/**
 * Version catalog for Minecraft servers — vanilla, Paper, Forge, NeoForge and
 * Fabric.
 *
 * HAVVN NEVER REDISTRIBUTES A SERVER JAR. Every entry here points at the
 * publisher's own download, and every download is verified against the digest
 * THAT PUBLISHER declares. Pinning digests in this repository is impossible for
 * versions that do not exist yet, so the root of trust is TLS to the vendor — the
 * 'vendor' tier of HashRef, which the UI states in as many words rather than
 * implying a stronger guarantee than we have.
 *
 * ─ WHY THE LOADERS TOOK A SECOND PASS ───────────────────────────────────────
 * The first cut shipped vanilla and Paper only, on the grounds that Fabric
 * published no checksum. That was half right, and the half that was wrong is
 * worth writing down so nobody re-derives it:
 *
 *   • Forge and NeoForge are ordinary MAVEN repositories, and Maven publishes
 *     `<artifact>.sha256` next to every artifact. So both installers are
 *     verifiable exactly like Paper is.
 *   • Fabric's meta service really does not publish a digest for the server
 *     launcher it generates on demand (`/server/jar` — no checksum, no ETag).
 *     But the Fabric MAVEN publishes `fabric-installer-<v>.jar.sha512`, and that
 *     installer produces the same server. So Fabric is verifiable too, by taking
 *     the maven path instead of the convenient one.
 *
 * The rule that survived: if an artifact has no publisher digest, we do not
 * download it. Every URL below has one.
 *
 * ─ UPSTREAM ENDPOINTS ARE A DEPENDENCY, NOT A CONSTANT ──────────────────────
 * Every URL in this file was re-verified against the live service. Two of them
 * had moved, and the Paper one had moved by being DELETED:
 *
 *   • Paper's `api.papermc.io/v2` now answers 410 Gone for every request. Its
 *     replacement is the Fill API at `fill.papermc.io/v3`, whose payloads are
 *     shaped differently in three ways that all matter (see paperCatalog).
 *   • Paper additionally REQUIRES a descriptive User-Agent naming the software
 *     and a contact URL. That is handled once, for every upstream, in fetcher.ts.
 *
 * Verified unchanged and current: Mojang piston-meta, Forge's promotions_slim,
 * NeoForge's maven API, Fabric meta v2 (there is no v3), Adoptium v3 (no v4).
 * NeoForge's API answers 404 to HEAD and 200 to GET, so probing it with the
 * wrong verb reads as "gone" when it is fine — worth knowing before deleting it.
 */
import type { CatalogCtx, GameVersionRef } from '../../../../shared/gameserver-types';
import {
  compareVersionsDesc, isLegacyForge, isReleaseVersion, javaMajorFor, neoforgeMinecraftVersion,
  versionFamily,
} from './versions';

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_PROJECT = 'https://fill.papermc.io/v3/projects/paper';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_VERSIONS = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const FABRIC_LOADER = 'https://meta.fabricmc.net/v2/versions/loader';
const FABRIC_INSTALLER = 'https://meta.fabricmc.net/v2/versions/installer';

/**
 * How many version FAMILIES to offer per flavour.
 *
 * This used to be a flat cap of 25 individual versions, which sounded reasonable
 * and was not: 25 releases back from 26.2 stops at 1.19.3, so 1.16.5 and 1.12.2 —
 * the two versions the majority of existing Forge modpacks target — could not be
 * chosen at all. The full vanilla list is still no good as one dropdown (~700
 * entries back to 2011), but the problem was the flat SHAPE, not the length: 14
 * families reaches back past 1.10 while each list stays short enough to read.
 */
const CATALOG_FAMILY_LIMIT = 14;

const HOUR = 60 * 60_000;
const MONTH = 30 * 24 * HOUR;

/** A Maven repo publishes `<artifact>.sha256` beside every artifact. That file is
 *  a bare hex digest, and it is what makes the loader installers verifiable. */
function mavenDigestUrl(artifactUrl: string, algo: 'sha256' | 'sha512'): string {
  return `${artifactUrl}.${algo}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vanilla
// ─────────────────────────────────────────────────────────────────────────────

interface MojangManifest {
  versions?: { id?: string; type?: string; url?: string }[];
}

async function vanillaCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const body = (await ctx.fetchJson(MOJANG_MANIFEST, { ttlMs: 6 * HOUR })) as MojangManifest;
  const versions = Array.isArray(body?.versions) ? body.versions : [];
  const out: GameVersionRef[] = [];
  for (const v of versions) {
    if (v?.type !== 'release' || typeof v.id !== 'string' || typeof v.url !== 'string') continue;
    out.push({
      id: `vanilla:${v.id}`,
      label: `Minecraft ${v.id}`,
      flavour: 'vanilla',
      version: v.id,
      runtime: { id: 'java', major: javaMajorFor(v.id) },
      stable: true,
      meta: { versionUrl: v.url },
    });
  }
  return out;
}

interface MojangVersionDoc {
  downloads?: { server?: { url?: string; sha1?: string } };
  javaVersion?: { majorVersion?: number };
}

/** Mojang's per-version document, the one place a vanilla server jar's URL and
 *  sha1 are published. Also used by the loaders, which need the vanilla version
 *  list to know which Minecraft versions exist at all. */
async function mojangVersionDoc(url: string, ctx: CatalogCtx): Promise<MojangVersionDoc> {
  return (await ctx.fetchJson(url, { ttlMs: MONTH })) as MojangVersionDoc;
}

async function resolveVanilla(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  const versionUrl = typeof ref.meta?.versionUrl === 'string' ? ref.meta.versionUrl : null;
  if (!versionUrl) throw new Error(`catalog entry ${ref.id} has no version document`);
  const doc = await mojangVersionDoc(versionUrl, ctx);
  const server = doc?.downloads?.server;
  if (!server?.url || !server?.sha1) {
    // Versions before 1.2.5 ship no server download at all; say so plainly.
    throw new Error(`Mojang publishes no server download for Minecraft ${ref.version}`);
  }
  const major = Number.isInteger(doc?.javaVersion?.majorVersion)
    ? (doc.javaVersion as { majorVersion: number }).majorVersion
    : javaMajorFor(ref.version);
  return {
    ...ref,
    runtime: { id: 'java', major },
    meta: { jarUrl: server.url, jarSha1: server.sha1.toLowerCase(), launchJar: 'server.jar' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill (v3) groups versions by FAMILY — `{ "1.21": ["1.21.11", …], "26.2": […] }`
 * — where v2 returned one flat ascending array. Flattening and re-sorting here
 * rather than trusting the document order is what keeps the calver/semver mix
 * (26.2 alongside 1.21.11) in the right order.
 */
interface PaperProject { versions?: Record<string, unknown> }

/**
 * One Fill build. Three differences from v2 that the old parser would have got
 * wrong even if v2's URL still answered:
 *
 *   1. The array is newest-FIRST. v2's was newest-last, so the old
 *      `builds[builds.length - 1]` now picks the OLDEST build of the version.
 *   2. `channel` distinguishes STABLE from experimental. v2 had no such field
 *      and the newest build was always the answer; here the newest build of a
 *      fresh Minecraft release is routinely an ALPHA one, which Paper explicitly
 *      says not to serve to users.
 *   3. The download carries its own absolute `url` (on a content-addressed host)
 *      and its digest under `checksums.sha256`, instead of a `name` the caller
 *      had to splice into a download path.
 */
interface PaperBuild {
  id?: number;
  channel?: string;
  downloads?: Record<string, { name?: string; url?: string; checksums?: { sha256?: string } }>;
}

/** The download key Fill uses for the server jar. `server:default` is the plain
 *  one; other keys exist for mojmap and similar variants we do not want. */
const PAPER_SERVER_DOWNLOAD = 'server:default';

async function paperCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const body = (await ctx.fetchJson(PAPER_PROJECT, { ttlMs: 6 * HOUR })) as PaperProject;
  const groups = body?.versions && typeof body.versions === 'object' ? Object.values(body.versions) : [];

  const versions: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    // Release candidates and pre-releases are excluded, not merely sorted last:
    // Fill lists `1.21.11-rc3` next to `1.21.11`, and compareVersionsDesc reads
    // both as [1, 21, 11] — so leaving them in makes which one the UI defaults to
    // a coin toss decided by document order.
    for (const v of group) if (typeof v === 'string' && isReleaseVersion(v)) versions.push(v);
  }

  return versions
    .sort(compareVersionsDesc)
    .map((v) => ({
      id: `paper:${v}`,
      label: `Paper ${v}`,
      flavour: 'paper',
      version: v,
      runtime: { id: 'java', major: javaMajorFor(v) },
      stable: true,
    }));
}

async function resolvePaper(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  const buildsUrl = `${PAPER_PROJECT}/versions/${encodeURIComponent(ref.version)}/builds`;
  const body = (await ctx.fetchJson(buildsUrl, { ttlMs: HOUR })) as PaperBuild[];
  const builds = Array.isArray(body) ? body : [];

  // Sorted by build id rather than taken positionally. Fill happens to return
  // newest-first today, but "which build is newest" is a fact about the ids, and
  // depending on a response's order is exactly how the v2 parser broke.
  const stable = builds
    .filter((b) => b?.channel === 'STABLE' && Number.isInteger(b.id))
    .sort((a, b) => (b.id as number) - (a.id as number));

  const build = stable.find((b) => {
    const dl = b.downloads?.[PAPER_SERVER_DOWNLOAD];
    return typeof dl?.url === 'string' && typeof dl.checksums?.sha256 === 'string';
  });

  if (!build) {
    // A brand-new Minecraft release genuinely has only experimental builds for a
    // few days, and that is a sentence the user can act on ("pick the previous
    // version") rather than a parse failure.
    throw new Error(`Paper has no stable build for ${ref.version} yet`);
  }

  const dl = build.downloads?.[PAPER_SERVER_DOWNLOAD] as { url: string; checksums: { sha256: string } };
  return {
    ...ref,
    label: `Paper ${ref.version} (build ${build.id})`,
    meta: {
      jarUrl: dl.url,
      jarSha256: normaliseDigest(dl.checksums.sha256, 64, `Paper build ${build.id}`),
      launchJar: 'server.jar',
      build: build.id as number,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Forge
// ─────────────────────────────────────────────────────────────────────────────

interface ForgePromotions { promos?: Record<string, string> }

/**
 * Forge's own promotion file, which is the ONLY sane way to list it.
 *
 * The obvious alternative — `maven-metadata.xml` — reports `<release>` as
 * whatever was published most recently, and Forge maintains several Minecraft
 * branches at once, so `<release>` is routinely an older Minecraft than the
 * newest entry in the list. promos is keyed `<mcver>-latest` / `<mcver>-recommended`
 * and is maintained by Forge for exactly this question.
 */
async function forgeCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const body = (await ctx.fetchJson(FORGE_PROMOTIONS, { ttlMs: 6 * HOUR })) as ForgePromotions;
  const promos = body?.promos && typeof body.promos === 'object' ? body.promos : {};

  // Collapse to one entry per Minecraft version, preferring 'recommended'.
  // Newer Minecraft branches often have only 'latest' for months, so treating a
  // missing 'recommended' as "no Forge here" would hide the versions people
  // actually want.
  const byMc = new Map<string, { forge: string; recommended: boolean }>();
  for (const [key, forge] of Object.entries(promos)) {
    if (typeof forge !== 'string') continue;
    const dash = key.lastIndexOf('-');
    if (dash <= 0) continue;
    const mc = key.slice(0, dash);
    const kind = key.slice(dash + 1);
    if (kind !== 'latest' && kind !== 'recommended') continue;
    const existing = byMc.get(mc);
    if (!existing || (kind === 'recommended' && !existing.recommended)) {
      byMc.set(mc, { forge, recommended: kind === 'recommended' });
    }
  }

  return [...byMc.entries()]
    .sort((a, b) => compareVersionsDesc(a[0], b[0]))
    .map(([mc, { forge, recommended }]) => ({
      id: `forge:${mc}-${forge}`,
      label: `Forge ${mc} — ${forge}`,
      flavour: 'forge',
      version: mc,
      runtime: { id: 'java', major: javaMajorFor(mc) },
      stable: recommended,
      meta: { loaderVersion: forge },
    }));
}

/**
 * Where a Forge/NeoForge install puts the thing you actually launch.
 *
 * Both installers stopped producing a runnable fat jar at Minecraft 1.17 and now
 * emit `run.sh` / `run.bat` wrapping a Java @argfile. We do not run their scripts
 * — a shell script is exactly the "arbitrary command" the trust model withholds —
 * so we launch the argfile ourselves, which is all those scripts do:
 *
 *     java @user_jvm_args.txt @libraries/<group>/<ver>/unix_args.txt nogui
 *
 * The path is deterministic from the version, which is what keeps planLaunch pure:
 * no directory listing, no post-install detection, just the coordinate the
 * installer is contractually going to write to.
 */
function argfileFor(group: 'net/minecraftforge/forge' | 'net/neoforged/neoforge', coord: string): string {
  // unix_args.txt and win_args.txt are byte-identical for both projects; the
  // split exists for path separators in classpaths, which @argfile handles. We
  // take the unix one on every platform so the plan is platform-independent.
  return `libraries/${group}/${coord}/unix_args.txt`;
}

async function resolveForge(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  const loader = typeof ref.meta?.loaderVersion === 'string' ? ref.meta.loaderVersion : null;
  if (!loader) throw new Error(`Forge entry ${ref.id} carries no loader version`);
  const coord = `${ref.version}-${loader}`;
  const installerUrl = `${FORGE_MAVEN}/${coord}/forge-${coord}-installer.jar`;
  const sha256 = await ctx.fetchText(mavenDigestUrl(installerUrl, 'sha256'), { ttlMs: MONTH });

  const legacy = isLegacyForge(ref.version);
  return {
    ...ref,
    meta: {
      installerUrl,
      installerSha256: normaliseDigest(sha256, 64, `Forge ${coord}`),
      installerName: `forge-${coord}-installer.jar`,
      // Legacy leaves forge-<coord>.jar runnable; modern leaves an argfile.
      ...(legacy ? { launchJar: `forge-${coord}.jar` } : { argfile: argfileFor('net/minecraftforge/forge', coord) }),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NeoForge
// ─────────────────────────────────────────────────────────────────────────────

interface NeoForgeVersions { versions?: string[] }

async function neoforgeCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const body = (await ctx.fetchJson(NEOFORGE_VERSIONS, { ttlMs: 6 * HOUR })) as NeoForgeVersions;
  const all = Array.isArray(body?.versions) ? body.versions.filter((v) => typeof v === 'string') : [];

  // Betas are excluded, not merely deprioritised. NeoForge's maven-metadata even
  // reports one as `<release>`, so trusting upstream's own idea of "current"
  // would offer a prerelease as the default choice for a new server.
  const stable = all.filter(isReleaseVersion);

  // One entry per Minecraft version: the newest NeoForge build for it. Offering
  // 1640 builds would be a dropdown nobody can use.
  const best = new Map<string, string>();
  for (const v of stable) {
    const mc = neoforgeMinecraftVersion(v);
    if (!mc) continue;
    const prev = best.get(mc);
    if (!prev || compareVersionsDesc(v, prev) < 0) best.set(mc, v);
  }

  return [...best.entries()]
    .sort((a, b) => compareVersionsDesc(a[0], b[0]))
    .map(([mc, neo]) => ({
      id: `neoforge:${neo}`,
      label: `NeoForge ${neo} (Minecraft ${mc})`,
      flavour: 'neoforge',
      version: mc,
      runtime: { id: 'java', major: javaMajorFor(mc) },
      stable: true,
      meta: { loaderVersion: neo },
    }));
}

async function resolveNeoForge(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  const neo = typeof ref.meta?.loaderVersion === 'string' ? ref.meta.loaderVersion : null;
  if (!neo) throw new Error(`NeoForge entry ${ref.id} carries no loader version`);
  const installerUrl = `${NEOFORGE_MAVEN}/${neo}/neoforge-${neo}-installer.jar`;
  const sha256 = await ctx.fetchText(mavenDigestUrl(installerUrl, 'sha256'), { ttlMs: MONTH });

  return {
    ...ref,
    meta: {
      installerUrl,
      installerSha256: normaliseDigest(sha256, 64, `NeoForge ${neo}`),
      installerName: `neoforge-${neo}-installer.jar`,
      argfile: argfileFor('net/neoforged/neoforge', neo),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fabric
// ─────────────────────────────────────────────────────────────────────────────

interface FabricEntry { version?: string; stable?: boolean; url?: string; maven?: string }

/**
 * Fabric is listed by GAME version, one entry per Minecraft release, pinned to
 * the newest stable loader. The loader is not a user-facing choice: Fabric's
 * loader is game-version-independent and "which of 251 loader builds" is not a
 * question a person setting up a server for friends should be asked.
 */
async function fabricCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const [loaders, installers, vanilla] = await Promise.all([
    ctx.fetchJson(FABRIC_LOADER, { ttlMs: 6 * HOUR }) as Promise<FabricEntry[]>,
    ctx.fetchJson(FABRIC_INSTALLER, { ttlMs: 6 * HOUR }) as Promise<FabricEntry[]>,
    vanillaCatalog(ctx),
  ]);

  const loader = Array.isArray(loaders) ? loaders.find((l) => l?.stable && typeof l.version === 'string') : null;
  const installer = Array.isArray(installers) ? installers.find((i) => i?.stable && typeof i.url === 'string') : null;
  if (!loader?.version || !installer?.url || !installer.version) {
    throw new Error('Fabric published no stable loader/installer pair');
  }

  // Intersected with the vanilla release list rather than taken from Fabric's own
  // /versions/game, which includes every snapshot back to 1.14.
  return vanilla.map((v) => ({
    id: `fabric:${v.version}`,
    label: `Fabric ${v.version} (loader ${loader.version})`,
    flavour: 'fabric',
    version: v.version,
    runtime: v.runtime,
    stable: true,
    meta: {
      loaderVersion: loader.version,
      installerVersion: installer.version,
      installerUrl: installer.url,
    },
  }));
}

async function resolveFabric(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  const installerUrl = typeof ref.meta?.installerUrl === 'string' ? ref.meta.installerUrl : null;
  const loaderVersion = typeof ref.meta?.loaderVersion === 'string' ? ref.meta.loaderVersion : null;
  if (!installerUrl || !loaderVersion) throw new Error(`Fabric entry ${ref.id} is incomplete`);

  // sha512, because that is what Fabric's maven publishes alongside the installer.
  // The tempting URL — meta's /server/jar, which hands you a ready launcher —
  // has no digest and no ETag, so it is exactly the download this feature refuses
  // to make.
  const sha512 = await ctx.fetchText(mavenDigestUrl(installerUrl, 'sha512'), { ttlMs: MONTH });

  return {
    ...ref,
    meta: {
      ...ref.meta,
      installerSha512: normaliseDigest(sha512, 128, `Fabric installer ${ref.meta?.installerVersion}`),
      installerName: 'fabric-installer.jar',
      launchJar: 'fabric-server-launch.jar',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Maven `.sha256` file is a bare hex digest, but "bare" is the happy path: some
 * mirrors append the filename, and a truncated response from a flaky CDN is a
 * shorter string that would otherwise be handed to the verifier as if it were a
 * digest. Anything that is not exactly the right number of hex characters is
 * rejected HERE, where the error can name the artifact.
 */
function normaliseDigest(raw: string, hexLength: number, what: string): string {
  const hex = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (hex.length !== hexLength || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error(`${what} published an unusable checksum`);
  }
  return hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tag every entry with its family and keep the newest CATALOG_FAMILY_LIMIT of
 * them, dropping older families whole rather than truncating mid-family.
 *
 * Cutting by family instead of by count is what stops the list from ending
 * somewhere arbitrary like "1.20.6 … 1.19.3, and then nothing" — a boundary that
 * makes it look as though 1.19.2 does not exist, when in fact it was the 26th row.
 *
 * Input must already be sorted newest-first; each source does its own sorting
 * because each knows what it is sorting (a Minecraft version, a loader coordinate).
 */
function groupByFamily(refs: GameVersionRef[]): GameVersionRef[] {
  const tagged = refs.map((r) => ({ ...r, family: versionFamily(r.version) }));
  const families: string[] = [];
  for (const r of tagged) if (!families.includes(r.family)) families.push(r.family);
  const keep = new Set(families.slice(0, CATALOG_FAMILY_LIMIT));
  return tagged.filter((r) => keep.has(r.family));
}

/**
 * The combined catalog. A failing upstream degrades to whatever the others
 * returned instead of emptying the list — Paper being down is no reason to be
 * unable to install vanilla, and a five-way join that fails whole would be down
 * five times as often as any one of its parts.
 */
export async function minecraftCatalog(ctx: CatalogCtx): Promise<GameVersionRef[]> {
  const sources: [string, Promise<GameVersionRef[]>][] = [
    ['Paper', paperCatalog(ctx)],
    ['Fabric', fabricCatalog(ctx)],
    ['NeoForge', neoforgeCatalog(ctx)],
    ['Forge', forgeCatalog(ctx)],
    ['Mojang', vanillaCatalog(ctx)],
  ];
  const settled = await Promise.allSettled(sources.map(([, p]) => p));

  const out: GameVersionRef[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    // Per-flavour, so one flavour with a long history cannot crowd another out of
    // the shared budget.
    if (result.status === 'fulfilled') out.push(...groupByFamily(result.value));
    else ctx.log(`${sources[i][0]} catalog unavailable: ${String(result.reason)}`);
  }
  if (out.length === 0) throw new Error('no Minecraft versions could be listed (every upstream unreachable)');
  return out;
}

export async function resolveMinecraftRef(ref: GameVersionRef, ctx: CatalogCtx): Promise<GameVersionRef> {
  switch (ref.flavour) {
    case 'paper': return resolvePaper(ref, ctx);
    case 'vanilla': return resolveVanilla(ref, ctx);
    case 'forge': return resolveForge(ref, ctx);
    case 'neoforge': return resolveNeoForge(ref, ctx);
    case 'fabric': return resolveFabric(ref, ctx);
    // 'imported' is resolved at import time from the files themselves; there is
    // nothing to fetch and nothing to re-resolve.
    case 'imported': return ref;
    default: throw new Error(`unsupported Minecraft flavour: ${ref.flavour}`);
  }
}
