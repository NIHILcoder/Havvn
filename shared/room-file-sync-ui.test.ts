import { expect, it } from 'vitest';
import { syncFolderStatus, syncMode, type SyncRootView } from './room-file-sync-ui';
const root: SyncRootView = { rootId: 'folder', name: 'Project', path: '/project', paused: false, publisher: true, files: 2, pending: 0, conflicts: 0, autoApply: true, autoPublish: true };
it('distinguishes all four modes', () => {
  expect(syncMode(root)).toBe('sync'); expect(syncMode({ autoApply: false, autoPublish: true })).toBe('send');
  expect(syncMode({ autoApply: true, autoPublish: false })).toBe('receive'); expect(syncMode({ autoApply: false, autoPublish: false })).toBe('manual');
});
it('never presents missing files, conflicts, lost rights or transfer work as ready', () => {
  expect(syncFolderStatus(root)).toBe('ready');
  for (const [changes, status] of [[{ path: null }, 'connect'], [{ conflicts: 1 }, 'conflict'], [{ error: 'failed' }, 'error'],
    [{ notice: 'rights-changed' }, 'rights'], [{ receiving: 1 }, 'working'], [{ waiting: 1 }, 'waiting'], [{ pending: 1 }, 'waiting'], [{ paused: true }, 'unavailable']] as const) {
    expect(syncFolderStatus({ ...root, ...changes })).toBe(status);
  }
});
