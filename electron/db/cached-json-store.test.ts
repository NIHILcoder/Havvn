import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CachedJsonStore } from './cached-json-store';

type Data = { rooms: Record<string, { name: string }>; archive: string[] };
const directories: string[] = [];
function backend() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-json-cache-')); directories.push(directory);
  const file = path.join(directory, 'rooms.json');
  const initial: Data = { rooms: { a: { name: 'A' }, b: { name: 'B' } }, archive: ['protected'] };
  fs.writeFileSync(file, JSON.stringify(initial));
  return {
    path: file, reads: 0, writes: 0, fail: false,
    get store(): Data { this.reads++; return JSON.parse(fs.readFileSync(file, 'utf8')); },
    set store(value: Data) { if (this.fail) throw new Error('disk full'); this.writes++; fs.writeFileSync(file, JSON.stringify(value)); },
    get(key: string): unknown { return this.store[key as keyof Data]; },
    set(key: string | Partial<Data>, value?: unknown) { this.store = { ...this.store, ...(typeof key === 'string' ? { [key]: value } : key) }; },
    has(key: string) { return key in this.store; },
    clear() { this.store = initial; },
  };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('havvn-json-cache-')) throw new Error('Unexpected temporary directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('protected JSON cache', () => {
  it('keeps cached values identical to JSON after undefined fields and array holes are written', () => {
    const source = backend(), cache = new CachedJsonStore(source);
    cache.set('rooms', { a: { name: 'A', parentId: undefined } } as Data['rooms']);
    expect(cache.getEntry('rooms', 'a')).toEqual({ name: 'A' });
    expect(Object.hasOwn(cache.getEntry('rooms', 'a')!, 'parentId')).toBe(false);
    cache.set('archive', ['a', undefined] as unknown as string[]);
    expect(cache.get('archive')).toEqual(['a', null]); expect(cache.get('archive')).toEqual(source.store.archive);
  });

  it('reads once, clones only the requested partition/room, and writes without another parse', () => {
    const source = backend(), cache = new CachedJsonStore(source);
    const room = cache.getEntry('rooms', 'a')!; room.name = 'mutated';
    expect(cache.getEntry('rooms', 'a')).toEqual({ name: 'A' }); expect(cache.hasEntry('rooms', 'b')).toBe(true);
    expect(cache.get('archive')).toEqual(['protected']); expect(source.reads).toBe(1);
    cache.set('archive', ['new ciphertext']); expect(source.reads).toBe(1); expect(source.writes).toBe(1);
    expect(cache.get('archive')).toEqual(['new ciphertext']);
    const patch = { rooms: { a: { name: 'new' } } }; cache.set(patch); patch.rooms.a.name = 'mutated later';
    expect(cache.getEntry('rooms', 'a')?.name).toBe('new');
  });

  it('invalidates on failed writes, external replacement and clear', () => {
    const source = backend(), cache = new CachedJsonStore(source);
    cache.get('rooms'); source.fail = true;
    expect(() => cache.set('rooms', { a: { name: 'lost' } })).toThrow('disk full');
    expect(cache.getEntry('rooms', 'a')?.name).toBe('A'); expect(source.reads).toBe(2);
    source.fail = false; fs.writeFileSync(source.path, JSON.stringify({ rooms: { z: { name: 'external update' } }, archive: [] }));
    expect(cache.getEntry('rooms', 'z')?.name).toBe('external update'); expect(cache.hasEntry('rooms', 'a')).toBe(false);
    cache.clear(); expect(cache.getEntry('rooms', 'a')?.name).toBe('A');
  });

  it('does not retain oversized archives, but parses once in a synchronous operation', () => {
    const source = backend(), cache = new CachedJsonStore(source, 1);
    cache.get('rooms'); cache.get('archive'); expect(source.reads).toBe(2);
    cache.withSnapshot(() => {
      cache.get('rooms'); cache.get('archive');
      cache.withSnapshot(() => cache.getEntry('rooms', 'a'));
      cache.set('archive', ['still protected']);
      expect(cache.get('archive')).toEqual(['still protected']);
    });
    expect(source.reads).toBe(3); cache.get('rooms'); expect(source.reads).toBe(4);
    expect(() => cache.withSnapshot(() => { cache.get('rooms'); throw new Error('abort'); })).toThrow('abort');
    cache.get('archive'); expect(source.reads).toBe(6);
  });
});
