import { expect, it } from 'vitest';
import { captureDeviceLocal } from './device-capture';
import { targetFixture } from '../research/device-pairing/data-fixture';
import { DEFAULT_VIEW_CONFIG, DOWNLOAD_VIEWS_KEY } from './download-views';
import { DEVICE_TARGET_META } from './device-data-target';
import { DeviceVault } from '../electron/devices/vault';
import { memoryDeviceStorage } from '../research/device-pairing/vault-fixture';
async function fixture() {
  const v = await DeviceVault.initialize(memoryDeviceStorage().io());
  const f = targetFixture(v); await v.close();
  return f;
}
it('captures only approved preference keys; invalid and network values cannot cross the boundary', async () => {
  const f = await fixture();
  f.values.set('language', 'ru'); f.values.set('uiScale', '999'); f.values.set('proxy', 'secret');
  const c = captureDeviceLocal(f.storage, ['preferences'], f.context, () => '1'.repeat(32), () => {});
  expect(c.records).toEqual([{ scope: 'preferences', recordId: 'language', value: 'ru', deleted: false }]);
  expect(c.issues).toEqual([{ scope: 'preferences', recordId: 'uiScale', code: 'invalid' }]);
  expect(f.values.has(DEVICE_TARGET_META)).toBe(false);
});
it('assigns stable portable view IDs, exports category aliases and excludes local paths', async () => {
  const f = await fixture(); let id = 0;
  f.context.exportCategories = { movies: 'a'.repeat(64) };
  f.values.set(DOWNLOAD_VIEWS_KEY, JSON.stringify({ version: 1, activeId: 'local', views: [
    { id: 'local', name: 'Фильмы', pinned: false, ...DEFAULT_VIEW_CONFIG, conditions: { ...DEFAULT_VIEW_CONFIG.conditions, category: 'movies' } },
    { id: 'private', name: 'Private', pinned: false, ...DEFAULT_VIEW_CONFIG, conditions: { ...DEFAULT_VIEW_CONFIG.conditions, path: 'D:/private' } },
  ] }));
  const capture = () => captureDeviceLocal(f.storage, ['views'], f.context, () => (++id).toString(16).padStart(32, '0'), () => {});
  const first = capture(); expect(capture()).toEqual(first); expect(id).toBe(2);
  expect(JSON.stringify(first.records)).not.toMatch(/D:|private|"movies"/);
  expect(JSON.stringify(first.records)).toContain('a'.repeat(64));
  expect(first.issues[0].code).toBe('path-filter');
  expect(JSON.parse(f.values.get(DOWNLOAD_VIEWS_KEY)!).activeId).toBe('local');
});
it('does not mutate view metadata after revocation', async () => {
  const f = await fixture();
  expect(() => captureDeviceLocal(f.storage, ['views'], f.context, () => '1'.repeat(32), () => { throw Error('revoked'); })).toThrow('revoked');
  expect(f.values.has(DEVICE_TARGET_META)).toBe(false);
});
