import fs from 'node:fs/promises';
import path from 'node:path';
import { USER_ERRORS } from '../../shared/user-errors';
import { DOWNLOAD_UNDO_MAX_FILES, DOWNLOAD_UNDO_METADATA_BYTES, type DownloadDeletionPlan, type DownloadRemovalSnapshot } from '../../shared/download-removal';

export class DeletionPreviewError extends Error {
  constructor(readonly reason: 'expired' | 'changed' | 'unsafe' | 'metadata' | 'busy') {
    super({ expired: USER_ERRORS.deletionExpired[1], changed: USER_ERRORS.deletionChanged[1], unsafe: USER_ERRORS.deletionUnsafe[1], metadata: USER_ERRORS.deletionMetadata[1], busy: USER_ERRORS.deletionBusy[1] }[reason]);
    this.name = 'DeletionPreviewError';
  }
}
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
async function lstat(file: string) { try { return await fs.lstat(file); } catch (error) { if (missing(error)) return null; throw error; } }

async function inspect(file: string, roots: DownloadDeletionPlan['roots']): Promise<DownloadDeletionPlan['files'][number] | null> {
  const root = roots.find(root => root.file ? key(file) === key(root.path) : inside(root.path, file));
  if (!root || !path.isAbsolute(file)) throw new DeletionPreviewError('unsafe');
  const rootStat = await lstat(root.path);
  if (!rootStat) return null;
  if (rootStat.isSymbolicLink() || (root.file ? !rootStat.isFile() : !rootStat.isDirectory())) throw new DeletionPreviewError('unsafe');
  if (!root.file) {
    const relative = path.relative(root.path, file);
    if (/[\0:]/.test(relative)) throw new DeletionPreviewError('unsafe');
    let parent = root.path;
    for (const part of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, part); const stat = await lstat(parent);
      if (!stat) return null;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DeletionPreviewError('unsafe');
    }
  }
  const stat = await lstat(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || key(await fs.realpath(file)) !== key(file)) throw new DeletionPreviewError('unsafe');
  return { path: file, size: stat.size, dev: stat.dev, ino: stat.ino, birth: stat.birthtimeMs };
}

/** Manifest only. No recursive scan, no guessed directory based on a display name. */
export async function prepareDownloadDeletion(snapshot: DownloadRemovalSnapshot, now = Date.now()): Promise<DownloadDeletionPlan> {
  const d = snapshot.download;
  if (!snapshot.metadata && (d.totalSize > 0 || d.downloadedBytes > 0 || d.progress > 0 || d.seedPaths?.length)) throw new DeletionPreviewError('metadata');
  if (snapshot.files.length > DOWNLOAD_UNDO_MAX_FILES || (snapshot.metadata?.length ?? 0) > Math.ceil(DOWNLOAD_UNDO_METADATA_BYTES / 3) * 4) throw new DeletionPreviewError('metadata');
  const plan: DownloadDeletionPlan = { schema: 1, downloadId: d.id, signature: snapshot.signature, expiresAt: now + 120_000, metadata: snapshot.metadata, roots: [], files: [], absent: [] };
  if (!snapshot.files.length) return plan;
  for (const source of d.seedPaths?.length ? d.seedPaths : [d.savePath]) {
    let canonical: string;
    try { canonical = await fs.realpath(source); } catch (error) { if (!missing(error) || d.seedPaths?.length) throw error; canonical = path.resolve(source); }
    const stat = await lstat(canonical);
    if (stat?.isSymbolicLink() || stat && !stat.isFile() && !stat.isDirectory()) throw new DeletionPreviewError('unsafe');
    plan.roots.push({ path: canonical, file: !!stat?.isFile() });
  }
  const candidates = d.seedPaths?.length ? snapshot.existingFiles.map(file => file.path)
    : snapshot.files.map(file => path.resolve(plan.roots[0].path, file.path));
  if (d.seedPaths?.length && candidates.length !== snapshot.files.length) throw new DeletionPreviewError('metadata');
  if (candidates.reduce((sum, file) => sum + file.length, 0) > 2 * 1024 * 1024 || new Set(candidates.map(key)).size !== candidates.length) throw new DeletionPreviewError('unsafe');
  for (const file of candidates) {
    const current = await inspect(file, plan.roots);
    if (current) plan.files.push(current); else plan.absent.push(file);
  }
  return plan;
}

export async function checkDownloadDeletion(plan: DownloadDeletionPlan): Promise<void> {
  if (plan.schema !== 1 || plan.files.length + plan.absent.length > DOWNLOAD_UNDO_MAX_FILES) throw new DeletionPreviewError('unsafe');
  if (Date.now() > plan.expiresAt) throw new DeletionPreviewError('expired');
  for (const file of plan.files) {
    const current = await inspect(file.path, plan.roots);
    // Downloading can grow a file; replacing it with a different inode cannot.
    if (!current || current.dev !== file.dev || current.ino !== file.ino || current.birth !== file.birth) throw new DeletionPreviewError('changed');
  }
  for (const file of plan.absent) if (await inspect(file, plan.roots)) throw new DeletionPreviewError('changed');
}

/** Called after the engine has closed payload handles. Leaves unrelated files alone. */
export async function executeDownloadDeletion(plan: DownloadDeletionPlan): Promise<void> {
  await checkDownloadDeletion(plan);
  const parents = new Set<string>();
  for (const file of plan.files) {
    const current = await inspect(file.path, plan.roots);
    if (!current || current.dev !== file.dev || current.ino !== file.ino || current.birth !== file.birth) throw new DeletionPreviewError('changed');
    await fs.unlink(file.path);
    const root = plan.roots.find(root => !root.file && inside(root.path, file.path));
    if (root) for (let parent = path.dirname(file.path); inside(root.path, parent); parent = path.dirname(parent)) parents.add(parent);
  }
  // Empty torrent directories only; never the chosen destination or a recursive rm.
  for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
    const stat = await lstat(parent);
    if (stat?.isDirectory() && !stat.isSymbolicLink() && key(await fs.realpath(parent)) === key(parent)) await fs.rmdir(parent).catch(() => {});
  }
}
