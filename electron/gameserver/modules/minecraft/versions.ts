/**
 * Minecraft version arithmetic, shared by the catalog (which builds refs from
 * upstream listings) and the import scanner (which reconstructs the same facts
 * from file names). Both need to answer "which Java" and "which Minecraft", and
 * two copies of that answer would drift the first time a versioning scheme moved.
 *
 * Pure string maths — no network, no fs — so the rules below are unit-tested
 * directly rather than inferred from a successful install.
 */

/**
 * Which Java a given Minecraft version needs.
 *
 * CALENDAR VERSIONS: Minecraft left `1.x.y` behind in 2026 and now ships `26.1`,
 * `26.2`, … A leading component other than 1 is therefore a YEAR, not some wildly
 * future semver release, and those need Java 25. Reading `26.2` as "not 1.x, so
 * assume the newest thing I knew about" is how this silently hands a Java 21
 * runtime to a server needing 25 — an UnsupportedClassVersionError at launch,
 * which is a poor way to learn about a versioning change.
 *
 * Vanilla never reaches this: Mojang states the requirement per version and the
 * catalog uses it. This is for the flavours whose APIs do not say.
 */
export function javaMajorFor(mcVersion: string): number {
  const [major = 0, minor = 0, patch = 0] = mcVersion.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  // Calendar-versioned (2026 onward). Java 25 is the floor for the whole scheme
  // so far; a later bump lands here as a new branch, not as a wrong guess.
  if (major >= 26) return 25;
  if (major !== 1) return 21;
  if (minor >= 21) return 21;
  if (minor === 20) return patch >= 5 ? 21 : 17;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

/**
 * The family a version belongs to, as the UI groups them: '1.21.4' → '1.21',
 * '26.1.2' → '26.1', '26.2' → '26.2'.
 *
 * Matches how Paper's own API groups its versions and how players talk about them
 * ("a 1.20 server"), which is what makes a two-step picker feel like the natural
 * shape rather than an extra click.
 */
export function versionFamily(version: string): string {
  const parts = version.split('.');
  if (parts.length <= 1) return version;
  // Semver-era Minecraft puts the interesting number second (1.21.4 → 1.21);
  // calendar versions put it there too (26.1.2 → 26.1). Same slice either way.
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Is this a finished release, as opposed to a candidate/prerelease/snapshot?
 *
 * The test is "no hyphen", which covers every scheme the upstreams actually use:
 * `1.21.11-rc3`, `1.21.11-pre5`, `26.2-rc-2` (Paper), `26.2.0.45-beta` (NeoForge).
 * Released versions never carry one, in either the semver or the calendar scheme.
 *
 * This has to be an EXPLICIT filter rather than a sort preference, because
 * compareVersionsDesc reads `1.21.11-rc3` and `1.21.11` as the same version —
 * Number.parseInt('11-rc3') is 11 — so a candidate left in the list can win the
 * "newest stable" slot by nothing more than document order.
 */
export function isReleaseVersion(version: string): boolean {
  return version.length > 0 && !version.includes('-');
}

/**
 * Newest first, comparing component by component.
 *
 * Works across the calver boundary by arithmetic rather than by a special case:
 * `26.2` beats `1.21.11` because 26 > 1. What it must NOT be replaced with is the
 * publish order the upstreams return, which puts a `1.21.11` release after a
 * `26.2` one on both the Forge and NeoForge listings.
 */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * NeoForge's version numbers ENCODE the Minecraft version rather than naming it:
 * Minecraft 1.21.1 is NeoForge 21.1.x, and calendar-versioned Minecraft 26.1.2 is
 * NeoForge 26.1.2.x. No endpoint states the mapping, so it is reconstructed here
 * — and it is the only reason a NeoForge entry can name its Minecraft version,
 * which the UI needs in order to state the Java requirement.
 *
 * Returns '' for anything that does not parse, so a malformed upstream entry is
 * skipped rather than becoming an entry claiming Minecraft "1.NaN".
 */
export function neoforgeMinecraftVersion(neo: string): string {
  const parts = neo.split('.');
  if (parts.length < 3) return '';
  const lead = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(lead)) return '';
  // Calver: the first THREE components are the Minecraft version, the fourth is
  // NeoForge's own build (26.1.2.93 → Minecraft 26.1.2, 26.2.0.41 → 26.2).
  if (lead >= 26) {
    return parts[2] === '0' ? `${parts[0]}.${parts[1]}` : `${parts[0]}.${parts[1]}.${parts[2]}`;
  }
  // Semver era: 21.1.209 → Minecraft 1.21.1, and 21.0.x → Minecraft 1.21.
  return parts[1] === '0' ? `1.${parts[0]}` : `1.${parts[0]}.${parts[1]}`;
}

/**
 * Legacy Forge (Minecraft 1.16.5 and older) has no run scripts and no argfile —
 * its installer leaves a runnable jar in the server root instead. 1.17 is where
 * Forge moved to the @argfile launch, and the split is permanent: those old
 * branches are frozen.
 */
export function isLegacyForge(mcVersion: string): boolean {
  const [major = 0, minor = 0] = mcVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  if (major !== 1) return false; // calver is far past the cutover
  return minor < 17;
}
