import { describe, it, expect } from 'vitest';
import {
  mergeFolderUpsert, applyFolderDelete, applyAssignment, groupFilesByFolder, sanitizeFolderIcon, FOLDER_ICONS,
} from './room-folders';
import type { RoomFile, RoomFolder } from './types';

const folder = (id: string, at: number, name = id): RoomFolder => ({ id, name, icon: 'folder', color: '#888', at });
const file = (fileId: string, over: Partial<RoomFile> = {}): RoomFile => ({
  fileId, name: fileId, size: 1, infoHash: fileId, magnetURI: `magnet:?xt=urn:btih:${fileId}`,
  addedBy: 'm1', addedByName: 'M', addedAt: 1, ...over,
});

describe('mergeFolderUpsert', () => {
  it('adds a new folder', () => {
    const folders = new Map<string, RoomFolder>(); const tombs = new Map<string, number>();
    expect(mergeFolderUpsert(folders, tombs, folder('a', 10))).toBe(true);
    expect(folders.get('a')?.at).toBe(10);
  });
  it('keeps the newer edit (LWW), rejects the older', () => {
    const folders = new Map([['a', folder('a', 20, 'new')]]); const tombs = new Map<string, number>();
    expect(mergeFolderUpsert(folders, tombs, folder('a', 10, 'old'))).toBe(false);
    expect(folders.get('a')?.name).toBe('new');
    expect(mergeFolderUpsert(folders, tombs, folder('a', 30, 'newer'))).toBe(true);
    expect(folders.get('a')?.name).toBe('newer');
  });
  it('stays deleted when the upsert predates the tombstone', () => {
    const folders = new Map<string, RoomFolder>(); const tombs = new Map([['a', 50]]);
    expect(mergeFolderUpsert(folders, tombs, folder('a', 40))).toBe(false);
    expect(folders.has('a')).toBe(false);
  });
  it('revives when the upsert is newer than the tombstone', () => {
    const folders = new Map<string, RoomFolder>(); const tombs = new Map([['a', 50]]);
    expect(mergeFolderUpsert(folders, tombs, folder('a', 60))).toBe(true);
    expect(folders.has('a')).toBe(true);
    expect(tombs.has('a')).toBe(false);
  });
  it('ignores malformed input', () => {
    const folders = new Map<string, RoomFolder>(); const tombs = new Map<string, number>();
    expect(mergeFolderUpsert(folders, tombs, { id: '', name: 'x', icon: '', color: '', at: 1 })).toBe(false);
    expect(mergeFolderUpsert(folders, tombs, { id: 'a', name: 'x', icon: '', color: '', at: NaN })).toBe(false);
  });
  it('does not clear an existing tombstone when the upsert is rejected as stale', () => {
    // Guards the reorder fix: mutating tombs then returning false would desync
    // the in-memory map from the persisted one.
    const folders = new Map([['a', folder('a', 60)]]); const tombs = new Map([['a', 40]]);
    expect(mergeFolderUpsert(folders, tombs, folder('a', 50))).toBe(false);
    expect(tombs.get('a')).toBe(40); // still there
  });
});

describe('sanitizeFolderIcon', () => {
  it('passes a known icon through', () => {
    for (const ic of FOLDER_ICONS) expect(sanitizeFolderIcon(ic)).toBe(ic);
  });
  it('falls back to folder for unknown / empty / non-string', () => {
    expect(sanitizeFolderIcon('definitely-not-an-icon')).toBe('folder');
    expect(sanitizeFolderIcon('')).toBe('folder');
    expect(sanitizeFolderIcon(undefined)).toBe('folder');
    expect(sanitizeFolderIcon(42)).toBe('folder');
    expect(sanitizeFolderIcon({ evil: true })).toBe('folder');
  });
});

describe('applyFolderDelete', () => {
  it('tombstones and removes a folder', () => {
    const folders = new Map([['a', folder('a', 10)]]); const tombs = new Map<string, number>();
    expect(applyFolderDelete(folders, tombs, 'a', 20)).toBe(true);
    expect(folders.has('a')).toBe(false);
    expect(tombs.get('a')).toBe(20);
  });
  it('a folder edited AFTER the delete survives', () => {
    const folders = new Map([['a', folder('a', 30)]]); const tombs = new Map<string, number>();
    expect(applyFolderDelete(folders, tombs, 'a', 20)).toBe(true); // tombstone still advances
    expect(folders.has('a')).toBe(true);                            // but the newer edit keeps it
  });
  it('is idempotent once tombstoned at/after the time', () => {
    const folders = new Map<string, RoomFolder>(); const tombs = new Map([['a', 50]]);
    expect(applyFolderDelete(folders, tombs, 'a', 40)).toBe(false);
    expect(applyFolderDelete(folders, tombs, 'a', 50)).toBe(false);
  });
});

describe('applyAssignment', () => {
  it('assigns and clears with LWW by folderAt', () => {
    const f = file('x');
    expect(applyAssignment(f, 'a', 10)).toBe(true);
    expect(f.folderId).toBe('a'); expect(f.folderAt).toBe(10);
    expect(applyAssignment(f, 'b', 5)).toBe(false);   // stale
    expect(f.folderId).toBe('a');
    expect(applyAssignment(f, 'b', 20)).toBe(true);
    expect(f.folderId).toBe('b');
  });
  it('null / empty clears to Uncategorized', () => {
    const f = file('x', { folderId: 'a', folderAt: 10 });
    expect(applyAssignment(f, null, 20)).toBe(true);
    expect(f.folderId).toBeUndefined();
    expect(applyAssignment(f, '', 30)).toBe(true);
    expect(f.folderId).toBeUndefined();
  });
  it('rejects an assignment equal to or older than the current clock', () => {
    const f = file('x', { folderId: 'a', folderAt: 20 });
    expect(applyAssignment(f, 'b', 20)).toBe(false);
    expect(applyAssignment(f, 'b', 19)).toBe(false);
  });
});

describe('groupFilesByFolder', () => {
  const folders = [folder('a', 1, 'Movies'), folder('b', 2, 'Music')];
  it('groups by folderId, preserves folder order, keeps empty sections', () => {
    const files = [file('1', { folderId: 'b' }), file('2', { folderId: 'a' })];
    const groups = groupFilesByFolder(files, folders);
    expect(groups.map((g) => g.folder?.id)).toEqual(['a', 'b']); // no uncategorized bucket
    expect(groups[0].files.map((f) => f.fileId)).toEqual(['2']);
    expect(groups[1].files.map((f) => f.fileId)).toEqual(['1']);
  });
  it('unknown / empty folderId lands in an Uncategorized bucket placed last', () => {
    const files = [file('1', { folderId: 'a' }), file('2'), file('3', { folderId: 'ghost' })];
    const groups = groupFilesByFolder(files, folders);
    const last = groups[groups.length - 1];
    expect(last.folder).toBeNull();
    expect(last.files.map((f) => f.fileId)).toEqual(['2', '3']);
  });
  it('no folders → single Uncategorized bucket (or none when empty)', () => {
    expect(groupFilesByFolder([file('1')], [])).toEqual([{ folder: null, files: [expect.objectContaining({ fileId: '1' })] }]);
    expect(groupFilesByFolder([], [])).toEqual([]);
  });
});
