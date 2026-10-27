import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import bencode from 'bencode';
import type { CreateTorrentRequest } from '../../shared/types';
import { createTorrentFile, cancelTorrentCreation } from './creator';
import { TORRENT_CREATION_CANCELLED } from '../../shared/torrent-creation';
import { nativeSeedRoot, parseSeedMetadata, prepareSeed, persistSeedMetadata, resolveSeedFilePaths } from './seed-metadata';
import { SeedStore } from './seed-store';

vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'havvn-creator-')); });
afterEach(() => {
  const absolute = path.resolve(root);
  expect(path.dirname(absolute)).toBe(fs.realpathSync(os.tmpdir()));
  expect(path.basename(absolute)).toMatch(/^havvn-creator-/);
  fs.rmSync(absolute, { recursive: true, force: true });
});
function file(relative: string, bytes: Buffer | string = crypto.randomBytes(42001)) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target;
}
function request(sources: string[], extra: Partial<CreateTorrentRequest> = {}): CreateTorrentRequest {
  return { sourcePaths: sources, outputPath: path.join(root, 'result.torrent'), startSeeding: false,
    options: { name: 'custom-root', announceList: [], private: true, pieceLength: 16384 }, ...extra };
}
async function verifiedManifest(input: CreateTorrentRequest) {
  const progress: number[] = [];
  const result = await createTorrentFile(input, update => progress.push(update.progress));
  const bytes = fs.readFileSync(result.torrentFilePath), metadata = await parseSeedMetadata(bytes, result.infoHash);
  const paths = await resolveSeedFilePaths(input.sourcePaths, metadata.files);
  const content = Buffer.concat(paths.map(source => fs.readFileSync(source)));
  const decoded = bencode.decode(bytes) as any;
  expect(crypto.createHash('sha1').update(bencode.encode(decoded.info)).digest('hex')).toBe(result.infoHash);
  const hashes: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += result.pieceLength) hashes.push(crypto.createHash('sha1').update(content.subarray(offset, offset + result.pieceLength)).digest());
  expect(Buffer.from(decoded.info.pieces)).toEqual(Buffer.concat(hashes));
  expect(result.totalSize).toBe(content.length); expect(result.pieceCount).toBe(hashes.length);
  expect(progress.at(-1)).toBe(1); expect(progress.every((value, i) => !i || value >= progress[i - 1])).toBe(true);
  return { result, metadata, paths, decoded };
}

it('creates renamed single-file metadata with exact hashes, private/source and tracker tiers', async () => {
  const source = file('original.bin'), input = request([source]);
  input.options = { ...input.options, source: 'source-tag', comment: 'comment',
    announceList: [['http://127.0.0.1:1234/announce'], ['udp://127.0.0.1:1235']], urlList: ['https://example.invalid/content/'] };
  const { result, metadata, paths, decoded } = await verifiedManifest(input);
  expect(metadata.singleFile).toBe(true); expect(paths).toEqual([source]); expect(metadata.name).toBe('custom-root');
  expect(decoded.info.private).toBe(1); expect(String(decoded.info.source)).toBe('source-tag');
  expect(decoded['announce-list'].map((tier: Buffer[]) => tier.map(String))).toEqual(input.options.announceList);
  expect(decoded['url-list'].map(String)).toEqual(input.options.urlList);
  const saved = await persistSeedMetadata(metadata, path.join(root, 'profile'));
  fs.unlinkSync(result.torrentFilePath);
  expect((await prepareSeed(saved, [source], result.infoHash)).metadata.bytes).toEqual(metadata.bytes);
});

it('keeps a one-file directory as a directory torrent, including its nested path', async () => {
  const source = file('folder/nested/only.bin'), input = request([path.join(root, 'folder')]);
  const { metadata, paths } = await verifiedManifest(input);
  expect(metadata.singleFile).toBe(false); expect(metadata.files[0].path.replace(/\\/g, '/')).toBe('custom-root/nested/only.bin');
  expect(paths).toEqual([source]); expect(nativeSeedRoot(metadata, paths)).toBe(path.join(root, 'folder'));
});

