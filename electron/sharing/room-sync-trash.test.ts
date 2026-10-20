import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoomSyncTrash, type SyncTrashJournal, type SyncTrashStep } from './room-sync-trash';
let root: string;
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const request = (): SyncTrashJournal => ({ v: 1, revisionId: sha('delete'), baseRevisionId: sha('base'), relativePath: 'config.ini', expectedDigest: sha('original') });
const target = () => path.join(root, 'config.ini');
const trash = () => { const dir = path.join(root, '.havvn-sync', 'trash'); return path.join(dir, fs.readdirSync(dir)[0], 'previous'); };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-trash-')); fs.writeFileSync(target(), 'original'); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
describe('durable sync trash', () => {
  it('keeps deleted bytes and records a replayable terminal receipt', async () => {
    const applier = new RoomSyncTrash(root), receipt = await applier.remove(request(), () => true, () => true);
    expect(fs.existsSync(target())).toBe(false); expect(fs.readFileSync(trash(), 'utf8')).toBe('original');
    expect((await new RoomSyncTrash(root).recover(() => true))[0]).toEqual(receipt);
    expect(await applier.pins(() => true)).toEqual([sha('base')]);
    fs.writeFileSync(target(), 'new local file'); await applier.recover(() => true);
    expect(fs.readFileSync(target(), 'utf8')).toBe('new local file');
  });
  it.each(['prepared', 'previous-saved', 'committed'] as SyncTrashStep[])('recovers a process interruption after %s without losing bytes', async step => {
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true, async current => { if (current === step) throw new Error('crash'); })).rejects.toThrow('crash');
    const result = await new RoomSyncTrash(root).recover(() => true);
    expect(result[0].state).toBe(step === 'prepared' ? 'rolled-back' : 'deleted');
    expect(fs.readFileSync(step === 'prepared' ? target() : trash(), 'utf8')).toBe('original');
    expect(await new RoomSyncTrash(root).recover(() => true)).toEqual(result);
  });
  it('refuses stale bytes and cancellation before moving anything', async () => {
    fs.writeFileSync(target(), 'local edit');
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true)).rejects.toThrow('local changes');
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => false)).rejects.toThrow('canceled');
    expect(fs.readFileSync(target(), 'utf8')).toBe('local edit');
  });
  it('returns an edit that followed the renamed file handle', async () => {
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true, async step => {
      if (step === 'previous-saved') fs.writeFileSync(trash(), 'late local edit');
    })).rejects.toThrow('local changes');
    expect((await new RoomSyncTrash(root).recover(() => true))[0].state).toBe('rolled-back');
    expect(fs.readFileSync(target(), 'utf8')).toBe('late local edit');
  });
  it('preserves both a new target and renamed bytes, requiring explicit review', async () => {
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true, async step => {
      if (step === 'previous-saved') fs.writeFileSync(target(), 'new target');
    })).rejects.toThrow('local changes');
    expect((await new RoomSyncTrash(root).recover(() => true))[0].state).toBe('conflict');
    expect(fs.readFileSync(target(), 'utf8')).toBe('new target'); expect(fs.readFileSync(trash(), 'utf8')).toBe('original');
    await new RoomSyncTrash(root).abandon('config.ini', sha('new target'), () => true, () => true);
    expect((await new RoomSyncTrash(root).recover(() => true))[0].state).toBe('rolled-back');
    expect(fs.readFileSync(trash(), 'utf8')).toBe('original');
  });
  it('rejects forged journal authority before recovery touches a target', async () => {
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true, async step => { if (step === 'prepared') throw new Error('crash'); })).rejects.toThrow();
    await expect(new RoomSyncTrash(root).recover(() => false)).rejects.toThrow('not authorized');
    expect(fs.readFileSync(target(), 'utf8')).toBe('original');
  });
  it('returns the working file if authorization changes while its rename completes', async () => {
    let current = true;
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => current, async step => {
      if (step === 'previous-saved') current = false;
    })).rejects.toThrow('canceled');
    expect(fs.readFileSync(target(), 'utf8')).toBe('original');
    expect((await new RoomSyncTrash(root).recover(() => true))[0].state).toBe('rolled-back');
  });
  it('enforces capacity by stopping deletion, leaving existing trash intact', async () => {
    const applier = new RoomSyncTrash(root, 10); await applier.remove(request(), () => true, () => true);
    fs.writeFileSync(target(), 'original');
    await expect(applier.remove({ ...request(), revisionId: sha('another deletion') }, () => true, () => true)).rejects.toThrow('size limit');
    expect(fs.readFileSync(target(), 'utf8')).toBe('original'); expect(fs.readFileSync(trash(), 'utf8')).toBe('original');
  });
  it('does not treat an unavailable local binding as empty trash during cache maintenance', async () => {
    const applier = new RoomSyncTrash(root); await applier.remove(request(), () => true, () => true);
    fs.rmSync(root, { recursive: true, force: true }); // Exclusive temporary fixture, simulating an unavailable volume.
    await expect(applier.pins(() => true)).rejects.toThrow();
  });
  it('rejects hard links and unsafe paths', async () => {
    fs.linkSync(target(), path.join(root, 'linked'));
    await expect(new RoomSyncTrash(root).remove(request(), () => true, () => true)).rejects.toThrow();
    await expect(new RoomSyncTrash(root).remove({ ...request(), relativePath: '../outside' }, () => true, () => true)).rejects.toThrow('Invalid');
    expect(fs.readFileSync(target(), 'utf8')).toBe('original');
  });
});
