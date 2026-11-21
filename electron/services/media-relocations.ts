import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyMediaKind } from '../../shared/media';
import { mediaPath } from '../torrent/verified-media';
import type { MediaRelocationTarget, MediaRelocationPreview, MediaRelocationView } from '../../shared/media-relocation';
export interface MediaRelocationRecord { target: MediaRelocationTarget; disk: string; stamp: string }
const validTarget = (raw: MediaRelocationTarget) => !!raw && [raw.identity, raw.downloadId, raw.title].every(s => typeof s === 'string' && s.length > 0 && s.length <= 4096) && !!mediaPath(raw.path) && Number.isSafeInteger(raw.fileIndex) && raw.fileIndex >= 0 && raw.fileIndex < 1_000_000 && Number.isSafeInteger(raw.length) && raw.length >= 0 && classifyMediaKind(raw.path) !== 'other';
function stamp(disk: string): string {
  const stat = fs.lstatSync(disk);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Media relocation file unavailable');
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.birthtimeMs]);
}
/** Playback-only bindings. They never change torrent destinations, selection or state. */
export class MediaRelocations {
  private previews = new Map<string, { preview: MediaRelocationPreview; record: MediaRelocationRecord }>();
  constructor(private read: () => MediaRelocationRecord[], private write: (items: MediaRelocationRecord[]) => void, private now = Date.now) {}
  private records() { const rows = this.read(); return (Array.isArray(rows) ? rows : []).filter(row => row && validTarget(row.target) && typeof row.disk === 'string' && path.isAbsolute(row.disk) && typeof row.stamp === 'string').slice(-500); }
  list(): MediaRelocationView[] { return this.records().map(row => ({ target: row.target, available: this.current(row) })); }
  available(id: string, identity?: string) { return this.records().filter(row => row.target.downloadId === id && (!identity || row.target.identity === identity) && this.current(row)); }
  find(id: string, file: number | string, identity?: string) { return this.available(id, identity).find(row => typeof file === 'number' ? row.target.fileIndex === file : row.target.path === file); }
  private current(row: MediaRelocationRecord) { try { return stamp(row.disk) === row.stamp; } catch { return false; } }
  preview(target: MediaRelocationTarget, chosen: string): MediaRelocationPreview {
    if (!validTarget(target)) throw Error('Invalid media relocation target');
    const disk = fs.realpathSync(chosen), signature = stamp(disk), stat = fs.statSync(disk), kind = classifyMediaKind(disk);
    if (kind === 'other' || stat.size === 0) throw Error('Media relocation format mismatch');
    const preview: MediaRelocationPreview = { token: crypto.randomUUID(), target: { ...target, path: mediaPath(target.path)! }, candidatePath: disk, candidateBytes: stat.size,
      sizeMatches: target.length === 0 || stat.size === target.length, formatMatches: kind === classifyMediaKind(target.path), expiresAt: this.now() + 120000 };
    for (const [key, row] of this.previews) if (row.preview.expiresAt <= this.now()) this.previews.delete(key);
    if (this.previews.size >= 8) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.token, { preview, record: { target: { ...preview.target, length: stat.size }, disk, stamp: signature } });
    return structuredClone(preview);
  }
  confirm(token: string): MediaRelocationView {
    const row = this.previews.get(token); this.previews.delete(token);
    if (!row || row.preview.expiresAt <= this.now() || !this.current(row.record)) throw Error('Media relocation preview expired or file changed');
    if (!row.preview.sizeMatches || !row.preview.formatMatches) throw Error('Media relocation does not match');
    const old = this.records(), target = row.record.target;
    // An original file index can represent only one path within a download.
    if (old.some(r => r.target.downloadId === target.downloadId && r.target.fileIndex === target.fileIndex && r.target.path !== target.path)) throw Error('Media relocation index conflict');
    const next = old.filter(r => r.target.identity !== target.identity || r.target.path !== target.path);
    this.write([...next, row.record].slice(-500)); return { target, available: true };
  }
  cancel(token: string) { this.previews.delete(token); }
}
