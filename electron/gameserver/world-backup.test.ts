/**
 * World backups: id validation and restore atomicity.
 *
 * Both properties here are about damage a bug in this file can do that nothing
 * downstream can undo. `backupId` arrives from the renderer and lands in an
 * `rm -rf`-shaped call, and a restore replaces the one copy of a world that
 * might represent months of play.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// instancePaths is rooted at the Electron userData dir; point the whole module
// at a temp tree instead so the real one is never touched.
const H = vi.hoisted(() => ({ base: '', free: null as number | null }));
vi.mock('./host-resources', () => ({ freeBytes: () => H.free }));

vi.mock('./paths', async () => {
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  return {
    instancePaths: (instanceId: string) => {
      const base = nodePath.join(H.base, instanceId);
      return {
        base,
        root: nodePath.join(base, 'root'),
        logs: nodePath.join(base, 'logs'),
        content: nodePath.join(base, 'content'),
        meta: nodePath.join(base, 'instance.json'),
      };
    },
    ensureDir: (dir: string) => { nodeFs.mkdirSync(dir, { recursive: true }); },
  };
});

import {
  backupTagNow, backupWorldDir, createWorldBackup, deleteWorldBackup,
  isValidBackupId, listWorldBackups, restoreWorldBackup,
} from './world-backup';

const INSTANCE = 'inst-backup-1';

let tmp: string;
const worldDir = (): string => path.join(H.base, INSTANCE, 'root', 'world');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-backup-'));
  H.base = tmp;
  H.free = null;
  fs.mkdirSync(worldDir(), { recursive: true });
  fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'the only copy');
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('world-backup ids', () => {
  it('backupTagNow is filesystem-safe and passes its own validator', () => {
    const tag = backupTagNow();
    expect(tag).not.toMatch(/[:.]/);
    expect(isValidBackupId(tag)).toBe(true);
    // The auto-backup prefix applyUpdate uses must survive validation too.
    expect(isValidBackupId(`pre-update-${tag}`)).toBe(true);
  });

  it('rejects every id that could walk out of the backups folder', () => {
    for (const bad of ['..', '../..', 'a/../..', 'a/b', 'a\\b', '/etc', 'C:\\Windows', '', '.hidden']) {
      expect(isValidBackupId(bad)).toBe(false);
    }
  });
});

describe('deleteWorldBackup', () => {
  it('refuses a traversing id instead of deleting outside the backups folder', async () => {
    // The target a `..` id would reach: the instance tree itself.
    const outside = path.join(H.base, INSTANCE, 'root');
    expect(fs.existsSync(outside)).toBe(true);

    await expect(deleteWorldBackup(INSTANCE, '../root')).rejects.toThrow(/invalid backupId/);
    await expect(deleteWorldBackup(INSTANCE, '..')).rejects.toThrow(/invalid backupId/);

    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(path.join(worldDir(), 'level.dat'))).toBe(true);
  });

  it('deletes a real backup', async () => {
    const made = await createWorldBackup(INSTANCE, 'keeper');
    expect(await listWorldBackups(INSTANCE)).toHaveLength(1);
    await deleteWorldBackup(INSTANCE, made.id);
    expect(await listWorldBackups(INSTANCE)).toHaveLength(0);
  });

  it('reports a missing backup rather than succeeding silently', async () => {
    await expect(deleteWorldBackup(INSTANCE, 'never-made-this')).rejects.toThrow('backup-not-found');
  });
});

describe('createWorldBackup / listWorldBackups', () => {
  it('records the label and the size so listing never walks the tree', async () => {
    const made = await createWorldBackup(INSTANCE, 'before the nether trip');
    expect(made.label).toBe('before the nether trip');
    expect(made.bytes).toBeGreaterThan(0);

    const meta = JSON.parse(
      fs.readFileSync(path.join(H.base, INSTANCE, 'backups', made.id, 'meta.json'), 'utf8'),
    );
    expect(meta.bytes).toBe(made.bytes);

    const listed = await listWorldBackups(INSTANCE);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: made.id, label: 'before the nether trip', bytes: made.bytes });
  });

  it('marks an update backup as automatic', async () => {
    await backupWorldDir(INSTANCE, `pre-update-${backupTagNow()}`);
    const listed = await listWorldBackups(INSTANCE);
    expect(listed).toHaveLength(1);
    expect(listed[0].auto).toBe(true);
  });

  it('refuses to back up when there is no world yet', async () => {
    fs.rmSync(worldDir(), { recursive: true, force: true });
    expect(await backupWorldDir(INSTANCE, backupTagNow())).toBeNull();
    await expect(createWorldBackup(INSTANCE)).rejects.toThrow('no-world');
  });
});

describe('restoreWorldBackup', () => {
  it('refuses a damaged backup before touching the current world', async () => {
    const made = await createWorldBackup(INSTANCE);
    fs.writeFileSync(path.join(H.base, INSTANCE, 'backups', made.id, 'world', 'level.dat'), 'corrupted');
    fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'current');
    await expect(restoreWorldBackup(INSTANCE, made.id)).rejects.toThrow('backup-damaged');
    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('current');
  });

  it('does not erase Paper dimensions absent from a legacy backup', async () => {
    const root = path.dirname(worldDir()), legacy = path.join(H.base, INSTANCE, 'backups', 'legacy', 'world');
    fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'level.dat'), 'legacy world');
    fs.mkdirSync(path.join(root, 'world_nether')); fs.writeFileSync(path.join(root, 'world_nether', 'region'), 'keep dimension');
    await restoreWorldBackup(INSTANCE, 'legacy');
    expect(fs.readFileSync(path.join(root, 'world_nether', 'region'), 'utf8')).toBe('keep dimension');
  });

  it('retains recovery material when Windows also refuses the rollback', async () => {
    const made = await createWorldBackup(INSTANCE);
    fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'original live world');
    const fsp = (await import('node:fs/promises')).default, rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (src, dest) => {
      if (String(src).includes('.restore-')) throw new Error('EPERM'); await rename(src, dest);
    });
    await expect(restoreWorldBackup(INSTANCE, made.id)).rejects.toThrow('original world retained');
    const root = path.dirname(worldDir()), scratch = fs.readdirSync(root).find(name => name.startsWith('.restore-'))!;
    expect(fs.readFileSync(path.join(root, scratch, 'previous-world', 'level.dat'), 'utf8')).toBe('original live world');
    const { hasInterruptedMaintenance } = await import('./maintenance-files');
    expect(hasInterruptedMaintenance(root)).toBe(true);
  });
  it('preserves the world on low space and on a failed publish after staging', async () => {
    const made = await createWorldBackup(INSTANCE);
    fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'current');
    H.free = 1;
    await expect(restoreWorldBackup(INSTANCE, made.id)).rejects.toThrow('disk-space'); H.free = null;
    const fsp = (await import('node:fs/promises')).default, rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (src, dest) => {
      if (String(src).includes('.restore-') && path.basename(String(src)) === 'world') throw new Error('EPERM');
      await rename(src, dest);
    });
    await expect(restoreWorldBackup(INSTANCE, made.id)).rejects.toThrow('EPERM');
    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('current');
    expect(fs.readdirSync(path.dirname(worldDir()))).toEqual(['world']);
  });

  it('publishes no partial backup after copy failure or low disk space', async () => {
    const fsp = (await import('node:fs/promises')).default;
    vi.spyOn(fsp, 'cp').mockImplementationOnce(async (_src, dest) => {
      fs.mkdirSync(String(dest), { recursive: true }); fs.writeFileSync(path.join(String(dest), 'partial'), 'broken');
      throw new Error('ENOSPC');
    });
    await expect(createWorldBackup(INSTANCE)).rejects.toThrow('ENOSPC');
    expect(await listWorldBackups(INSTANCE)).toEqual([]);
    H.free = 1; await expect(createWorldBackup(INSTANCE)).rejects.toThrow('disk-space');
    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('the only copy');
  });

  it('restores a custom world name and Paper dimensions together', async () => {
    const root = path.dirname(worldDir()); fs.renameSync(worldDir(), path.join(root, 'custom'));
    fs.writeFileSync(path.join(root, 'server.properties'), 'level-name=custom');
    fs.mkdirSync(path.join(root, 'custom_nether')); fs.writeFileSync(path.join(root, 'custom_nether', 'region'), 'nether original');
    const made = await createWorldBackup(INSTANCE);
    fs.writeFileSync(path.join(root, 'custom', 'level.dat'), 'changed');
    fs.writeFileSync(path.join(root, 'custom_nether', 'region'), 'changed');
    fs.mkdirSync(path.join(root, 'custom_the_end'));
    await restoreWorldBackup(INSTANCE, made.id);
    expect(fs.readFileSync(path.join(root, 'custom', 'level.dat'), 'utf8')).toBe('the only copy');
    expect(fs.readFileSync(path.join(root, 'custom_nether', 'region'), 'utf8')).toBe('nether original');
    expect(fs.existsSync(path.join(root, 'custom_the_end'))).toBe(false);
  });
  it('replaces the live world with the backup copy', async () => {
    const made = await createWorldBackup(INSTANCE, 'good state');
    fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'ruined');

    await restoreWorldBackup(INSTANCE, made.id);

    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('the only copy');
    // No leftover scratch directory beside the restored world.
    const rootEntries = fs.readdirSync(path.join(H.base, INSTANCE, 'root'));
    expect(rootEntries).toEqual(['world']);
  });

  it('refuses a traversing id', async () => {
    await expect(restoreWorldBackup(INSTANCE, '../root')).rejects.toThrow(/invalid backupId/);
    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('the only copy');
  });

  it('puts the live world back when the copy fails halfway', async () => {
    // This is the whole reason the live world is moved aside instead of deleted.
    // A restore that dies mid-copy — full disk, locked file, app quitting — must
    // not be able to leave the player with nothing.
    const made = await createWorldBackup(INSTANCE, 'good state');
    fs.writeFileSync(path.join(worldDir(), 'level.dat'), 'current world, still wanted');

    const fsp = await import('node:fs/promises');
    const spy = vi.spyOn(fsp.default, 'cp').mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(restoreWorldBackup(INSTANCE, made.id)).rejects.toThrow('ENOSPC');
    spy.mockRestore();

    expect(fs.existsSync(worldDir())).toBe(true);
    expect(fs.readFileSync(path.join(worldDir(), 'level.dat'), 'utf8')).toBe('current world, still wanted');
    const rootEntries = fs.readdirSync(path.join(H.base, INSTANCE, 'root'));
    expect(rootEntries).toEqual(['world']);
  });
});
