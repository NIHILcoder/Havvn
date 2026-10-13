import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { instancePaths, ensureDir } from './paths';
import { assertCopySpace, assertPlainPath, treeBytes, treeFingerprint } from './maintenance-files';
import { backupTagNow, isValidBackupId } from './world-backup';
import { ServerActionError } from '../../shared/gameserver-errors';
import type { GameVersionRef, WorldBackupEntry } from '../../shared/gameserver-types';

export interface ServerSnapshotState {
  moduleId: string; ref: GameVersionRef; config: Record<string, string>; installed: boolean;
  useSystemJava: boolean; contentRev: number; contentManifest?: string;
}
interface SnapshotMeta {
  kind: 'server'; v: 1; id: string; label: string; createdAt: number; auto: boolean; bytes: number;
  treeDigest: string; stateDigest: string; state: ServerSnapshotState;
}
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
function directory(instanceId: string, id: string): string {
  if (!isValidBackupId(id)) throw new ServerActionError('backup-damaged');
  const base = instancePaths(instanceId).base, dir = path.resolve(base, 'backups', id);
  assertPlainPath(base, dir); return dir;
}
function validState(raw: unknown): raw is ServerSnapshotState {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as ServerSnapshotState, r = p.ref;
  return typeof p.moduleId === 'string' && /^[a-z0-9-]{1,64}$/.test(p.moduleId) && !!r && typeof r.id === 'string'
    && r.id.length <= 2048 && typeof r.label === 'string' && r.label.length <= 1024 && typeof r.flavour === 'string'
    && typeof r.version === 'string' && !!r.runtime && /^[a-z][a-z0-9-]{0,15}$/.test(r.runtime.id)
    && Number.isInteger(r.runtime.major) && r.runtime.major >= 1 && r.runtime.major <= 999
    && typeof p.installed === 'boolean' && typeof p.useSystemJava === 'boolean'
    && Number.isSafeInteger(p.contentRev) && p.contentRev >= 0 && !!p.config && typeof p.config === 'object' && !Array.isArray(p.config)
    && Object.entries(p.config).length <= 512 && Object.entries(p.config).every(([key, value]) => /^[A-Za-z0-9_.-]{1,64}$/.test(key) && typeof value === 'string' && value.length <= 2048);
}
async function metadata(instanceId: string, id: string): Promise<SnapshotMeta> {
  const dir = directory(instanceId, id), file = path.join(dir, 'meta.json');
  assertPlainPath(dir, file);
  if ((await fs.stat(file)).size > 1024 * 1024) throw new ServerActionError('backup-damaged');
  let p: SnapshotMeta;
  try { p = JSON.parse(await fs.readFile(file, 'utf8')) as SnapshotMeta; } catch { throw new ServerActionError('backup-damaged'); }
  if (!p || p.kind !== 'server' || p.v !== 1 || p.id !== id || !validState(p.state) || p.stateDigest !== digest(p.state)
    || typeof p.label !== 'string' || p.label.length > 80 || !Number.isFinite(p.createdAt) || p.createdAt < 0 || typeof p.auto !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(p.treeDigest) || !Number.isSafeInteger(p.bytes) || p.bytes < 0) throw new ServerActionError('backup-damaged');
  return p;
}
function view(meta: SnapshotMeta): WorldBackupEntry {
  return { id: meta.id, label: String(meta.label).slice(0, 80), createdAt: meta.createdAt, bytes: meta.bytes, auto: meta.auto, kind: 'server', version: meta.state.ref.label };
}
export async function createServerSnapshot(instanceId: string, state: ServerSnapshotState, label?: string, auto = false): Promise<WorldBackupEntry> {
  if (!validState(state)) throw new ServerActionError('backup-damaged');
  const paths = instancePaths(instanceId), id = 'full-' + backupTagNow() + '-' + crypto.randomBytes(3).toString('hex');
  const dir = directory(instanceId, id);
  assertPlainPath(paths.base, paths.root);
  const bytes = await treeBytes(paths.root);
  assertCopySpace(paths.base, bytes);
  ensureDir(path.dirname(dir));
  const stage = await fs.mkdtemp(path.join(path.dirname(dir), '.backup-full-'));
  try {
    await fs.cp(paths.root, path.join(stage, 'root'), { recursive: true, force: false, errorOnExist: true });
    const meta: SnapshotMeta = { kind: 'server', v: 1, id, label: (label || (auto ? 'pre-update-' : '') + state.ref.label).trim().slice(0, 80),
      createdAt: Date.now(), auto, bytes, treeDigest: await treeFingerprint(path.join(stage, 'root')), stateDigest: digest(state), state };
    await fs.writeFile(path.join(stage, 'meta.json'), JSON.stringify(meta));
    await fs.rename(stage, dir);
    return view(meta);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
export async function listServerSnapshots(instanceId: string): Promise<WorldBackupEntry[]> {
  const root = path.join(instancePaths(instanceId).base, 'backups');
  assertPlainPath(instancePaths(instanceId).base, root);
  if (!(await exists(root))) return [];
  const entries = await Promise.all((await fs.readdir(root)).filter(name => name.startsWith('full-') && isValidBackupId(name)).map(async id => {
    try { return view(await metadata(instanceId, id)); } catch { return null; }
  }));
  return entries.filter((p): p is WorldBackupEntry => p !== null);
}
export async function restoreServerSnapshot(instanceId: string, id: string, current: ServerSnapshotState,
  commit: (state: ServerSnapshotState) => void, rollbackCommit: () => void): Promise<void> {
  const paths = instancePaths(instanceId), dir = directory(instanceId, id), meta = await metadata(instanceId, id);
  if (meta.state.moduleId !== current.moduleId) throw new ServerActionError('backup-damaged');
  assertPlainPath(paths.base, paths.root);
  const source = path.join(dir, 'root');
  assertPlainPath(dir, source);
  if (await treeFingerprint(source) !== meta.treeDigest) throw new ServerActionError('backup-damaged');
  const bytes = await treeBytes(source);
  assertCopySpace(paths.base, bytes);
  // A sibling staging directory lets the entire working tree swap atomically.
  const stage = await fs.mkdtemp(path.join(paths.base, '.server-restore-'));
  let moved = false, published = false, retain = false;
  try {
    await fs.cp(source, path.join(stage, 'next'), { recursive: true, force: false, errorOnExist: true });
    if (await treeFingerprint(path.join(stage, 'next')) !== meta.treeDigest) throw new ServerActionError('backup-damaged');
    await fs.writeFile(path.join(stage, 'recovery.json'), JSON.stringify({ v: 1, backupId: id, previousState: current, restoredState: meta.state }));
    await fs.rename(paths.root, path.join(stage, 'previous')); moved = true;
    await fs.rename(path.join(stage, 'next'), paths.root); published = true;
    commit(meta.state);
  } catch (error) {
    try {
      if (published) await fs.rm(paths.root, { recursive: true, force: true });
      if (moved) await fs.rename(path.join(stage, 'previous'), paths.root);
      if (published) rollbackCommit();
    } catch (rollback) {
      retain = true;
      throw new ServerActionError('maintenance-recovery', 'Snapshot recovery retained at ' + stage + ': ' + String(rollback));
    }
    throw error;
  } finally {
    if (!retain) await fs.rm(stage, { recursive: true, force: true });
  }
}
