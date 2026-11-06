import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ values: new Map<string, Record<string, unknown>>(), fail: false }));
vi.mock('electron-store', () => ({ default: class {
  private key: string;
  constructor(options: { cwd: string; name: string }) { this.key = path.join(options.cwd, options.name); }
  get(key: string) { return disk.values.get(this.key)?.[key]; }
  has(key: string) { return this.get(key) !== undefined; }
  set(key: string, value: unknown) { if (disk.fail) throw new Error('disk full'); disk.values.set(this.key, { ...disk.values.get(this.key), [key]: value }); }
} }));
vi.mock('./secrets', () => ({ encryptSecret: (value: string) => 'sealed:' + Buffer.from(value).toString('base64'), decryptSecretStrict: (value: string) => {
  if (!value.startsWith('sealed:')) throw new Error('Invalid encryption'); return Buffer.from(value.slice(7), 'base64').toString();
} }));
import { documentContextKey, documentContextScope, rememberDocumentContext, type DocumentContext } from './room-documents-store';

const room = '11111111-1111-4111-8111-111111111111';
const original: DocumentContext = { scope: 'a'.repeat(40), ownerId: 'b'.repeat(32), e2e: true };
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-doc-contexts-')); disk.values.clear(); disk.fail = false; });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

it('persists previous contexts in newest-first order across restarts without storing invite secrets', () => {
  const first = rememberDocumentContext(directory, room, original); expect(first.sources).toHaveLength(0);
  const next = { ...original, ownerId: 'c'.repeat(32), authority: 'd'.repeat(64) };
  const second = rememberDocumentContext(directory, room, next); expect(second.sources.map(s => s.context)).toEqual([original]);
  expect(second.directory).not.toBe(first.directory);
  const restarted = rememberDocumentContext(directory, room, next); expect(restarted.sources.map(s => s.context)).toEqual([original]);
  const rekeyed = rememberDocumentContext(directory, room, { ...next, scope: 'e'.repeat(40), secret: 'f'.repeat(64) });
  expect(rekeyed.sources.map(s => s.context)).toEqual([next, original]);
  expect([...disk.values.values()].every(value => typeof value.contexts === 'string' && value.contexts.startsWith('sealed:'))).toBe(true);
});
it('discovers the original directory when upgrading a room that already has documents', () => {
  const legacy = path.join(directory, 'room-documents', documentContextKey(room, original)); fs.mkdirSync(legacy, { recursive: true });
  const next = { ...original, secret: 'f'.repeat(64) };
  expect(rememberDocumentContext(directory, room, next).sources.map(s => s.context)).toEqual([original]);
});
it('binds signatures to the authority generation and secret while retaining legacy verification', () => {
  const current = { ...original, protocol: 2 as const, secret: 'f'.repeat(64) };
  const scope = documentContextScope(current); expect(scope).toHaveLength(64); expect(documentContextScope(original)).toBe(original.scope);
  for (const next of [{ ...current, authority: 'd'.repeat(64) }, { ...current, secret: 'e'.repeat(64) }, { ...current, ownerId: 'c'.repeat(32) }, { ...current, e2e: false }, { ...current, scope: 'b'.repeat(40) }]) expect(documentContextScope(next)).not.toBe(scope);
  const reordered = { protocol: 2 as const, secret: current.secret, e2e: original.e2e, ownerId: original.ownerId, scope: original.scope };
  expect(documentContextScope(reordered)).toBe(scope);
});
it('fails closed on unreadable or malformed protected indexes and never silently starts an empty catalog', () => {
  rememberDocumentContext(directory, room, original);
  const key = [...disk.values.keys()][0]; disk.values.set(key, { contexts: 'corrupted' });
  expect(() => rememberDocumentContext(directory, room, original)).toThrow('encryption');
  disk.values.set(key, { contexts: 'sealed:' + Buffer.from(JSON.stringify([{ ...original, scope: '../unrelated' }])).toString('base64') });
  expect(() => rememberDocumentContext(directory, room, original)).toThrow('contexts');
});
it('preserves the previous pointers if recording a transition fails', () => {
  rememberDocumentContext(directory, room, original); const before = structuredClone([...disk.values]); disk.fail = true;
  expect(() => rememberDocumentContext(directory, room, { ...original, ownerId: 'c'.repeat(32) })).toThrow('disk full');
  expect([...disk.values]).toEqual(before);
});
it('separates return transfers and secret rotations, and bounds the recovery index without pruning originals', () => {
  const first = rememberDocumentContext(directory, room, original);
  const returned = rememberDocumentContext(directory, room, { ...original, authority: 'c'.repeat(64) }); expect(returned.directory).not.toBe(first.directory);
  const rotated = rememberDocumentContext(directory, room, { ...original, authority: 'c'.repeat(64), secret: 'd'.repeat(64) }); expect(rotated.directory).not.toBe(returned.directory);
  expect(() => rememberDocumentContext(directory, '../room', original)).toThrow('room');
  const key = [...disk.values.keys()][0], contexts = Array.from({ length: 256 }, (_, i) => ({ ...original, authority: i.toString(16).padStart(64, '0') }));
  disk.values.set(key, { contexts: 'sealed:' + Buffer.from(JSON.stringify(contexts)).toString('base64') });
  const before = structuredClone([...disk.values]); expect(() => rememberDocumentContext(directory, room, original)).toThrow('capacity'); expect([...disk.values]).toEqual(before);
});
