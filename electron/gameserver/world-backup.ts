/**
 * Snapshot the Minecraft `world/` tree before a destructive operation (e.g.
 * applying a core update). Lives beside the instance, not inside `root/`, so
 * reinstall plans never touch it.
 *
 * Everything here is ASYNC on purpose. A world is routinely gigabytes, and the
 * synchronous forms of these calls run on the main thread — a `cpSync` of a
 * large world froze every room, the LAN session and the torrent engine for as
 * long as the copy took, and blocked the schedule ticker long enough to skip
 * the minute it was waiting for.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { ensureDir, instancePaths } from './paths';
import type { WorldBackupEntry } from '../../shared/gameserver-types';

/** What `backupTagNow` produces, plus room for a `pre-update-` prefix. */
const BACKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export function isValidBackupId(id: string): boolean {
  return BACKUP_ID_RE.test(id);
}

/**
 * Resolve `backups/<backupId>` for an instance, refusing anything that is not a
 * plain directory name. `instanceId` is already gated by `instancePaths`, but
 * `backupId` arrives from the renderer and lands in `rm -rf`-shaped calls: a
 * `..` segment would delete an arbitrary directory. The containment check after
 * the pattern is belt-and-braces — the pattern alone excludes separators.
 */
function resolveBackupDir(instanceId: string, backupId: string): string {
  if (!isValidBackupId(backupId)) throw new Error(`invalid backupId: ${String(backupId)}`);
  const root = backupsRoot(instanceId);
  const dir = path.resolve(root, backupId);
  if (!dir.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`backup path escapes its root: ${String(backupId)}`);
  }
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

/** Copy `world/` to `backups/<tag>/world`. Returns the backup path or null. */
export async function backupWorldDir(instanceId: string, tag: string): Promise<string | null> {
  const paths = instancePaths(instanceId);
  const world = path.join(paths.root, 'world');
  if (!(await exists(world))) return null;
  const dest = path.join(resolveBackupDir(instanceId, tag), 'world');
  ensureDir(path.dirname(dest));
  await fsp.cp(world, dest, { recursive: true, force: true });
  return dest;
}

/** ISO-ish tag safe for directory names. */
export function backupTagNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupsRoot(instanceId: string): string {
  return path.join(instancePaths(instanceId).base, 'backups');
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += (await fsp.stat(p)).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
}

async function parseBackupMeta(dir: string, id: string): Promise<WorldBackupEntry | null> {
  const world = path.join(dir, 'world');
  if (!(await exists(world))) return null;
  const metaPath = path.join(dir, 'meta.json');
  let label = id;
  let auto = id.startsWith('pre-update-');
  let createdAt = 0;
  let bytes: number | null = null;
  try {
    createdAt = (await fsp.stat(world)).mtimeMs;
  } catch { /* ignore */ }
  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw) as { label?: string; createdAt?: number; auto?: boolean; bytes?: number };
    if (meta.label) label = String(meta.label);
    if (Number.isFinite(meta.createdAt)) createdAt = Number(meta.createdAt);
    if (meta.auto === true) auto = true;
    // Size is recorded at creation so listing does not walk every backup tree.
    // Backups written by an older build have no `bytes` and are measured once,
    // here, which is the only path that still walks.
    if (Number.isFinite(meta.bytes)) bytes = Number(meta.bytes);
  } catch { /* no meta, or unreadable — fall back to measuring */ }
  return {
    id,
    createdAt,
    label,
    bytes: bytes ?? await dirSize(world),
    ...(auto ? { auto: true } : {}),
  };
}

/** List backups newest-first. */
export async function listWorldBackups(instanceId: string): Promise<WorldBackupEntry[]> {
  const root = backupsRoot(instanceId);
  if (!(await exists(root))) return [];
  const names = await fsp.readdir(root);
  const parsed = await Promise.all(
    names.map((name) => parseBackupMeta(path.join(root, name), name).catch(() => null)),
  );
  return parsed.filter((e): e is WorldBackupEntry => e !== null).sort((a, b) => b.createdAt - a.createdAt);
}

/** Manual backup with optional label. Server must be stopped by the caller. */
export async function createWorldBackup(instanceId: string, label?: string): Promise<WorldBackupEntry> {
  const tag = backupTagNow();
  const dest = await backupWorldDir(instanceId, tag);
  if (!dest) throw new Error('no-world');
  const dir = path.dirname(dest);
  const cleanLabel = String(label || '').trim().slice(0, 80) || tag;
  const createdAt = Date.now();
  const bytes = await dirSize(dest);
  await fsp.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ label: cleanLabel, createdAt, auto: false, bytes }),
    'utf8',
  );
  return { id: tag, createdAt, label: cleanLabel, bytes };
}

/**
 * Replace live `world/` with a backup copy. Caller must ensure server is stopped.
 *
 * The live world is moved ASIDE rather than deleted, and only removed once the
 * copy has fully landed. Deleting first meant a copy that failed halfway — a
 * full disk, a locked file, the app quitting — left the player with no world at
 * all and no way back; a restore must never be able to destroy more than it
 * replaces.
 */
export async function restoreWorldBackup(instanceId: string, backupId: string): Promise<void> {
  const paths = instancePaths(instanceId);
  const src = path.join(resolveBackupDir(instanceId, backupId), 'world');
  if (!(await exists(src))) throw new Error('backup-not-found');
  const dest = path.join(paths.root, 'world');
  const aside = path.join(paths.root, `world.restore-${Date.now()}`);

  const hadWorld = await exists(dest);
  if (hadWorld) await fsp.rename(dest, aside);
  try {
    await fsp.cp(src, dest, { recursive: true, force: true });
  } catch (err) {
    // Put the player's world back exactly where it was, then report the failure.
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => { /* best effort */ });
    if (hadWorld) await fsp.rename(aside, dest).catch(() => { /* nothing left to try */ });
    throw err;
  }
  if (hadWorld) await fsp.rm(aside, { recursive: true, force: true }).catch(() => { /* stale copy, harmless */ });
}

export async function deleteWorldBackup(instanceId: string, backupId: string): Promise<void> {
  const dir = resolveBackupDir(instanceId, backupId);
  if (!(await exists(dir))) throw new Error('backup-not-found');
  await fsp.rm(dir, { recursive: true, force: true });
}

export function backupsFolder(instanceId: string): string {
  const root = backupsRoot(instanceId);
  ensureDir(root);
  return root;
}
