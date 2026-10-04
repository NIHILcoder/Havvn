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
import { assertCopySpace, assertPlainPath, treeBytes } from './maintenance-files';

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
      parts.push(`${slot.id}\t${f.fileId}\t${f.infoHash}\t${f.size}\t${f.name}`);
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => exts.has(extOf(name)));
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.lstat(p); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
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

  const manifest = computeContentManifest(opts.slots, opts.bindings, opts.roomFiles);
  const pending: PendingContentConsent[] = [];
  const plans: { slot: ContentSlot; dest: string; file: RoomContentFile; staged?: string; sha?: string }[] = [];
  const stale: string[] = [];
  let missing = false, bytes = 0;
  assertPlainPath(opts.instanceRoot, opts.instanceRoot);
  for (const slot of opts.slots) {
    if (!Object.prototype.hasOwnProperty.call(opts.bindings, slot.id)) continue;
    const destDir = resolveUnder(opts.instanceRoot, slot.into as RelPath);
    assertPlainPath(opts.instanceRoot, destDir);
    const sources = filesInFolder(opts.roomFiles, opts.bindings[slot.id] ?? '').filter(f => matchesSlot(f, slot));
    const names = new Set<string>();
    for (const file of sources) {
      const name = path.basename(file.name);
      // Case-fold on every platform: room manifests can come from a Unix peer.
      if (name !== file.name || names.has(name.toLowerCase()) || /[:<>"|?*]/.test(name)) throw new Error('ambiguous content filename: ' + file.name);
      names.add(name.toLowerCase());
      const dest = path.join(destDir, name);
      assertPlainPath(opts.instanceRoot, dest);
      plans.push({ slot, dest, file });
      if (!file.localPath || !(await exists(file.localPath))) missing = true;
      else bytes += await treeBytes(file.localPath);
    }
    for (const name of await listSlotFiles(destDir, slot.extensions)) {
      const dest = path.join(destDir, name);
      assertPlainPath(opts.instanceRoot, dest);
      if (!names.has(name.toLowerCase())) stale.push(dest);
    }
  }
  if (missing) return { state: 'missing', copied: 0, removed: 0, pending, manifest };
  assertCopySpace(opts.instanceRoot, bytes);
  ensureDir(opts.instanceRoot);
  const stage = await fsp.mkdtemp(path.join(opts.instanceRoot, '.content-'));
  const changes: { dest: string; previous: string; hadFile: boolean; published: boolean }[] = [];
  let copied = 0, removed = 0, preserveStage = false;
  try {
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      plan.staged = path.join(stage, 'new-' + i);
      await fsp.copyFile(plan.file.localPath!, plan.staged);
      // Consent is bound to the bytes that will actually be installed. Hashing
      // the source first allowed it to change between the check and copy.
      plan.sha = await sha256File(plan.staged);
      if (plan.slot.executable && !opts.hasConsent(plan.sha)) pending.push({ sha256: plan.sha, name: plan.file.name, slotId: plan.slot.id });
    }
    if (pending.length) return { state: 'conflict', copied: 0, removed: 0, pending, manifest };
    const publish = async (dest: string, replacement?: string) => {
      const previous = path.join(stage, 'old-' + changes.length);
      const hadFile = await exists(dest);
      const record = { dest, previous, hadFile, published: false };
      await fsp.writeFile(path.join(stage, 'recovery.json'), JSON.stringify({ kind: 'content', files: [...changes, record].map(item => ({
        destination: path.relative(opts.instanceRoot, item.dest), previous: path.basename(item.previous), hadFile: item.hadFile,
      })) }));
      if (hadFile) await fsp.rename(dest, previous);
      changes.push(record);
      if (replacement) { ensureDir(path.dirname(dest)); await fsp.rename(replacement, dest); record.published = true; }
    };
    for (const plan of plans) {
      if (!(await exists(plan.dest)) || await sha256File(plan.dest) !== plan.sha) {
        await publish(plan.dest, plan.staged); copied++;
      }
    }
    for (const dest of stale) { await publish(dest); removed++; }
    return { state: 'ok', copied, removed, pending, manifest };
  } catch (error) {
    try {
      for (const record of changes.reverse()) {
        if (record.published) await fsp.unlink(record.dest);
        if (record.hadFile) await fsp.rename(record.previous, record.dest);
      }
    } catch (rollback) {
      preserveStage = true;
      throw new Error('Content rollback failed; previous files retained at ' + stage + ': ' + String(rollback));
    }
    throw error;
  } finally {
    if (!preserveStage) await fsp.rm(stage, { recursive: true, force: true });
  }
}
