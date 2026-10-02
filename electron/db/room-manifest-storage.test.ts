import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedRoomFile } from '../../shared/types';
const state = vi.hoisted(() => ({ stores: new Map<string, Record<string, unknown>>(), writes: 0 }));
vi.mock('electron', () => ({ app: { getPath: () => 'D:/isolated-test' } }));
vi.mock('./secrets', () => ({ encryptSecret: (s: string) => s, decryptSecret: (s: string) => s }));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('electron-store', () => ({ default: class {
  private name: string;
  constructor(options: { name?: string; defaults: Record<string, unknown> }) {
    this.name = options.name ?? 'config';
    if (!state.stores.has(this.name)) state.stores.set(this.name, structuredClone(options.defaults));
  }
  get(key: string) { return structuredClone(state.stores.get(this.name)?.[key]); }
  set(key: string | Record<string, unknown>, value?: unknown) {
    state.writes++;
    state.stores.set(this.name, { ...state.stores.get(this.name), ...structuredClone(typeof key === 'string' ? { [key]: value } : key) });
  }
  has(key: string) { return key in state.stores.get(this.name)!; }
  delete(key: string) { delete state.stores.get(this.name)![key]; }
} }));
import * as db from './store';
const file = (i: number): PersistedRoomFile => ({ fileId: String(i), infoHash: String(i), name: `Film ${i}.mkv`,
  size: i, magnetURI: 'magnet:?xt=urn:btih:' + i, addedBy: 'A', addedByName: 'A', addedAt: 1 });
beforeEach(() => { db.clearRoomManifest('load'); state.writes = 0; });
describe('bounded manifest persistence', () => {
  it('retains more than 500 deletion/revive clocks and stops growth at the shared limit without eviction', () => {
    for (let i = 0; i < 501; i++) {
      db.addRoomTombstone('clocks', String(i), i + 1); db.addRoomRevive('clocks', String(i), i + 1);
      db.addRoomFolderTombstone('clocks', String(i), i + 1);
    }
    expect(db.getRoomTombstones('clocks')['0']).toBe(1);
    expect(db.getRoomRevives('clocks')['0']).toBe(1);
    expect(db.getRoomFolderTombstones('clocks')['0']).toBe(1);
    for (const store of state.stores.values()) if ('roomTombstones' in store) {
      const clocks = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i), i + 1]));
      (store.roomTombstones as Record<string, unknown>).clocks = structuredClone(clocks); (store.roomRevives as Record<string, unknown>).clocks = structuredClone(clocks);
      (store.roomFolderTombstones as Record<string, unknown>).clocks = structuredClone(clocks);
    }
    db.addRoomTombstone('clocks', 'overflow', 6000); db.addRoomRevive('clocks', 'overflow', 6000);
    db.addRoomFolderTombstone('clocks', 'overflow', 6000);
    expect(Object.keys(db.getRoomTombstones('clocks'))).toHaveLength(5000);
    expect(Object.keys(db.getRoomRevives('clocks'))).toHaveLength(5000);
    expect(Object.keys(db.getRoomFolderTombstones('clocks'))).toHaveLength(5000);
    expect(db.getRoomTombstones('clocks')['0']).toBe(1);
  });
  it.each([500, 5000])('retains all %i entries across store serialization using one write per page', count => {
    const files = Array.from({ length: count }, (_, i) => file(i));
    for (let i = 0; i < count; i += 64) db.upsertRoomManifestFiles('load', files.slice(i, i + 64));
    expect(state.writes).toBe(Math.ceil(count / 64));
    expect(db.getRoomManifest('load')).toEqual(files);
    const snapshot = JSON.stringify([...state.stores]); state.stores = new Map(JSON.parse(snapshot));
    expect(db.getRoomManifest('load')).toEqual(files);
  });
  it('preserves accepted files at capacity while still allowing updates', () => {
    db.upsertRoomManifestFiles('load', Array.from({ length: 5000 }, (_, i) => file(i)));
    db.upsertRoomManifestFile('load', file(5000));
    db.upsertRoomManifestFile('load', { ...file(0), localPath: 'D:/original.mkv' });
    expect(db.getRoomManifest('load')).toHaveLength(5000);
    expect(db.getRoomManifest('load')[0].localPath).toBe('D:/original.mkv');
    expect(db.getRoomManifest('load').some(f => f.fileId === '5000')).toBe(false);
  });
});
