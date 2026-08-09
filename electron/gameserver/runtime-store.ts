/**
 * Managed runtimes (today: the JRE every Java-based game server needs).
 *
 * WHY WE INSTALL OUR OWN RATHER THAN USING THE SYSTEM JAVA
 * A system Java is whatever the user happens to have: wrong major version, a
 * 32-bit build that cannot address more than ~1.5 GB of heap, or a JRE that
 * disappears on the next update — each producing a different confusing failure
 * at server start. A managed runtime makes the install reproducible, makes
 * "which java" answerable, and has one more benefit that matters here: the
 * java.exe a firewall rule gets scoped to is then a path WE control, not one the
 * user picked, which is a strictly easier thing to justify to the elevated
 * helper. A detected system Java is still offered, but as an explicit opt-in.
 *
 * TRUST: Adoptium publishes a sha256 for every binary in its API response, so an
 * install is digest-verified — but the digest arrives over TLS from the vendor
 * rather than being pinned in this repo (pinning every future JRE is not
 * possible). That is the 'vendor' tier of HashRef and it is stated in the UI.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { logger } from '../utils';
import { downloadVerified, fetchJsonCached } from './fetcher';
import { ensureDir, runtimeDir } from './paths';
import type { HashRef, RuntimeRef } from '../../shared/gameserver-types';

const log = logger.child('GameRuntimes');

/** Written once an install completed, so a partial extraction is never mistaken
 *  for a usable runtime. */
const MARKER = 'havvn-runtime.json';

interface RuntimeMarker {
  id: string;
  major: number;
  release: string;
  /** Path to the executable, relative to the runtime directory. */
  exe: string;
  installedAt: number;
  source: string;
}

export interface RuntimeInfo {
  ref: RuntimeRef;
  exe: string;
  release: string;
  installedAt: number;
}

/** Adoptium's API. v3 is current — there is no v4 — and it still publishes a
 *  sha256 per binary, which is what makes the install verifiable. */
function adoptiumUrl(major: number): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot`
    + `?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
}

interface AdoptiumAsset {
  link: string;
  checksum: string;
  release: string;
}

/** The slice of Adoptium's `/assets/latest` entry we read. Everything is optional
 *  because this describes a REMOTE document: the shape is the vendor's to change,
 *  and the loop below is what turns it into something trustworthy. */
interface AdoptiumEntry {
  release_name?: unknown;
  binary?: { package?: { link?: unknown; checksum?: unknown } };
}

/** Pull the download link + sha256 for a JRE major out of the Adoptium API. */
async function resolveAdoptium(major: number): Promise<AdoptiumAsset> {
  const body = await fetchJsonCached(adoptiumUrl(major), 24 * 60 * 60_000);
  if (!Array.isArray(body) || body.length === 0) throw new Error(`Adoptium returned no JRE for Java ${major}`);
  for (const entry of body as AdoptiumEntry[]) {
    const pkg = entry?.binary?.package;
    const link = pkg?.link;
    const checksum = pkg?.checksum;
    const release = entry?.release_name;
    if (typeof link !== 'string' || typeof checksum !== 'string') continue;
    // Only the archive form: an .msi would need an installer run (and a UAC
    // prompt) for something that is supposed to be a self-contained directory.
    if (!/\.(zip|tar\.gz)$/i.test(link)) continue;
    return { link, checksum: checksum.toLowerCase(), release: typeof release === 'string' ? release : `java-${major}` };
  }
  throw new Error(`Adoptium returned no usable archive for Java ${major}`);
}

function markerPath(ref: RuntimeRef): string {
  return path.join(runtimeDir(ref), MARKER);
}