it('hashes mixed scattered sources, hidden/empty files and excludes selected directories and its old output', async () => {
  file('left/tree/.hidden', 'hidden'); file('left/tree/empty', ''); file('left/tree/keep.bin');
  file('left/tree/excluded/omit', 'omit'); const other = file('right/another.bin');
  const source = path.join(root, 'left/tree'), output = file('left/tree/result.torrent', 'old output');
  const input = request([source, other], { outputPath: output, excludePaths: [path.join(source, 'excluded')] });
  const { metadata, paths, decoded } = await verifiedManifest(input);
  expect(metadata.files.map(entry => entry.path.replace(/\\/g, '/'))).toEqual([
    'custom-root/tree/.hidden', 'custom-root/tree/empty', 'custom-root/tree/keep.bin', 'custom-root/another.bin',
  ]);
  expect(decoded.announce).toBeUndefined(); expect(decoded['announce-list']).toBeUndefined();
  expect(() => nativeSeedRoot(metadata, paths)).toThrow(/classic engine/);
});

it('maps sibling files and directories onto one native physical root', async () => {
  const first = file('common/tree/nested/a'), second = file('common/other.bin');
  const { metadata, paths } = await verifiedManifest(request([path.dirname(path.dirname(first)), second]));
  expect(nativeSeedRoot(metadata, paths)).toBe(path.join(root, 'common'));
});

it('supports all-empty content without inventing a piece', async () => {
  const source = file('folder/empty', '');
  const { result } = await verifiedManifest(request([path.dirname(source)]));
  expect(result.totalSize).toBe(0); expect(result.pieceCount).toBe(0);
});

it('rejects sources changed during hashing and leaves an existing output intact', async () => {
  const source = file('source.bin', crypto.randomBytes(1024 * 1024)), output = file('result.torrent', 'previous torrent');
  let changed = false;
  await expect(createTorrentFile(request([source]), update => {
    if (update.stage === 'hashing' && update.progress > 0 && !changed) { changed = true; fs.appendFileSync(source, 'changed'); }
  })).rejects.toThrow(/changed/);
  expect(changed).toBe(true); expect(fs.readFileSync(output, 'utf8')).toBe('previous torrent');
  expect(fs.readdirSync(root).some(name => name.startsWith('.havvn-torrent-'))).toBe(false);
});

it('cleans an unsuccessful atomic write and releases the creation lock', async () => {
  const source = file('source'); fs.mkdirSync(path.join(root, 'output-directory'));
  file('output-directory/keep', 'untouched');
  await expect(createTorrentFile(request([source], { outputPath: path.join(root, 'output-directory') }))).rejects.toThrow();
  expect(fs.readFileSync(path.join(root, 'output-directory/keep'), 'utf8')).toBe('untouched');
  expect(fs.readdirSync(root).some(name => name.startsWith('.havvn-torrent-'))).toBe(false);
  await verifiedManifest(request([source]));
});

it('rejects ambiguous sources, overlaps, output-over-source and invalid URLs before replacing output', async () => {
  const a = file('one/same.bin'), b = file('two/same.bin');
  await expect(createTorrentFile(request([a, b]))).rejects.toThrow(/same torrent root name/);
  await expect(createTorrentFile(request([path.join(root, 'one'), a]))).rejects.toThrow(/selected more than once/);
  await expect(createTorrentFile(request([a], { outputPath: a }))).rejects.toThrow(/overwrite/);
  const input = request([a]); input.options.announceList = [['file:///bad']];
  await expect(createTorrentFile(input)).rejects.toThrow(/URL/);
});

