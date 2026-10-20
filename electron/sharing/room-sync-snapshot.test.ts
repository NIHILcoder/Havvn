import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareSyncSnapshot } from './room-sync-snapshot';
import { syncWorkQueue } from './room-sync-work';
import { encryptFile } from './room-e2e';
import { verifyRoomFile } from './room-file-storage';

let folder: string;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-snapshot-')); fs.writeFileSync(path.join(folder, 'sample.bin'), Buffer.alloc(2 * 1024 * 1024, 37)); });
afterEach(async () => {
  vi.restoreAllMocks(); const target = path.resolve(folder);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-sync-snapshot-')) throw Error('Unexpected fixture directory');
  await fs.promises.rm(target, { recursive: true, force: true });
});
it('serializes actual encrypted preparations from different owners and verifies every result', async () => {
  const copy = fs.promises.copyFile.bind(fs.promises); let active = 0, peak = 0;
  vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => { active++; peak = Math.max(peak, active); try { await copy(...args); } finally { active--; } });
  const outputs = await Promise.all(Array.from({ length: 4 }, (_, i) => prepareSyncSnapshot({ source: path.join(folder, 'sample.bin'), storage: path.join(folder, 'out-' + i), authorId: 'test', secret: 'a'.repeat(64) })));
  expect(peak).toBe(1); expect(new Set(outputs.map(output => output.plaintextDigest)).size).toBe(1);
  for (const output of outputs) await expect(verifyRoomFile(output.sourcePath, output.file, output.metadata)).resolves.toEqual(output.metadata);
});
it('cancels waiting work before making a snapshot directory or touching its source', async () => {
  let finish!: () => void; const owner = {}, blocker = syncWorkQueue.run({ owner }, () => new Promise<void>(resolve => { finish = resolve; }));
  let valid = true; const output = path.join(folder, 'never-created');
  const pending = prepareSyncSnapshot({ source: path.join(folder, 'sample.bin'), storage: output, authorId: 'test', isCurrent: () => valid }).catch(error => error.message);
  valid = false;
  try { expect(await pending).toBe('Sync preparation canceled'); expect(fs.existsSync(output)).toBe(false); }
  finally { finish(); await blocker; }
});
it('waits for an in-progress copy before cleanup, then lets another snapshot start', async () => {
  const copy = fs.promises.copyFile.bind(fs.promises); let finish!: () => void; let started!: () => void;
  const copying = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (...args) => { started(); await gate; await copy(...args); });
  const owner = {}, output = path.join(folder, 'canceled');
  const first = prepareSyncSnapshot({ source: path.join(folder, 'sample.bin'), storage: output, authorId: 'test', work: { owner } }).catch(error => error.message);
  await copying; syncWorkQueue.cancel(owner);
  const next = prepareSyncSnapshot({ source: path.join(folder, 'sample.bin'), storage: path.join(folder, 'next'), authorId: 'test' });
  expect(fs.existsSync(path.join(folder, 'next'))).toBe(false); finish(); expect(await first).toBe('Sync preparation canceled');
  expect(await fs.promises.readdir(output)).toEqual([]); await next;
});
it('aborts encryption streams and removes partial ciphertext without changing the source', async () => {
  const controller = new AbortController(), original = fs.createReadStream, destination = path.join(folder, 'partial.enc');
  vi.spyOn(fs, 'createReadStream').mockImplementationOnce((...args: Parameters<typeof fs.createReadStream>) => {
    const stream = original(...args); stream.once('data', () => controller.abort()); return stream;
  });
  await expect(encryptFile(path.join(folder, 'sample.bin'), destination, 'a'.repeat(64), { signal: controller.signal })).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false); expect(fs.statSync(path.join(folder, 'sample.bin')).size).toBe(2 * 1024 * 1024);
});