function readMarker(ref: RuntimeRef): RuntimeMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(ref), 'utf8')) as RuntimeMarker;
    if (!raw || typeof raw.exe !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Absolute path to the runtime's executable, or null when not installed.
 *  Re-checks that the file still exists: a user can delete userData contents. */
export function resolveRuntime(ref: RuntimeRef): string | null {
  const marker = readMarker(ref);
  if (!marker) return null;
  const exe = path.join(runtimeDir(ref), marker.exe);
  return fs.existsSync(exe) ? exe : null;
}

/**
 * Java majors this app can install, verified against Adoptium's own
 * `/v3/info/available_releases`. Only used to enumerate what is ALREADY on disk —
 * `ensureRuntime` takes whatever major a version ref asks for — but a major
 * missing from here is a runtime the user cannot see or reclaim disk from, which
 * is how Java 26 became invisible the moment it shipped.
 */
const KNOWN_JAVA_MAJORS = [8, 11, 16, 17, 21, 22, 23, 24, 25, 26] as const;

export function listRuntimes(): RuntimeInfo[] {
  const out: RuntimeInfo[] = [];
  for (const major of KNOWN_JAVA_MAJORS) {
    const ref: RuntimeRef = { id: 'java', major };
    const marker = readMarker(ref);
    if (!marker) continue;
    const exe = path.join(runtimeDir(ref), marker.exe);
    if (!fs.existsSync(exe)) continue;
    out.push({ ref, exe, release: marker.release, installedAt: marker.installedAt });
  }
  return out;
}

/**
 * Extract an archive. Uses PowerShell's Expand-Archive on Windows, the same
 * dependency-free approach scripts/fetch-wintun.mjs takes — a JRE is unpacked
 * once per major version, so its slowness costs nothing, and it saves shipping
 * a zip library in the production bundle.
 *
 * NOTE the quoting: PowerShell parses the -Command string itself, so a path
 * containing an apostrophe (a user named O'Brien) terminates the single-quoted
 * argument unless doubled. This is the same class of bug that silently broke the
 * elevated LAN helper for every profile name containing a space.
 */
function extractArchive(archive: string, into: string): void {
  ensureDir(into);
  if (process.platform === 'win32') {
    const psq = (s: string): string => s.replace(/'/g, "''");
    const res = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${psq(archive)}' -DestinationPath '${psq(into)}' -Force`],
      { windowsHide: true, timeout: 10 * 60_000 },
    );
    if (res.status !== 0) {
      throw new Error(`Expand-Archive failed (${res.status}): ${res.stderr?.toString().slice(0, 500) ?? ''}`);
    }
    return;
  }
  const res = spawnSync('tar', ['-xzf', archive, '-C', into], { timeout: 10 * 60_000 });
  if (res.status !== 0) throw new Error(`tar failed (${res.status})`);
}

/** Find bin/java(.exe) under an extracted tree (Adoptium nests it one level down
 *  in a release-named directory, whose exact name we do not want to hardcode). */
function findJavaExe(root: string): string | null {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const direct = path.join(root, 'bin', exeName);
  if (fs.existsSync(direct)) return direct;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const nested = path.join(root, e.name, 'bin', exeName);
    if (fs.existsSync(nested)) return nested;
    // macOS bundles put it under Contents/Home/bin.
    const mac = path.join(root, e.name, 'Contents', 'Home', 'bin', exeName);
    if (fs.existsSync(mac)) return mac;
  }
  return null;
}

export interface RuntimeInstallProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'done';
  pct: number;
}

/**
 * Make sure `ref` is installed, downloading it if necessary. Idempotent: an
 * already-installed runtime returns immediately.
 */
export async function ensureRuntime(
  ref: RuntimeRef,
  onProgress?: (p: RuntimeInstallProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (ref.id !== 'java') throw new Error(`unknown runtime family: ${ref.id}`);

  const existing = resolveRuntime(ref);
  if (existing) return existing;

  const dir = runtimeDir(ref);
  onProgress?.({ phase: 'resolving', pct: 0 });
  const asset = await resolveAdoptium(ref.major);

  const hash: HashRef = { algo: 'vendor', from: 'adoptium', digest: 'sha256', hex: asset.checksum };
  const archive = path.join(dir, path.basename(new URL(asset.link).pathname));

  log.info('installing runtime', { ref, release: asset.release });
  ensureDir(dir);

  await downloadVerified(asset.link, hash, archive, {
    ...(signal ? { signal } : {}),
    onProgress: (p) => {
      // Downloading is the long part; give it 0..90 and leave the tail for
      // extraction, which has no progress of its own.
      const pct = p.total ? Math.round((p.received / p.total) * 90) : 0;
      onProgress?.({ phase: 'downloading', pct });
    },
  });

  onProgress?.({ phase: 'extracting', pct: 90 });
  const staging = path.join(dir, 'unpack');
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    extractArchive(archive, staging);
    const exe = findJavaExe(staging);
    if (!exe) throw new Error('no java executable found in the extracted runtime');

    const marker: RuntimeMarker = {
      id: ref.id,
      major: ref.major,
      release: asset.release,
      exe: path.relative(dir, exe),
      installedAt: Date.now(),
      source: asset.link,
    };
    // The marker is written LAST: until it exists, resolveRuntime reports "not
    // installed", so an interrupted extraction re-runs cleanly instead of
    // presenting a half-unpacked directory as a working runtime.
    fs.writeFileSync(markerPath(ref), JSON.stringify(marker, null, 2));
    onProgress?.({ phase: 'done', pct: 100 });
    log.info('runtime installed', { ref, release: asset.release, exe: marker.exe });
    return exe;
  } finally {
    // The archive is ~50 MB of no further use once unpacked.
    fs.rmSync(archive, { force: true });
  }
}

