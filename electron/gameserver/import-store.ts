/**
 * "Bring your own server files" — staging, unpacking and identifying a jar or a
 * server pack the USER supplies, so a modpack from CurseForge, a world from a
 * friend, or a loader version this build's catalog does not list can still run in
 * a room.
 *
 * ─ WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────
 * The catalog can only ever offer what its five upstreams publish. Everything
 * people actually run — a curated modpack, a server pack a community ships as one
 * zip, an old Forge build pinned by a mod that was never updated — lives outside
 * that. Refusing those would make the feature a demo.
 *
 * ─ WHAT IT DOES *NOT* RELAX ─────────────────────────────────────────────────
 * The trust model is unchanged, and the distinction is worth stating precisely
 * because "let the user pick a file" sounds like a hole:
 *
 *   • These bytes are ALREADY the user's. They chose them in the OS file dialog,
 *     on their own machine, and could have run them by double-clicking. Havvn is
 *     not granting access to anything that was not already there.
 *   • It is still not an ARBITRARY EXECUTABLE. The tree is scanned by the module,
 *     which nominates .jar files and Java @argfiles only, and the launch still
 *     goes through a MANAGED, hash-verified JRE. No `run.bat` is ever executed,
 *     no path outside the instance is ever named.
 *   • Nothing here is SHAREABLE. An imported instance's launch facts are local
 *     state; they are not a preset, so they cannot travel to another member and
 *     become someone else's launch plan. That is the tier-B boundary and this
 *     stays on the near side of it.
 *
 * ─ WHY STAGING RATHER THAN STRAIGHT INTO THE INSTANCE ───────────────────────
 * The user has to see what was found before committing. Creating the instance
 * first would mean a dead instance every time the scan comes back empty, and
 * "delete the thing that was just made for you" is a worse dialog than "we did
 * not recognise this". Staging lives beside the instances so the commit is a
 * rename rather than a multi-gigabyte copy.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { logger } from '../utils';
import {
  ensureDir, importStagingDir, importStagingRoot, listTree, purgeImportStaging,
} from './paths';
import type { ImportCandidate, ImportScanResult, RelPath } from '../../shared/gameserver-types';

const log = logger.child('GameImport');

/** What a user may hand us. A bare jar is the single-file case; everything else
 *  arrives as an archive. */
export const IMPORT_EXTENSIONS = ['jar', 'zip'] as const;

/** Ceiling on a staged import. Large enough for any real server pack (the
 *  biggest modpacks land around 2 GB installed) and small enough that a
 *  mis-selected disk image fails fast instead of filling the drive. */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024;

export class ImportError extends Error {
  constructor(readonly reason: ImportFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ImportError';
  }
}

/** Tagged so the renderer can print a translated sentence instead of relaying an
 *  English exception message into a Russian UI. */
export type ImportFailure =
  | 'unsupported-file'
  | 'too-large'
  | 'extract-failed'
  | 'empty-archive'
  | 'nothing-recognised';

/**
 * Unpack `sourcePath` into a fresh staging directory and ask the module what it
 * sees. Nothing is committed: the caller either creates an instance from the
 * result or discards it.
 */
