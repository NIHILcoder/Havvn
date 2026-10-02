import { afterEach, describe, expect, it, vi } from 'vitest';
import { roomHelloParts, RoomHelloAssembly, RoomHelloOutbox, ROOM_HELLO_BYTES, ROOM_HELLO_ENTRIES, validManifestPart, ROOM_MANIFEST_BYTES, storeRoomManifestFile } from './room-manifest-sync';
import { validateGossip, RoomIngressBudget } from './room-protocol';
import { encrypt, deriveKey } from '../electron/sharing/room-crypto';
import { mergeFolderUpsert, applyFolderDelete } from './room-folders';

function hello(count: number, memberId = 'A') {
  const files = Array.from({ length: count }, (_, i) => ({ fileId: i.toString(16).padStart(40, '0'),
    infoHash: i.toString(16).padStart(40, '0'), name: `电影 — фильм ${i}.mkv`, size: i,
    magnetURI: 'magnet:?xt=urn:btih:' + i.toString(16).padStart(40, '0'), addedBy: memberId, addedByName: 'A', addedAt: 1 }));
  return { t: 'hello', memberId, files, have: files.map(f => f.fileId), tombs: [], manifestFull: true, _g: 'source', _t: 4 };
}
afterEach(() => vi.useRealTimers());
describe('large room manifests', () => {
  it('bounds accumulated metadata bytes, preserves existing files and releases space after deletion', () => {
    const files = new Map<string, ReturnType<typeof hello>['files'][number]>(), file = hello(1).files[0];
    const large = { ...file, extension: 'x'.repeat(50_000) };
    let count = 0; while (storeRoomManifestFile(files, { ...large, fileId: String(count) })) count++;
    expect(count).toBeGreaterThan(300); expect(count * 50_000).toBeLessThan(ROOM_MANIFEST_BYTES);
    expect(files.has('0')).toBe(true);
    files.delete('0');
    expect(storeRoomManifestFile(files, { ...large, fileId: 'other' })).toBe(true);
    expect(storeRoomManifestFile(files, { ...file, fileId: 'oversized', extension: 'x'.repeat(70_000) })).toBe(false);
  });
  it.each([500, 5000])('round-trips %i UTF-8 files through valid encrypted frames, including reordered and duplicate pages', count => {
    const source = hello(count), pages = roomHelloParts(source, 'snapshot', 1), assembly = new RoomHelloAssembly();
    const key = deriveKey('room-manifest-sync');
    expect(new Set(pages.map(p => p._g)).size).toBe(pages.length);
    const files = new Map<string, unknown>(); let completed = 0, have: string[] = [];
    for (const page of [...pages].reverse()) {
      expect(validateGossip(page)).toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(ROOM_HELLO_BYTES);
      expect(page.files.length + page.have.length).toBeLessThanOrEqual(ROOM_HELLO_ENTRIES);
      expect(encrypt(key, page).length).toBeLessThan(1_000_000);
      const result = assembly.accept(page); expect(result.accepted).toBe(true);
      if (result.complete) completed++;
      have = result.have!;
      for (const file of page.files) files.set(file.fileId, file);
      expect(assembly.accept(page).accepted).toBe(false);
    }
    expect(completed).toBe(1); expect([...files.keys()].sort()).toEqual(source.have.sort());
    expect(have.sort()).toEqual(source.have);
  });

  it('does not report sync complete from only the final page or let an older snapshot replace a newer one', () => {
    const assembly = new RoomHelloAssembly(), pages = roomHelloParts(hello(500), 'new', 2);
    expect(assembly.accept(pages.at(-1)!).complete).toBe(false);
    const old = roomHelloParts(hello(500), 'old', 1);
    expect(assembly.accept(old[0]).accepted).toBe(false);
    expect(assembly.accept({ ...pages[0], manifestPart: { ...pages[0].manifestPart, total: 999 } }).accepted).toBe(false);
    expect(validManifestPart({ id: 'x', at: 1, index: 0, total: 1025 })).toBe(false);
  });

  it('paces three rooms under their ingress budgets and pauses bulk traffic on data-channel backpressure', async () => {
    vi.useFakeTimers(); const rooms = Array.from({ length: 3 }, () => new RoomHelloOutbox());
    const received = [0, 0, 0], budgets = rooms.map(() => new RoomIngressBudget()), ready = [false, true, true];
    const pages = roomHelloParts(hello(5000), 'load', 1);
    rooms.forEach((outbox, i) => outbox.enqueue({}, pages, page => {
      expect(budgets[i].take(Buffer.byteLength(JSON.stringify(page)) * 4 / 3)).toBe(true);
      received[i] += page.files.length;
    }, () => ready[i]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(received[0]).toBe(0); expect(received[1]).toBeGreaterThan(0);
    ready[0] = true; await vi.runAllTimersAsync();
    expect(received).toEqual([5000, 5000, 5000]); rooms.forEach(outbox => outbox.stop());
  });

  it('coalesces pending snapshots, bounds relay memory and cancels queued work on teardown', async () => {
    vi.useFakeTimers(); const outbox = new RoomHelloOutbox(), wire = {}, sent: ReturnType<typeof roomHelloParts> = [];
    outbox.enqueue(wire, roomHelloParts(hello(500), 'old', 1), p => sent.push(p), () => true);
    outbox.enqueue(wire, roomHelloParts(hello(500), 'new', 2), p => sent.push(p), () => true);
    const page = roomHelloParts(hello(500), 'relay', 1)[0];
    let queued = 0; while (outbox.relay(page, () => {}, () => false)) queued++;
    expect(queued).toBeGreaterThan(0); expect(queued).toBeLessThanOrEqual(256);
    expect(outbox.relay(page, () => {}, () => false)).toBe(false);
    await vi.advanceTimersByTimeAsync(0); expect(sent[0].manifestPart.id).toBe('new');
    outbox.stop(); const count = sent.length; await vi.runAllTimersAsync(); expect(sent).toHaveLength(count);
  });

  it('never evicts a folder or deletion floor to accept an unlimited stream of new IDs', () => {
    const folders = new Map(), tombs = new Map();
    for (let i = 0; i < 600; i++) mergeFolderUpsert(folders, tombs, { id: String(i), name: 'Folder', at: 1 });
    expect(folders.size).toBe(512);
    expect(mergeFolderUpsert(folders, tombs, { id: '0', name: 'Updated', at: 2 })).toBe(true);
    for (let i = 0; i < 6000; i++) applyFolderDelete(folders, tombs, String(i), 3);
    expect(tombs.size).toBe(5000); expect(tombs.get('0')).toBe(3);
    expect(mergeFolderUpsert(folders, tombs, { id: '0', name: 'Stale', at: 2 })).toBe(false);
  });
});
