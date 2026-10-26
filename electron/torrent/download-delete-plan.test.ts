import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Download, TorrentFile } from '../../shared/types';
import { downloadRemovalSignature, type DownloadRemovalSnapshot } from '../../shared/download-removal';
import { executeDownloadDeletion, prepareDownloadDeletion } from './download-delete-plan';
import { DownloadDeletionPreviews } from '../services/download-deletion-preview';
const roots: string[] = [];
async function directory() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'havvn-delete-plan-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('havvn-delete-plan-')) throw Error('Unexpected fixture path'); await fs.rm(root, { recursive: true, force: true }); } });
async function fixture(names = ['bundle/a.txt']) {
  const root = await directory();
  for (const name of names) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), 'fixture'); }
  const download = { id: 'test', name: 'bundle', status: 'paused', sourceType: 'torrent_file', sourceUri: 'PRIVATE_SOURCE', savePath: root, totalSize: 7, downloadedBytes: 7, progress: 1 } as Download;
  const snapshot: DownloadRemovalSnapshot = { download, signature: downloadRemovalSignature(download), metadata: Buffer.from('PRIVATE_METADATA').toString('base64'),
    files: names.map(name => ({ path: name, length: 7, downloaded: 7, priority: 'normal' as TorrentFile['priority'] })), existingFiles: names.map(name => ({ path: path.join(root, name), size: 7 })) };
  return { root, snapshot, file: (name = names[0]) => path.join(root, name) };
}
describe('reviewed torrent payload deletion', () => {
  it('deletes the exact manifest and leaves unlisted files and the destination intact', async () => {
    const f = await fixture(['bundle/a.txt', 'bundle/empty.txt']); await fs.writeFile(f.file('bundle/keep.txt'), 'unrelated');
    const plan = await prepareDownloadDeletion(f.snapshot); await executeDownloadDeletion(plan);
    expect(await fs.readFile(f.file('bundle/keep.txt'), 'utf8')).toBe('unrelated'); await expect(fs.stat(f.file())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(f.root)).isDirectory()).toBe(true);
  });
  it('checks all reviewed identities before deleting anything', async () => {
    const f = await fixture(['bundle/a.txt', 'bundle/b.txt']), plan = await prepareDownloadDeletion(f.snapshot);
    await fs.rename(f.file('bundle/b.txt'), f.file('bundle/old.txt')); await fs.writeFile(f.file('bundle/b.txt'), 'replacement');
    await expect(executeDownloadDeletion(plan)).rejects.toMatchObject({ reason: 'changed' }); expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture');
  });
  it('allows an active download to grow the same file', async () => {
    const f = await fixture(), plan = await prepareDownloadDeletion(f.snapshot); await fs.appendFile(f.file(), 'more');
    await executeDownloadDeletion(plan); await expect(fs.stat(f.file())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires another review if a previously absent torrent file appears', async () => {
    const f = await fixture(); f.snapshot.files.push({ path: 'bundle/new.txt', length: 1, downloaded: 0, priority: 'normal' });
    const plan = await prepareDownloadDeletion(f.snapshot); await fs.writeFile(f.file('bundle/new.txt'), 'new');
    await expect(executeDownloadDeletion(plan)).rejects.toMatchObject({ reason: 'changed' }); expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture');
  });
  it('rejects an ancestor junction swapped after review and keeps the outside file', async () => {
    const f = await fixture(), outside = await directory(); await fs.writeFile(path.join(outside, 'a.txt'), 'outside');
    const plan = await prepareDownloadDeletion(f.snapshot); await fs.rename(path.join(f.root, 'bundle'), path.join(f.root, 'saved'));
    await fs.symlink(outside, path.join(f.root, 'bundle'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(executeDownloadDeletion(plan)).rejects.toMatchObject({ reason: 'unsafe' }); expect(await fs.readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('outside');
  });
  it('rejects traversing metadata and expired plans', async () => {
    const f = await fixture(), plan = await prepareDownloadDeletion(f.snapshot); plan.expiresAt = Date.now() - 1;
    await expect(executeDownloadDeletion(plan)).rejects.toMatchObject({ reason: 'expired' });
    f.snapshot.files[0].path = '../outside.txt'; await expect(prepareDownloadDeletion(f.snapshot)).rejects.toMatchObject({ reason: 'unsafe' });
    expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture');
  });
  it('does not guess a payload path for an unresolved empty magnet', async () => {
    const f = await fixture(); f.snapshot.metadata = null; f.snapshot.files = []; f.snapshot.existingFiles = [];
    Object.assign(f.snapshot.download, { sourceType: 'magnet', totalSize: 0, downloadedBytes: 0, progress: 0 });
    await executeDownloadDeletion(await prepareDownloadDeletion(f.snapshot)); expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture');
    f.snapshot.download.downloadedBytes = 1; await expect(prepareDownloadDeletion(f.snapshot)).rejects.toMatchObject({ reason: 'metadata' });
  });
  it('keeps tokens single-use and exposes no source, metadata or signature in the preview', async () => {
    const f = await fixture(), previews = new DownloadDeletionPreviews(async () => f.snapshot), preview = await previews.preview('test');
    expect(preview.files).toHaveLength(1); expect(JSON.stringify(preview)).not.toContain('PRIVATE');
    expect(await previews.consume('test', preview.token)).toMatchObject({ downloadId: 'test' });
    await expect(previews.consume('test', preview.token)).rejects.toMatchObject({ reason: 'expired' });
    expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture'); previews.clear();
  });
  it('invalidates pending previews when their owner is disposed', async () => {
    const f = await fixture(); let finish!: (snapshot: DownloadRemovalSnapshot) => void;
    const previews = new DownloadDeletionPreviews(() => new Promise(resolve => { finish = resolve; }));
    const job = previews.preview('test'), rejected = expect(job).rejects.toMatchObject({ reason: 'expired' });
    expect(previews.preview('test')).toBe(job);
    previews.clear(); finish(f.snapshot); await rejected;
    expect(await fs.readFile(f.file(), 'utf8')).toBe('fixture');
  });
});
