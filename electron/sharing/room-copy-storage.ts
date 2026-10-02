/** Delete individual managed copies only, with filesystem identity and ancestor checks. */
import fs from 'node:fs';
import path from 'node:path';
import { isManagedRoomPath, roomFileStamp } from './room-file-storage';

export interface RoomCopy { fileId: string; path: string; root: string; stamp: string; bytes: number; kind: 'plaintext' | 'ciphertext' }
export function managedCopy(root: string, fileId: string, candidate: string | undefined, kind: RoomCopy['kind']): RoomCopy | undefined {
  if (!candidate || !root) return;
  const absolute = path.resolve(candidate), base = path.resolve(root);
  const share = kind === 'ciphertext' && path.dirname(path.dirname(absolute)) === base && /^share-[a-zA-Z0-9]+$/.test(path.basename(path.dirname(absolute)));
  if (!share && !isManagedRoomPath(base, fileId, absolute)) return;
  // Junctions/symlinks in ANY ancestor, including the configured root, must not turn a local eviction into an external deletion.
  let parent = absolute;
  try {
    do {
      if (fs.lstatSync(parent).isSymbolicLink()) return;
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    } while (parent !== path.dirname(parent));
    if (fs.lstatSync(parent).isSymbolicLink()) return;
    const stamp = roomFileStamp(absolute), stat = fs.lstatSync(absolute);
    if (!stamp || !stat.isFile() || stat.nlink > 1) return;
    return { fileId, path: absolute, root: base, stamp, bytes: stat.size, kind };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export function deleteManagedCopy(copy: RoomCopy): number {
  const current = managedCopy(copy.root, copy.fileId, copy.path, copy.kind);
  if (!current || current.stamp !== copy.stamp) throw new Error('Local copy changed; refresh disk usage before cleaning');
  fs.unlinkSync(current.path); // never recursive; the validated file is the entire target
  try { fs.rmdirSync(path.dirname(current.path)); } catch { /* keep a non-empty slot */ }
  return current.bytes;
}

/** Read-only accounting includes abandoned slots; unknown copies are never cleanup targets. */
export async function roomTreeBytes(root: string): Promise<{ bytes: number; skipped: number }> {
  let parent = path.resolve(root);
  try {
    do {
      if ((await fs.promises.lstat(parent)).isSymbolicLink()) return { bytes: 0, skipped: 1 };
      const next = path.dirname(parent); if (next === parent) break; parent = next;
    } while (parent !== path.dirname(parent));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, skipped: 0 }; throw error; }
  const stack = [{ path: path.resolve(root), depth: 0 }]; let bytes = 0, skipped = 0, visited = 0;
  while (stack.length && visited < 100000) {
    const current = stack.pop()!; visited++;
    try {
      const stat = await fs.promises.lstat(current.path);
      if (stat.isSymbolicLink()) { skipped++; continue; }
      if (stat.isFile()) bytes += stat.size;
      else if (stat.isDirectory() && current.depth < 10) {
        const children = await fs.promises.readdir(current.path);
        if (children.length + stack.length + visited > 100000) { skipped++; continue; }
        for (const name of children) stack.push({ path: path.join(current.path, name), depth: current.depth + 1 });
      } else skipped++;
    } catch { skipped++; }
  }
  return { bytes, skipped: skipped + stack.length };
}