export async function stageImport(
  sourcePath: string,
  scan: (files: readonly RelPath[]) => ImportCandidate[],
): Promise<ImportScanResult> {
  const ext = path.extname(sourcePath).slice(1).toLowerCase();
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ImportError('unsupported-file', ext || path.basename(sourcePath));
  }

  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new ImportError('unsupported-file', 'not a file');
  if (stat.size > MAX_IMPORT_BYTES) throw new ImportError('too-large', String(stat.size));

  const stagingId = crypto.randomUUID().replace(/-/g, '');
  const dir = importStagingDir(stagingId);
  ensureDir(dir);

  try {
    if (ext === 'jar') {
      // A bare jar is not unpacked — it IS the server. Copied under its own name
      // so the scanner sees what the user actually chose, which is also what the
      // launch plan will reference.
      fs.copyFileSync(sourcePath, path.join(dir, path.basename(sourcePath)));
    } else {
      await extractZip(sourcePath, dir);
      flattenSingleRoot(dir);
    }

    const { files, bytes, truncated } = listTree(dir);
    if (files.length === 0) throw new ImportError('empty-archive');
    if (truncated) log.warn('import listing truncated', { stagingId, files: files.length });

    const candidates = scan(files);
    log.info('import staged', { stagingId, files: files.length, bytes, candidates: candidates.length });
    return { stagingId, candidates, fileCount: files.length, bytes };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Move a staged tree into an instance root, then forget the staging directory.
 *
 * Rename first, copy only if that fails. Rename is instant and atomic within a
 * filesystem, which is the case we engineered for by staging beside the
 * instances — but a userData on a junction or a network path can still cross a
 * device, and losing a 2 GB import to EXDEV would be a poor trade for the
 * simplicity of not writing the fallback.
 */
export function commitImport(stagingId: string, instanceRoot: string): void {
  const dir = importStagingDir(stagingId);
  if (!fs.existsSync(dir)) throw new ImportError('empty-archive', 'staging expired');

  ensureDir(path.dirname(instanceRoot));
  fs.rmSync(instanceRoot, { recursive: true, force: true });
  try {
    fs.renameSync(dir, instanceRoot);
  } catch {
    fs.cpSync(dir, instanceRoot, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  log.info('import committed', { stagingId, instanceRoot });
}

/** Throw away a staged import the user backed out of. */
export function discardImport(stagingId: string): void {
  fs.rmSync(importStagingDir(stagingId), { recursive: true, force: true });
}

/** Clear every staged import. Called at startup and shutdown — staging is only
 *  meaningful within one dialog, so anything surviving a restart is crash debris. */
export function purgeStaging(): void {
  try {
    purgeImportStaging();
  } catch (err) {
    log.warn('could not purge import staging', { err: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/** Extract with PowerShell (Windows) / unzip, matching the installer and
 *  runtime-store — no archive dependency ships in the production bundle. */
function extractZip(archive: string, into: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const psq = (s: string): string => s.replace(/'/g, "''");
    const child = process.platform === 'win32'
      ? spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path '${psq(archive)}' -DestinationPath '${psq(into)}' -Force`],
      { windowsHide: true })
      : spawn('unzip', ['-q', '-o', archive, '-d', into]);

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { stderr += c; });
    child.on('error', (err) => reject(new ImportError('extract-failed', err.message)));
    child.on('exit', (code) => (code === 0
      ? resolve()
      : reject(new ImportError('extract-failed', stderr.trim().slice(0, 200) || `exit ${code}`))));
  });
}

/**
 * Hoist the contents of a lone top-level directory up one level.
 *
 * Server packs are distributed both ways — some zip the server folder, some zip
 * its contents — and the difference is invisible until the server fails to start
 * because `server.jar` is one directory deeper than anything looks for it.
 * Normalising here means the scanner and every launch plan see one shape.
 *
 * Only when the directory is ALONE: a tree with `mods/`, `config/` and
 * `server.jar` at the root is already correct, and hoisting `mods/` out of it
 * would destroy the server rather than fix it.
 */
function flattenSingleRoot(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;

  const inner = path.join(dir, entries[0].name);
  // Two-step through a temp name: on a case-insensitive filesystem, renaming
  // `x/Server` to `x` collides with itself.
  const parked = `${dir}.flat-${process.pid}`;
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(inner, parked);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(parked, dir);
  log.info('flattened single-root archive', { hoisted: entries[0].name });
}

/** True when a staging id names a directory we actually created — the guard
 *  against a renderer handing back an id from a previous run. */
export function stagingExists(stagingId: string): boolean {
  try {
    return fs.existsSync(importStagingDir(stagingId));
  } catch {
    return false;
  }
}

/** Bytes currently held in staging, for the "you have an import in progress"
 *  accounting the manager logs at shutdown. */
export function stagingBytes(): number {
  try {
    return listTree(importStagingRoot()).bytes;
  } catch {
    return 0;
  }
}
