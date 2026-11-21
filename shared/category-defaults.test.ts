import { describe, expect, it } from 'vitest';
import { applyDownloadDefaults, resolveDownloadDefaults, validateCategory, validateDownloadDefaults } from './category-defaults';
import { planSettingsImport, validateSettingsTransfer, type SettingsImportState } from './settings-transfer';
import type { AddDownloadRequest, Category } from './types';

const settings = { defaultDownloadDir: 'D:/global', defaultSeedRatioLimit: 2, defaultSeedTimeLimitMinutes: 60 };
const category: Category = { id: 'movies', name: 'Movies', icon: 'film', color: '#ff6600',
  downloadDefaults: { savePath: 'D:/movies', seedRatioLimit: 3, seedTimeLimitMinutes: 120, paused: true, sequentialDownload: true } };
const request: AddDownloadRequest = { sourceType: 'magnet', sourceUri: 'magnet:?xt=test', categoryId: 'movies' };

describe('category add defaults', () => {
  it('preserves legacy categories and the live global seed defaults', () => {
    const legacy = { ...category, downloadDefaults: undefined };
    expect(applyDownloadDefaults(request, legacy, settings)).toMatchObject({ savePath: 'D:/global', paused: false, sequentialDownload: false, seedRatioLimit: undefined, seedTimeLimitMinutes: undefined });
    expect(resolveDownloadDefaults({}, legacy, settings).sources).toEqual({ savePath: 'global', seedRatioLimit: 'global', seedTimeLimitMinutes: 'global', paused: 'global', sequentialDownload: 'global' });
  });
  it('uses explicit values, then category, then global, including zero/false', () => {
    const resolved = resolveDownloadDefaults({ savePath: 'D:/chosen', seedRatioLimit: 0, paused: false, sequentialDownload: false }, category, settings);
    expect(resolved.values).toEqual({ savePath: 'D:/chosen', seedRatioLimit: 0, seedTimeLimitMinutes: 120, paused: false, sequentialDownload: false });
    expect(resolved.sources).toMatchObject({ savePath: 'explicit', paused: 'explicit', seedTimeLimitMinutes: 'category' });
    expect(applyDownloadDefaults(request, category, settings)).toMatchObject(category.downloadDefaults!);
    expect(category.downloadDefaults!.savePath).toBe('D:/movies');
  });
  it('keeps the resolved record options independent of later category edits', () => {
    const c = structuredClone(category), result = applyDownloadDefaults(request, c, settings);
    c.downloadDefaults!.seedRatioLimit = 10;
    expect(result.seedRatioLimit).toBe(3);
  });
  it.each([
    { paused: 'false' }, { sequentialDownload: 1 }, { seedRatioLimit: -1 }, { seedRatioLimit: Infinity },
    { seedTimeLimitMinutes: .5 }, { seedTimeLimitMinutes: 52560001 }, { savePath: '' }, { savePath: 'bad\u0000path' },
  ])('rejects invalid options %j at the shared boundary', input => expect(() => validateDownloadDefaults(input)).toThrow('Invalid category'));
  it('round-trips category options through settings transfer and strips unknown fields', () => {
    const bundle = { version: 2, sections: ['categories'], settings: {}, categories: [{ ...category, unknown: 'ignored' }] };
    const portable = validateSettingsTransfer(bundle);
    expect(portable.categories).toEqual([category]);
    expect(validateSettingsTransfer(JSON.parse(JSON.stringify(portable))).categories).toEqual([category]);
    const state = { settings: { portMin: 6881, portMax: 6889 }, categories: [{ ...category, downloadDefaults: undefined }], scheduler: { enabled: false, schedules: [] }, privacyConfig: {} } as SettingsImportState;
    expect(planSettingsImport(state, portable).changes).toHaveLength(1);
    expect(() => validateSettingsTransfer({ ...bundle, categories: [{ ...category, downloadDefaults: { paused: 'yes' } }] })).toThrow();
  });
  it('validates category identity and appearance independently of options', () => {
    expect(() => validateCategory({ ...category, id: '__proto__' })).toThrow();
    expect(() => validateCategory({ ...category, color: 'red' })).toThrow();
    expect(validateCategory({ ...category, downloadDefaults: {} })).toMatchObject({ downloadDefaults: {} });
  });
});