export interface SystemJava {
  /** ABSOLUTE path, per the resolveRuntime contract — never a bare `java.exe`. */
  exe: string;
  /** The banner line, for display. */
  version: string;
  /** Feature release: 21, 17, 8… Parsed so a too-old Java is refused up front. */
  major: number;
}

/**
 * Parse `java.specification.version`, which is `21` on Java 9+ and `1.8` on 8.
 * Returns 0 when it cannot be read, which callers treat as "do not risk it".
 */
export function parseJavaMajor(properties: string): number {
  const spec = /java\.specification\.version\s*=\s*([\d.]+)/.exec(properties)?.[1];
  if (spec) {
    const legacy = /^1\.(\d+)/.exec(spec);           // 1.8 → 8
    const major = Number(legacy ? legacy[1] : spec.split('.')[0]);
    if (Number.isInteger(major) && major > 0) return major;
  }
  // Fall back to the banner: `openjdk version "21.0.1"` / `java version "1.8.0_402"`.
  const banner = /version\s+"(\d+)(?:\.(\d+))?/.exec(properties);
  if (banner) {
    const first = Number(banner[1]);
    if (first === 1 && banner[2]) return Number(banner[2]);
    if (Number.isInteger(first) && first > 0) return first;
  }
  return 0;
}

/** Detection is a blocking spawn, and the panel asks on every instance it shows.
 *  Re-probing PATH more than once every few minutes buys nothing. */
const SYSTEM_JAVA_TTL_MS = 5 * 60_000;
let systemJavaCache: { at: number; value: SystemJava | null } | null = null;

/** Drop the cached probe — for tests, and for anything that knows PATH moved. */
export function forgetSystemJava(): void {
  systemJavaCache = null;
}

/**
 * Best-effort detection of a system Java, offered as an explicit alternative to
 * a managed runtime. Returns null when nothing usable is on PATH.
 *
 * `-XshowSettings:properties` is what makes this answer the two questions that
 * matter, in one spawn: `java.home` gives the ABSOLUTE path (a bare `java.exe`
 * satisfied `spawn`, but left the firewall rule scoped to a name no file has,
 * and silently ignored which Java it actually was), and
 * `java.specification.version` gives the major, so a Java 8 on PATH is refused
 * before it produces an unreadable crash from a server that needed 21.
 */
export function detectSystemJava(): SystemJava | null {
  const now = Date.now();
  if (systemJavaCache && now - systemJavaCache.at < SYSTEM_JAVA_TTL_MS) return systemJavaCache.value;

  const value = probeSystemJava();
  systemJavaCache = { at: now, value };
  return value;
}

function probeSystemJava(): SystemJava | null {
  const exeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const probe = spawnSync(exeName, ['-XshowSettings:properties', '-version'], {
    windowsHide: true,
    timeout: 10_000,
  });
  if (probe.error || probe.status !== 0) return null;
  // Both the settings dump and the version banner go to stderr, which trips
  // people up often enough to note.
  const text = `${probe.stderr?.toString() ?? ''}${probe.stdout?.toString() ?? ''}`;
  const home = /java\.home\s*=\s*(.+)/.exec(text)?.[1]?.trim();
  if (!home) return null;

  const exe = path.join(home, 'bin', exeName);
  if (!fs.existsSync(exe)) return null;

  const major = parseJavaMajor(text);
  if (!major) return null;

  const version = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /version\s+"/.test(l)) ?? `Java ${major}`;

  return { exe, version, major };
}

/** Remove an installed runtime (used when the user reclaims disk space). */
export function removeRuntime(ref: RuntimeRef): void {
  fs.rmSync(runtimeDir(ref), { recursive: true, force: true });
}
