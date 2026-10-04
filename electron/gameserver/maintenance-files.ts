import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { ServerActionError } from '../../shared/gameserver-errors';
import { freeBytes } from './host-resources';

/** Maintenance must not write through a user-created junction or symlink. */
export function assertPlainPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new ServerActionError('files-locked', 'path outside instance');
  }
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new ServerActionError('files-locked', 'linked maintenance path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Refuse unreadable or linked trees rather than recording an incomplete size. */
export async function treeBytes(root: string): Promise<number> {
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink()) throw new ServerActionError('files-locked', 'linked maintenance file');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new ServerActionError('files-locked', 'unsupported maintenance file');
  let bytes = 0;
  for (const name of await fsp.readdir(root)) bytes += await treeBytes(path.join(root, name));
  return bytes;
}

export function assertCopySpace(destination: string, bytes: number): void {
  const available = freeBytes(destination);
  if (available !== null && available < bytes + 16 * 1024 * 1024) {
    throw new ServerActionError('disk-space', `required=${bytes}, available=${available}`);
  }
}

/** A stable digest detects damaged or truncated backups before replacing a world. */
export async function treeFingerprint(root: string): Promise<string> {
  const digest = crypto.createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await fsp.readdir(dir)).sort()) {
      const abs = path.join(dir, name), stat = await fsp.lstat(abs);
      if (stat.isSymbolicLink()) throw new ServerActionError('files-locked', 'linked maintenance file');
      digest.update(JSON.stringify([path.relative(root, abs).split(path.sep).join('/'), stat.isDirectory() ? 'directory' : 'file']));
      if (stat.isDirectory()) await walk(abs);
      else {
        const hash = crypto.createHash('sha256'); await pipeline(fs.createReadStream(abs), hash);
        digest.update(hash.digest('hex'));
      }
    }
  };
  await walk(root); return digest.digest('hex');
}

/** A failed rollback or process termination leaves recovery material in root.
 * Refuse a fresh world/process until the host has recovered those files. */
export function hasInterruptedMaintenance(root: string): boolean {
  try { return fs.readdirSync(root).some(name => /^\.(restore|content)-/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