it('rejects a modified metadata hash and raw traversal hidden by path normalization', async () => {
  const { metadata, decoded } = await verifiedManifest(request([file('folder/a')]));
  await expect(parseSeedMetadata(metadata.bytes, '0'.repeat(40))).rejects.toThrow(/changed/);
  delete decoded.info.length; decoded.info.files = [{ length: metadata.length, path: ['sub', '..', 'a'] }];
  await expect(parseSeedMetadata(Buffer.from(bencode.encode(decoded)))).rejects.toThrow(/path/i);
});

const read = (store: SeedStore, index: number, range: { offset?: number; length?: number } | null = null) => new Promise<Buffer>((resolve, reject) => store.get(index, range, (error, data) => error ? reject(error) : resolve(Buffer.from(data!))));
it('reads pieces across file boundaries and empty files, rejects writes and never deletes sources', async () => {
  const sources = [file('a', 'abc'), file('empty', ''), file('b', 'defghij')];
  const store = new SeedStore(4, { files: sources.map(source => ({ path: source, length: fs.statSync(source).size })) });
  expect((await read(store, 0)).toString()).toBe('abcd'); expect((await read(store, 1)).toString()).toBe('efgh');
  expect((await read(store, 2)).toString()).toBe('ij'); expect((await read(store, 0, { offset: 2, length: 2 })).toString()).toBe('cd');
  await expect(new Promise((resolve, reject) => store.put(0, Buffer.from('xxxx'), error => error ? reject(error) : resolve(null)))).rejects.toThrow(/read-only/);
  await new Promise<void>(resolve => store.destroy(() => resolve()));
  await expect(read(store, 0)).rejects.toThrow(/closed/);
  expect(sources.map(source => fs.readFileSync(source, 'utf8'))).toEqual(['abc', '', 'defghij']);
});

it('refuses to read modified seed content instead of returning unverified bytes', async () => {
  const source = file('a', 'original');
  const store = new SeedStore(4, { files: [{ path: source, length: 8 }] });
  fs.writeFileSync(source, 'modified'); fs.utimesSync(source, new Date(), new Date(Date.now() + 2000));
  await expect(read(store, 0)).rejects.toThrow(/changed/);
  store.close();
});

it.each(['scan', 'hash', 'write'] as const)('cancels during %s, preserves source/output and can restart immediately', async phase => {
  const source = file('source.bin', crypto.randomBytes(2 * 1024 * 1024));
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const output = file('result.torrent', 'previous torrent');
  let cancelled = false;
  const updates: string[] = [];
  await expect(createTorrentFile(request([source], { requestId: 'cancel-me' }), update => {
    expect(update.requestId).toBe('cancel-me');
    updates.push(update.stage);
    const atPoint = phase === 'scan' ? update.stage === 'hashing' && update.progress === 0
      : phase === 'hash' ? update.stage === 'hashing' && update.progress > 0 : update.stage === 'writing';
    if (atPoint && !cancelled) {
      expect(cancelTorrentCreation('another-request')).toBe(false);
      cancelled = cancelTorrentCreation('cancel-me');
    }
  })).rejects.toThrow(TORRENT_CREATION_CANCELLED);
  expect(cancelled).toBe(true); expect(updates).not.toContain('complete');
  expect(fs.readFileSync(output, 'utf8')).toBe('previous torrent');
  expect(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')).toBe(sourceHash);
  expect(fs.readdirSync(root).some(name => name.startsWith('.havvn-torrent-'))).toBe(false);
  expect(cancelTorrentCreation('cancel-me')).toBe(false);
  await verifiedManifest(request([source]));
});

it('does not accept late cancellation after the output has been committed', async () => {
  const source = file('source.bin');
  const result = await createTorrentFile(request([source], { requestId: 'finished' }), update => {
    if (update.stage === 'complete') expect(cancelTorrentCreation('finished')).toBe(false);
  });
  await parseSeedMetadata(fs.readFileSync(result.torrentFilePath), result.infoHash);
});
