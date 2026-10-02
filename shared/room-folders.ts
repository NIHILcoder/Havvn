import { ROOM_FOLDER_LIMIT, ROOM_FOLDER_TOMB_LIMIT } from './room-manifest-sync';
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
  if (!cur && folders.size >= ROOM_FOLDER_LIMIT) return false;
  if (cur && cur.at >= incoming.at) return false;  // we already hold a newer/equal edit
  // Only mutate once we've decided to apply — clearing the tombstone above and
  // THEN bailing would desync the in-memory map from the persisted one.
  if (deletedAt) tombs.delete(incoming.id);        // re-created after a deletion — revive
  // parentId semantics: an upsert WITHOUT the property comes from a client that
  // doesn't know about hierarchy (pre-2.23 rename/recolor) — preserve the
  // current membership instead of letting the whole-object LWW flatten the
  // tree. An upsert WITH the property is an explicit placement, and explicit
  // ROOT is stored as '' (NEVER undefined: JSON drops undefined-valued keys,
  // so an undefined-rooted record would degrade back to "unknown" on every
  // hello/disk round-trip and stale placements could no longer be corrected).
  const next: RoomFolder = { ...incoming };
  if (!Object.prototype.hasOwnProperty.call(incoming, 'parentId')) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, 'parentId')) next.parentId = cur.parentId;
  } else if (!incoming.parentId || incoming.parentId === incoming.id) {
    next.parentId = '';                            // '' → root; self-parent → root
  }
  folders.set(incoming.id, next);
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
  if (!tombs.has(id) && tombs.size >= ROOM_FOLDER_TOMB_LIMIT) return false;
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

/**
 * Should a file auto-download, honoring per-folder overrides on top of the
 * room-wide toggle? `folderFetch` maps folderId → forced on/off. Resolution is
 * most-specific-wins: the file's own folder's entry, else (via `parentOf`, one
 * hop) its parent section's entry, else `roomAutoFetch`. A single hop by
 * construction — no cycle can spin it. Pure — the engine gates every
 * ensureLocal through this, and it unit-tests without a room.
 */
export function wantAutoFetch(
  roomAutoFetch: boolean,
  folderFetch: Record<string, boolean> | undefined,
  folderId: string | null | undefined,
  parentOf?: (id: string) => string | null | undefined,
): boolean {
  if (folderId && folderFetch && Object.prototype.hasOwnProperty.call(folderFetch, folderId)) {
    return folderFetch[folderId] === true;
  }
  const parent = folderId && parentOf ? parentOf(folderId) : undefined;
  if (parent && parent !== folderId && folderFetch && Object.prototype.hasOwnProperty.call(folderFetch, parent)) {
    return folderFetch[parent] === true;
  }
  return roomAutoFetch;
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

export interface SectionGroup {
  /** The section (a top-level folder), or null for the root Uncategorized bucket (always LAST). */
  section: RoomFolder | null;
  /** Files assigned directly to the section itself. */
  files: RoomFile[];
  /** Nested folders (with their files), in the given folder-array order. */
  children: FolderGroup[];
}

/**
 * Resolve which folders render as top-level sections. A folder is a section
 * when its parentId is absent, dangling (no live folder), self-referential, or
 * points at a folder that is itself nested — one visual level only, and any
 * malformed/cyclic chain degrades to the root rather than breaking. Pure and
 * deterministic from the folder array alone.
 */
export function sectionIdOf(folder: RoomFolder, byId: Map<string, RoomFolder>): string | null {
  const pid = folder.parentId;
  if (!pid || pid === folder.id) return null;
  const parent = byId.get(pid);
  if (!parent) return null;                       // dangling → render at root
  const grand = parent.parentId;
  if (grand && grand !== pid && byId.has(grand)) return null; // parent is itself nested → flatten
  return pid;
}

/**
 * Two-level grouping: sections (top-level folders) each carry their own files
 * plus their nested folders' groups; the root Uncategorized bucket comes last.
 * Folder-array order is preserved at both levels (buildState pre-sorts by
 * name). Files whose folderId dangles fall into Uncategorized, exactly like
 * the flat grouping.
 */
export function groupFilesByHierarchy(files: RoomFile[], folders: RoomFolder[]): SectionGroup[] {
  const byId = new Map(folders.map((f) => [f.id, f] as const));
  const flat = groupFilesByFolder(files, folders);
  const groupOf = new Map<string, FolderGroup>();
  for (const g of flat) if (g.folder) groupOf.set(g.folder.id, g);

  const sections: SectionGroup[] = [];
  const bySection = new Map<string, SectionGroup>();
  for (const f of folders) {
    if (sectionIdOf(f, byId) !== null) continue;   // nested — attached below
    const sec: SectionGroup = { section: f, files: groupOf.get(f.id)?.files ?? [], children: [] };
    sections.push(sec);
    bySection.set(f.id, sec);
  }
  for (const f of folders) {
    const sid = sectionIdOf(f, byId);
    if (sid === null) continue;
    // sectionIdOf guarantees the parent resolves to a live top-level folder.
    bySection.get(sid)?.children.push(groupOf.get(f.id) as FolderGroup);
  }
  const uncat = flat.find((g) => !g.folder);
  if (uncat) sections.push({ section: null, files: uncat.files, children: [] });
  return sections;
}
