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
import crypto from 'crypto';
import fs from 'fs';
import { ServerActionError } from '../../shared/gameserver-errors';
import fsp from 'fs/promises';
import path from 'path';
import { ensureDir, instancePaths } from './paths';
import { assertCopySpace, assertPlainPath, treeBytes, treeFingerprint } from './maintenance-files';
import { parseProperties } from './modules/minecraft/properties';
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
  try { await fsp.lstat(p); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** The configured world and Paper's separate dimension directories. */
function worldPaths(instanceId: string): { root: string; names: string[] } {
  const { root } = instancePaths(instanceId);
  let name = 'world';
  try { name = parseProperties(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'))['level-name'] || name; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || /[:<>"|?*]/.test(name)) throw new Error('unsafe world name');
  const names = [name, name + '_nether', name + '_the_end'];
  for (const n of names) assertPlainPath(root, path.join(root, n));
  return { root, names };
}

/** Publish a backup only after every world and its metadata has been copied. */
export async function backupWorldDir(instanceId: string, tag: string, label?: string): Promise<string | null> {
  const { root, names } = worldPaths(instanceId);
  if (!(await exists(path.join(root, names[0])))) return null;
  const destination = resolveBackupDir(instanceId, tag);
  assertPlainPath(instancePaths(instanceId).base, destination);
  ensureDir(path.dirname(destination));
  if (await exists(destination)) throw new ServerActionError('files-busy', 'backup already exists');
  const selected: number[] = [];
  let bytes = 0;
  for (let i = 0; i < names.length; i++) {
    if (await exists(path.join(root, names[i]))) { selected.push(i); bytes += await treeBytes(path.join(root, names[i])); }
  }
  assertCopySpace(destination, bytes);
  const stage = await fsp.mkdtemp(path.join(path.dirname(destination), '.backup-'));
  try {
    for (const i of selected) await fsp.cp(path.join(root, names[i]), path.join(stage, ['world', 'world_nether', 'world_the_end'][i]), { recursive: true, errorOnExist: true, force: false });
    const digests: Record<string, string> = {};
    for (const i of selected) digests[String(i)] = await treeFingerprint(path.join(stage, ['world', 'world_nether', 'world_the_end'][i]));
    await fsp.writeFile(path.join(stage, 'meta.json'), JSON.stringify({ label: label || tag, createdAt: Date.now(), auto: tag.startsWith('pre-update-'), bytes, dimensions: selected, digests }));
    await fsp.rename(stage, destination);
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
  return path.join(destination, 'world');
}

/** ISO-ish tag safe for directory names. */
export function backupTagNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
}

function backupsRoot(instanceId: string): string {
  return path.join(instancePaths(instanceId).base, 'backups');
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
    bytes: bytes ?? await treeBytes(world),
    ...(auto ? { auto: true } : {}),
  };
}

/** List backups newest-first. */
export async function listWorldBackups(instanceId: string): Promise<WorldBackupEntry[]> {
  const root = backupsRoot(instanceId);
  if (!(await exists(root))) return [];
  const names = await fsp.readdir(root);
  const parsed = await Promise.all(
    names.filter(isValidBackupId).map((name) => parseBackupMeta(path.join(root, name), name).catch(() => null)),
  );
  return parsed.filter((e): e is WorldBackupEntry => e !== null).sort((a, b) => b.createdAt - a.createdAt);
}

/** Manual backup with optional label. Server must be stopped by the caller. */
export async function createWorldBackup(instanceId: string, label?: string): Promise<WorldBackupEntry> {
  const tag = backupTagNow();
  const cleanLabel = String(label || '').trim().slice(0, 80) || tag;
  const dest = await backupWorldDir(instanceId, tag, cleanLabel);
  if (!dest) throw new Error('no-world');
  return (await parseBackupMeta(path.dirname(dest), tag))!;
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
  const backup = resolveBackupDir(instanceId, backupId);
  assertPlainPath(instancePaths(instanceId).base, backup);
  if (!(await exists(path.join(backup, 'world')))) throw new Error('backup-not-found');
  const { root, names } = worldPaths(instanceId);
  const keys = ['world', 'world_nether', 'world_the_end'];
  const selected: number[] = [];
  let bytes = 0;
  for (let i = 0; i < keys.length; i++) {
    if (await exists(path.join(backup, keys[i]))) { selected.push(i); bytes += await treeBytes(path.join(backup, keys[i])); }
  }
  let managedDimensions = false;
  let digests: Record<string, string> | undefined;
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(backup, 'meta.json'), 'utf8')) as { dimensions?: number[]; digests?: Record<string, string> };
    if (meta.dimensions !== undefined) {
      if (JSON.stringify(meta.dimensions) !== JSON.stringify(selected)) throw new ServerActionError('backup-damaged');
      managedDimensions = true;
    }
    digests = meta.digests;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (digests) for (const i of selected) {
    if (digests[String(i)] !== await treeFingerprint(path.join(backup, keys[i]))) throw new ServerActionError('backup-damaged');
  }
  assertCopySpace(root, bytes);
  const stage = await fsp.mkdtemp(path.join(root, '.restore-'));
  const moved: { dest: string; aside: string; published: boolean; hadWorld: boolean }[] = [];
  let preserveStage = false;
  try {
    // All expensive / fallible copies happen while the original world is intact.
    for (const i of selected) {
      await fsp.cp(path.join(backup, keys[i]), path.join(stage, keys[i]), { recursive: true, force: false, errorOnExist: true });
      if (digests && digests[String(i)] !== await treeFingerprint(path.join(stage, keys[i]))) throw new ServerActionError('backup-damaged');
    }
    for (let i = 0; i < keys.length; i++) {
      // Older backups captured only world/. Never delete dimensions that an old
      // Havvn build did not know how to back up.
      if (!managedDimensions && !selected.includes(i)) continue;
      const dest = path.join(root, names[i]), aside = path.join(stage, 'previous-' + keys[i]);
      const hadWorld = await exists(dest);
      const record = { dest, aside, published: false, hadWorld };
      await fsp.writeFile(path.join(stage, 'recovery.json'), JSON.stringify({ kind: 'world', directories: [...moved, record].map(item => ({
        destination: path.basename(item.dest), previous: path.basename(item.aside), hadWorld: item.hadWorld,
      })) }));
      if (hadWorld) await fsp.rename(dest, aside);
      moved.push(record);
      if (selected.includes(i)) { await fsp.rename(path.join(stage, keys[i]), dest); record.published = true; }
    }
  } catch (error) {
    try {
      for (const record of moved.reverse()) {
        if (record.published) await fsp.rm(record.dest, { recursive: true, force: true });
        if (record.hadWorld) await fsp.rename(record.aside, record.dest);
      }
    } catch (rollback) {
      preserveStage = true;
      throw new ServerActionError('files-busy', 'Restore rollback failed; original world retained at ' + stage + ': ' + String(rollback));
    }
    throw error;
  } finally {
    if (!preserveStage) await fsp.rm(stage, { recursive: true, force: true });
  }
}

export async function deleteWorldBackup(instanceId: string, backupId: string): Promise<void> {
  const dir = resolveBackupDir(instanceId, backupId);
  assertPlainPath(instancePaths(instanceId).base, dir);
  if (!(await exists(dir))) throw new Error('backup-not-found');
  await fsp.rm(dir, { recursive: true, force: true });
}

export function backupsFolder(instanceId: string): string {
  const root = backupsRoot(instanceId);
  ensureDir(root);
  return root;
}
