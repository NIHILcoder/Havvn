import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Download } from '../../shared/types';
import { storageSources, type StorageSourcesOptions } from './storage-sources';
import { scanStorage } from './storage-overview';

const tempParent = fs.realpathSync.native(os.tmpdir());
let base: string;
const roomId = '11111111-1111-4111-8111-111111111111', rootId = '22222222-2222-4222-8222-222222222222';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
beforeEach(() => { base = fs.mkdtempSync(path.join(tempParent, 'havvn-storage-sources-')); });
afterEach(async () => {
  vi.restoreAllMocks(); const target = path.resolve(base);
  if (path.dirname(target) !== tempParent || !path.basename(target).startsWith('havvn-storage-sources-')) throw Error('Unexpected fixture directory');
  await fs.promises.rm(target, { recursive: true, force: true });
});
function put(relative: string, bytes: string) { const target = path.join(base, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target; }
function fixture(overrides: Partial<StorageSourcesOptions> = {}) {
  const userData = path.join(base, 'profile'), working = path.join(base, 'working'); fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(working, { recursive: true });
  const index = path.join('profile', 'room-file-sync', hash(roomId).slice(0, 32), 'room-sync-' + hash(JSON.stringify([roomId, rootId])) + '.json');
  return { userData, working, index, options: { userData, sessionData: userData, rooms: () => ({ rooms: [{ roomId, name: 'Room', folder: working, locked: false }], more: false }), downloads: async () => [], manifest: () => [], decrypt: value => value, ...overrides } satisfies StorageSourcesOptions };
}
const run = (options: StorageSourcesOptions) => scanStorage('fixture', storageSources(options), new AbortController().signal);

it('counts every adapter through read-only files and routes cleanup to existing source tools', async () => {
  const f = fixture(), source = put('download/a.bin', 'source');
  put('profile/Cache/item', 'cache'); put('profile/room-enc/' + roomId + '/copy', 'cipher');
  put('profile/room-documents/context/document.json', 'protected draft'); put('profile/rooms.json', 'shared metadata');
  put('working/.havvn-files/copy/data', 'room copy');
  put('working/.havvn-sync/transactions/op-a/previous', 'backup'); put('working/.havvn-sync/transactions/op-a/journal.json', 'proof');
  put('working/.havvn-sync/trash/op-b/previous', 'trash'); const exported = put('saved-trash.bin', 'export');
  put('profile/room-file-sync/' + hash(roomId).slice(0, 32) + '/bytes/' + rootId + '/snapshot-a/file', 'snapshot');
  put(f.index, JSON.stringify({ snapshot: JSON.stringify({ context: { localRoomId: roomId, rootId }, binding: { path: f.working }, trashExports: [{ path: exported }] }) }));
  const indexBefore = fs.readFileSync(path.join(base, f.index), 'utf8');
  const write = vi.spyOn(fs.promises, 'writeFile'), remove = vi.spyOn(fs.promises, 'rm');
  const report = await run({ ...f.options, downloads: async () => [{ id: 'd', name: 'a.bin', savePath: path.dirname(source) } as Download], manifest: () => [{ fileId: 'original', localOriginal: true, localPath: source } as never] });
  expect(report.status).toBe('complete');
  const find = (kind: string) => report.groups.find(group => group.kind === kind)!;
  expect(find('downloads').logicalBytes).toBe(6); expect(find('originals').logicalBytes).toBe(6); expect(find('originals').sharedBytes).toBe(6);
  expect(find('backups').logicalBytes).toBe(6); expect(find('trash').logicalBytes).toBe(11);
  expect(find('room-copies').logicalBytes).toBe(9); expect(find('ciphertext').logicalBytes).toBe(6); expect(find('sync-cache').logicalBytes).toBe(8);
  expect(find('drafts').mixedData).toBe(true); expect(find('drafts').sharedBytes).toBeGreaterThan(0);
  expect(find('backups').actions).toEqual([{ kind: 'sync', roomId, rootId, label: 'Room', section: 'backups' }]);
  expect(find('originals').actions).toEqual([]); expect(report.groups.every(group => group.reclaimableBytes === null)).toBe(true);
  expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(base, f.index), 'utf8')).toBe(indexBefore);
});
it('shows unknown external backup and trash sizes when protected metadata cannot be opened', async () => {
  const f = fixture({ decrypt: () => { throw Error('locked'); } }); put(f.index, JSON.stringify({ snapshot: 'protected' }));
  const report = await run(f.options);
  for (const kind of ['backups', 'trash']) expect(report.groups.find(group => group.kind === kind)).toMatchObject({ logicalBytes: null, issues: ['encrypted'] });
  expect(report.status).toBe('partial');
});
it('does not decrypt oversized indexes or follow a forged binding from a mismatched context', async () => {
  const decrypt = vi.fn(value => value), f = fixture({ decrypt });
  put(f.index, JSON.stringify({ snapshot: 'x'.repeat(1024 * 1024) }));
  const large = await run(f.options); expect(decrypt).not.toHaveBeenCalled(); expect(large.groups.find(group => group.kind === 'backups')?.issues).toContain('metadata-limit');
  const sentinel = put('outside/.havvn-sync/transactions/op-a/previous', 'untouched');
  put(f.index, JSON.stringify({ snapshot: JSON.stringify({ context: { localRoomId: roomId, rootId: crypto.randomUUID() }, binding: { path: path.join(base, 'outside') } }) }));
  const report = await run(f.options); expect(report.groups.find(group => group.kind === 'backups')).toMatchObject({ logicalBytes: null, issues: ['catalog'] });
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched');
});
it('rejects download names escaping their registered directory and identifies unavailable room paths', async () => {
  const f = fixture({ downloads: async () => [{ id: 'd', name: '../original', savePath: base } as Download], rooms: () => ({ rooms: [{ roomId, name: 'Locked', folder: '', locked: true }], more: false }) });
  const report = await run(f.options);
  expect(report.groups.find(group => group.kind === 'downloads')).toMatchObject({ logicalBytes: null, issues: ['catalog'] });
  expect(report.groups.find(group => group.kind === 'room-copies')).toMatchObject({ logicalBytes: null, issues: ['encrypted'] });
  const invalidPaths = await run({ ...f.options,
    rooms: () => ({ rooms: [{ roomId, name: 'Room', folder: f.working, locked: false }], more: false }),
    downloads: async () => [{ id: 'd', seedPaths: ['../original'] } as Download],
    manifest: () => [{ fileId: 'original', localOriginal: true } as never] });
  for (const kind of ['downloads', 'originals']) expect(invalidPaths.groups.find(group => group.kind === kind)).toMatchObject({ logicalBytes: null, issues: ['catalog'] });
});
it('bounds the catalog before filesystem work and stops reading more manifests at capacity', async () => {
  const manifest = vi.fn(() => Array.from({ length: 1024 }, (_, index) => ({ fileId: String(index), localOriginal: true, localPath: path.join(base, 'original-' + index) })) as never[]);
  const f = fixture({ manifest, rooms: () => ({ rooms: Array.from({ length: 128 }, (_, index) => ({ roomId: String(index), name: 'Room', folder: base, locked: false })), more: false }),
    downloads: async () => [{ id: 'download', name: 'file', savePath: base } as Download] });
  const catalog = await storageSources(f.options)({ signal: new AbortController().signal, check: () => {}, issue: () => {} });
  expect(catalog.roots).toHaveLength(1024); expect(manifest).toHaveBeenCalledOnce();
  for (const kind of ['originals', 'room-copies', 'downloads']) expect(catalog.issues).toContainEqual({ kind, issue: 'limit' });
});
