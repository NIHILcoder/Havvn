import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, Category } from '../../shared/types';
import { prepareDownloadDefaults } from './download-defaults';

it('checks the resolved directory before dispatch, preserves overrides and refuses removed categories', async () => {
  const temp = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(temp, 'havvn-category-'));
  try {
    const settings = { defaultDownloadDir: path.join(root, 'global'), defaultSeedRatioLimit: 2 } as AppSettings;
    const c: Category = { id: 'movies', name: 'Movies', icon: 'film', color: '#ff6600', downloadDefaults: { savePath: path.join(root, 'movies'), paused: true, seedRatioLimit: 0 } };
    const add = { sourceType: 'magnet' as const, sourceUri: 'magnet:?xt=test', categoryId: 'movies' };
    const dispatch = vi.fn();
    const resolved = await prepareDownloadDefaults(add, [c], settings); dispatch(resolved);
    expect(resolved).toMatchObject({ savePath: c.downloadDefaults!.savePath, paused: true, seedRatioLimit: 0 });
    expect((await fs.stat(resolved.savePath!)).isDirectory()).toBe(true);
    expect(await prepareDownloadDefaults({ ...add, paused: false, savePath: settings.defaultDownloadDir }, [c], settings)).toMatchObject({ paused: false, savePath: settings.defaultDownloadDir });
    dispatch.mockClear();
    const blocked = path.join(root, 'file'); await fs.writeFile(blocked, 'keep');
    await expect(prepareDownloadDefaults({ ...add, savePath: blocked }, [c], settings).then(dispatch)).rejects.toThrow('unavailable');
    await expect(prepareDownloadDefaults(add, [], settings).then(dispatch)).rejects.toThrow('Category no longer exists');
    expect(dispatch).not.toHaveBeenCalled(); expect(await fs.readFile(blocked, 'utf8')).toBe('keep');
    await expect(prepareDownloadDefaults({ ...add, savePath: 'relative' }, [c], settings)).rejects.toThrow('absolute');
  } finally {
    expect(path.dirname(root)).toBe(temp); expect(path.basename(root)).toMatch(/^havvn-category-/);
    await fs.rm(root, { recursive: true, force: true });
  }
});
