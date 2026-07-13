/**
 * Room folders — pure convergence + grouping logic for the optional
 * folder/section overlay on a room's flat file manifest.
 *
 * No Node/Electron imports, so the room engine (hidden-window preload) and the
 * renderer both use it, and vitest runs it directly. Convergence is
 * last-writer-wins by an explicit `at` clock, mirroring the file tombstone
 * model in room-engine.ts (applyTombstone) — a room with no folders behaves
 * exactly as before, and a peer that strips the new fields degrades to the flat
 * list rather than breaking.
 */

import type { RoomFile, RoomFolder } from './types';

/**
 * Canonical folder icon names (a subset of the renderer's Icon set). The engine
 * validates a peer-supplied icon against this list so an unknown/hostile name
 * can never reach <Icon> — the renderer imports the same list for its picker.
 */
export const FOLDER_ICONS = ['folder', 'film', 'music', 'image', 'file-text', 'download', 'archive', 'star'] as const;
const FOLDER_ICON_SET: ReadonlySet<string> = new Set(FOLDER_ICONS);
export function sanitizeFolderIcon(icon: unknown): string {
  return typeof icon === 'string' && FOLDER_ICON_SET.has(icon) ? icon : 'folder';
}

/**
 * Apply an incoming folder create/edit with last-writer-wins by `at`, honoring a
 * later tombstone. Mutates `folders`/`tombs` in place; returns true if anything
 * changed (so the caller can decide whether to push/persist).
 */
export function mergeFolderUpsert(
  folders: Map<string, RoomFolder>,
  tombs: Map<string, number>,
  incoming: RoomFolder,
): boolean {
  if (!incoming || !incoming.id || !Number.isFinite(incoming.at)) return false;
  const deletedAt = tombs.get(incoming.id) ?? 0;
  if (deletedAt >= incoming.at) return false;      // deleted at/after this edit — stays gone
  const cur = folders.get(incoming.id);
  if (cur && cur.at >= incoming.at) return false;  // we already hold a newer/equal edit
  // Only mutate once we've decided to apply — clearing the tombstone above and
  // THEN bailing would desync the in-memory map from the persisted one.
  if (deletedAt) tombs.delete(incoming.id);        // re-created after a deletion — revive
  folders.set(incoming.id, { ...incoming });
  return true;
}

/**
 * Tombstone a folder with last-writer-wins by `at`. Files that pointed at it are
 * left untouched — their now-dangling folderId resolves to Uncategorized via
 * groupFilesByFolder, so no per-file reassignment gossip is needed. A folder
 * edited AFTER this delete (cur.at > at) survives (the edit wins). Mutates in
 * place; returns true if anything changed.
 */
export function applyFolderDelete(
  folders: Map<string, RoomFolder>,
  tombs: Map<string, number>,
  id: string,
  at: number,
): boolean {
  if (!id || !Number.isFinite(at)) return false;
  const prevTomb = tombs.get(id) ?? 0;
  const nextTomb = Math.max(prevTomb, at);
  const cur = folders.get(id);
  const removes = !!cur && cur.at <= at;
  if (nextTomb === prevTomb && !removes) return false;
  tombs.set(id, nextTomb);
  if (removes) folders.delete(id);
  return true;
}

/**
 * Assign a file to a folder (or clear it) with last-writer-wins by `folderAt`.
 * `folderId` null / '' / undefined all mean Uncategorized. Mutates `file`;
 * returns true if the assignment advanced (a newer one already won → false).
 */
export function applyAssignment(
  file: RoomFile,
  folderId: string | null | undefined,
  at: number,
): boolean {
  if (!file || !Number.isFinite(at) || at <= (file.folderAt ?? 0)) return false;
  file.folderId = folderId || undefined;
  file.folderAt = at;
  return true;
}

export interface FolderGroup {
  folder: RoomFolder | null;   // null = the Uncategorized bucket
  files: RoomFile[];
}

/**
 * Group files under the given folders (folder order preserved) with an
 * Uncategorized bucket LAST for files whose folderId is empty or resolves to no
 * live folder. Pure — the renderer maps the result into sections. Folders with
 * no files are still returned (empty sections stay visible so pre-created
 * structure doesn't vanish).
 */
export function groupFilesByFolder(files: RoomFile[], folders: RoomFolder[]): FolderGroup[] {
  const buckets = new Map<string, RoomFile[]>();
  for (const f of folders) buckets.set(f.id, []);
  const uncategorized: RoomFile[] = [];
  for (const file of files) {
    const fid = file.folderId;
    const bucket = fid ? buckets.get(fid) : undefined;
    if (bucket) bucket.push(file);
    else uncategorized.push(file);
  }
  const out: FolderGroup[] = folders.map((f) => ({ folder: f, files: buckets.get(f.id) as RoomFile[] }));
  if (uncategorized.length) out.push({ folder: null, files: uncategorized });
  return out;
}
