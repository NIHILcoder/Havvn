/**
 * Map room-shared files into a game-server instance's content slots (mods,
 * plugins, datapacks). Content rides the ordinary room manifest — this module
 * only resolves local paths, enforces per-hash consent for executable files,
 * and mirrors the bound folder into the instance root.
 */
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import { pipeline } from 'stream/promises';
import path from 'path';
import type { ContentSlot, ContentSyncState, RelPath } from '../../shared/gameserver-types';
import { resolveUnder, ensureDir } from './paths';

export interface RoomContentFile {
  fileId: string;
  name: string;
  folderId: string;
  infoHash: string;
  size: number;
  /** Absolute path when the file is on disk; absent while still downloading. */
  localPath?: string;
}

export interface PendingContentConsent {
  sha256: string;
  name: string;
  slotId: string;
}

export interface ContentSyncResult {
  state: ContentSyncState;
  copied: number;
  removed: number;
  pending: PendingContentConsent[];
  manifest: string;
}

function folderOfFile(file: RoomContentFile): string {
  return file.folderId || '';
}

export function filesInFolder(files: RoomContentFile[], folderId: string): RoomContentFile[] {
  const target = folderId || '';
  return files.filter((f) => folderOfFile(f) === target);
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function matchesSlot(file: RoomContentFile, slot: ContentSlot): boolean {
  const ext = extOf(file.name);
  return slot.extensions.some((e) => e.toLowerCase() === ext);
}

/**
 * Streamed, not `readFileSync`. A modpack is hundreds of jars and this runs over
 * both the source AND the destination of every one of them; slurping each into a
 * Buffer on the main thread stalled the whole app and spiked memory by the size
 * of the largest mod.
 */
export async function sha256File(abs: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(abs), hash);
  return hash.digest('hex');
}

/** Stable fingerprint of what the bound folders currently contain. */
export function computeContentManifest(
  slots: ContentSlot[],
  bindings: Readonly<Record<string, string>>,
  roomFiles: RoomContentFile[],
): string {
  const parts: string[] = [];
  for (const slot of slots) {
    if (!Object.prototype.hasOwnProperty.call(bindings, slot.id)) continue;
    const folderId = bindings[slot.id] ?? '';
    const matched = filesInFolder(roomFiles, folderId).filter((f) => matchesSlot(f, slot));
    matched.sort((a, b) => a.fileId.localeCompare(b.fileId));
    for (const f of matched) {
      parts.push(`${slot.id}\t${f.fileId}\t${f.infoHash}\t${f.size}`);
    }
  }
  const digest = crypto.createHash('sha256');
  digest.update(parts.join('\n'));
  return digest.digest('hex');
}

async function listSlotFiles(absDir: string, extensions: string[]): Promise<string[]> {
  const exts = new Set(extensions.map((e) => e.toLowerCase()));
  let names: string[];
  try {
    names = await fsp.readdir(absDir);
  } catch {
    return [];
  }
  return names.filter((name) => exts.has(extOf(name)));
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Mirror bound room folders into the instance. Refuses while `running` when
 * `requireStopped` is true. Executable slot files need a recorded consent hash.
 */
export async function syncContentSlots(opts: {
  instanceRoot: string;
  slots: ContentSlot[];
  bindings: Readonly<Record<string, string>>;
  roomFiles: RoomContentFile[];
  hasConsent: (sha256: string) => boolean;
  requireStopped?: boolean;
  isRunning?: boolean;
}): Promise<ContentSyncResult> {
  if (opts.requireStopped !== false && opts.isRunning) {
    throw new Error('stop-first');
  }

  const pending: PendingContentConsent[] = [];
  let copied = 0;
  let removed = 0;
  let missing = false;

  for (const slot of opts.slots) {
    if (!Object.prototype.hasOwnProperty.call(opts.bindings, slot.id)) continue;
    const folderId = opts.bindings[slot.id] ?? '';
    const destDir = resolveUnder(opts.instanceRoot, slot.into as RelPath);
    ensureDir(destDir);

    const sources = filesInFolder(opts.roomFiles, folderId).filter((f) => matchesSlot(f, slot));
    const wantedNames = new Set(sources.map((f) => path.basename(f.name)));

    for (const existing of await listSlotFiles(destDir, slot.extensions)) {
      if (!wantedNames.has(existing)) {
        try {
          await fsp.unlink(path.join(destDir, existing));
          removed += 1;
        } catch { /* raced */ }
      }
    }

    for (const file of sources) {
      if (!file.localPath || !(await exists(file.localPath))) {
        missing = true;
        continue;
      }
      const sha = await sha256File(file.localPath);
      if (slot.executable && !opts.hasConsent(sha)) {
        pending.push({ sha256: sha, name: file.name, slotId: slot.id });
        continue;
      }
      const dest = path.join(destDir, path.basename(file.name));
      try {
        const cur = (await exists(dest)) ? await sha256File(dest) : '';
        if (cur !== sha) {
          await fsp.copyFile(file.localPath, dest);
          copied += 1;
        }
      } catch {
        missing = true;
      }
    }
  }

  const manifest = computeContentManifest(opts.slots, opts.bindings, opts.roomFiles);
  let state: ContentSyncState = 'ok';
  if (pending.length > 0) state = 'conflict';
  else if (missing) state = 'missing';
  else {
    const bound = opts.slots.some((s) => Object.prototype.hasOwnProperty.call(opts.bindings, s.id));
    if (!bound) state = 'ok';
  }

  return { state, copied, removed, pending, manifest };
}
