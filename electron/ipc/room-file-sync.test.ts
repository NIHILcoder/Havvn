import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RoomManager } from '../sharing/room-manager';
type Handler = (...args: unknown[]) => Promise<unknown>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), pick: vi.fn(), save: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) },
  dialog: { showOpenDialog: mocks.pick, showSaveDialog: mocks.save }, BrowserWindow: { getFocusedWindow: () => null } }));
import { registerRoomFileSyncIpc } from './room-file-sync';
const roomId = '11111111-1111-4111-8111-111111111111', rootId = '22222222-2222-4222-8222-222222222222';
const frame = {}, sender = { mainFrame: frame }, main = { webContents: sender };
const event = { sender, senderFrame: frame };
const manager = { fileSyncView: vi.fn(() => ({ enabled: true, canCreate: true, roots: [] })), fileSyncFiles: vi.fn(),
  prepareFileSyncMove: vi.fn(), confirmFileSyncMove: vi.fn(),
  fileSyncPathConflict: vi.fn(), prepareFileSyncPathResolution: vi.fn(), confirmFileSyncPathResolution: vi.fn(),
  fileSyncMetadata: vi.fn(), exportFileSyncMetadata: vi.fn(), importFileSyncMetadata: vi.fn(), confirmFileSyncMetadata: vi.fn(),
  prepareFileSyncDelete: vi.fn(), confirmFileSyncDelete: vi.fn(),
  fileSyncMissing: vi.fn(), prepareFileSyncMissingDelete: vi.fn(),
  previewFileSyncTrash: vi.fn(), fileSyncTrashPage: vi.fn(), confirmFileSyncTrash: vi.fn(), exportFileSyncTrash: vi.fn(),
  previewFileSyncLog: vi.fn(), confirmFileSyncLog: vi.fn(),
  previewFileSyncCheckpoint: vi.fn(), confirmFileSyncCheckpoint: vi.fn(), fetchFileSyncHistory: vi.fn(),
  chooseFileSyncFolder: vi.fn(async (_room, _choice, pick) => pick()), confirmFileSyncFolder: vi.fn(), fileSyncAction: vi.fn(),
  previewFileSyncBackups: vi.fn(), fileSyncBackupPage: vi.fn(), confirmFileSyncBackups: vi.fn(),
  previewFileSyncFilters: vi.fn(), fileSyncFilterPage: vi.fn(), confirmFileSyncFilters: vi.fn() };
const invoke = (name: string, from: unknown, ...args: unknown[]) => mocks.handlers.get('rooms:' + name)!(from, ...args);
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear();
  mocks.pick.mockResolvedValue({ canceled: false, filePaths: ['C:\\fixture\\chosen'] });
  mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:\\fixture\\export.havvn-history' });
  registerRoomFileSyncIpc(main as unknown as BrowserWindow, manager as unknown as RoomManager);
});
it('rejects foreign windows, subframes and invalid room IDs before any operation', async () => {
  await expect(invoke('syncState', { sender: { mainFrame: frame }, senderFrame: frame }, roomId)).rejects.toThrow('Untrusted');
  await expect(invoke('syncState', { sender, senderFrame: {} }, roomId)).rejects.toThrow('Untrusted');
  await expect(invoke('syncState', event, '../other')).rejects.toThrow('Invalid'); expect(manager.fileSyncView).not.toHaveBeenCalled();
});
it('validates history downloads as read-only requests from the trusted frame', async () => {
  await expect(invoke('syncHistoryFetch', { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
  for (const invalid of ['../escape', null, 'a'.repeat(64)]) await expect(invoke('syncHistoryFetch', event, roomId, rootId, invalid)).rejects.toThrow('Invalid');
  expect(manager.fetchFileSyncHistory).not.toHaveBeenCalled();
  await invoke('syncHistoryFetch', event, roomId, rootId, rootId); expect(manager.fetchFileSyncHistory).toHaveBeenCalledWith(roomId, rootId, rootId);
});
it('accepts move tokens and relative paths only from the trusted frame', async () => {
  for (const name of ['syncMovePreview', 'syncMoveConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId, 'valid.ini')).rejects.toThrow('Untrusted');
  for (const invalid of [null, '../outside.ini', 'C:/outside.ini', 'nested/CON', '.havvn-sync/private']) await expect(invoke('syncMovePreview', event, roomId, rootId, rootId, invalid)).rejects.toThrow('Invalid');
  await expect(invoke('syncRights', event, roomId, rootId, undefined, 'yes')).rejects.toThrow('Invalid');
  expect(manager.prepareFileSyncMove).not.toHaveBeenCalled();
  await invoke('syncMovePreview', event, roomId, rootId, rootId, 'nested/new.ini');
  expect(manager.prepareFileSyncMove).toHaveBeenCalledWith(roomId, rootId, rootId, 'nested/new.ini');
});
it('allows only generated trash operation IDs and review tokens from the trusted frame', async () => {
  for (const name of ['syncTrashPreview', 'syncTrashPage', 'syncTrashConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
  for (const selected of [null, {}, ['../previous'], ['op-a', 'op-a'], ['C:/outside'], [1]]) await expect(invoke('syncTrashPreview', event, roomId, rootId, selected)).rejects.toThrow('Invalid');
  await expect(invoke('syncTrashPreview', event, roomId, rootId, Array.from({ length: 101 }, (_, i) => 'op-' + i))).rejects.toThrow('Invalid');
  for (const offset of [-1, 0.5, '0']) await expect(invoke('syncTrashPage', event, roomId, rootId, offset)).rejects.toThrow('Invalid');
  await expect(invoke('syncTrashConfirm', event, roomId, '../token')).rejects.toThrow('Invalid');
  expect(manager.previewFileSyncTrash).not.toHaveBeenCalled();
  await invoke('syncTrashPreview', event, roomId, rootId, ['op-abc']); expect(manager.previewFileSyncTrash).toHaveBeenCalledWith(roomId, rootId, ['op-abc']);
  await invoke('syncTrashPage', event, roomId, rootId, 100); expect(manager.fileSyncTrashPage).toHaveBeenCalledWith(roomId, rootId, 100);
  await invoke('syncTrashConfirm', event, roomId, rootId); expect(manager.confirmFileSyncTrash).toHaveBeenCalledWith(roomId, rootId);
});
it('exports only through a native picker after validating frame, room, preview and operation IDs', async () => {
  for (const untrusted of [{ sender: { mainFrame: frame }, senderFrame: frame }, { sender, senderFrame: {} }]) await expect(invoke('syncTrashExport', untrusted, roomId, rootId, 'op-abc')).rejects.toThrow('Untrusted');
  for (const id of [null, '../escape', 'op-', 'op-' + 'a'.repeat(129), 'C:/outside']) await expect(invoke('syncTrashExport', event, roomId, rootId, id)).rejects.toThrow('Invalid');
  await expect(invoke('syncTrashExport', event, roomId, '../preview', 'op-abc')).rejects.toThrow('Invalid');
  expect(manager.exportFileSyncTrash).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  manager.exportFileSyncTrash.mockImplementation(async (_room, _preview, _operation, pick) => pick('config.ini'));
  expect(await invoke('syncTrashExport', event, roomId, rootId, 'op-abc')).toBe('C:\\fixture\\export.havvn-history');
  expect(mocks.save).toHaveBeenCalledWith(main, expect.objectContaining({ defaultPath: 'config.ini' }));
  mocks.save.mockResolvedValueOnce({ canceled: true }); expect(await invoke('syncTrashExport', event, roomId, rootId, 'op-abc')).toBeNull();
});
it('allows only one trash save dialog at a time and releases it on error', async () => {
  let finish!: (value: { canceled: boolean }) => void;
  manager.exportFileSyncTrash.mockImplementation(async (_room, _preview, _operation, pick) => pick('config.ini'));
  mocks.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = invoke('syncTrashExport', event, roomId, rootId, 'op-abc');
  await expect(invoke('syncTrashExport', event, roomId, rootId, 'op-def')).rejects.toThrow('already open'); finish({ canceled: true }); await pending;
  mocks.save.mockRejectedValueOnce(new Error('picker failed')); await expect(invoke('syncTrashExport', event, roomId, rootId, 'op-abc')).rejects.toThrow('picker failed');
  await expect(invoke('syncTrashExport', event, roomId, rootId, 'op-abc')).resolves.toBeTruthy();
});
it('validates disk deletion reviews, hashes and explicit mass acknowledgement in the trusted frame', async () => {
  for (const name of ['syncMissing', 'syncMissingDeletePreview']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId, 'a'.repeat(64), true)).rejects.toThrow('Untrusted');
  await expect(invoke('syncMissing', event, roomId, '../path')).rejects.toThrow('Invalid');
  for (const hash of [null, rootId, '../path']) await expect(invoke('syncMissingDeletePreview', event, roomId, rootId, rootId, hash, false)).rejects.toThrow('Invalid');
  for (const ack of [undefined, null, 'true', 1]) await expect(invoke('syncMissingDeletePreview', event, roomId, rootId, rootId, 'a'.repeat(64), ack)).rejects.toThrow('Invalid');
  expect(manager.prepareFileSyncMissingDelete).not.toHaveBeenCalled();
  await invoke('syncMissing', event, roomId, rootId); expect(manager.fileSyncMissing).toHaveBeenCalledWith(roomId, rootId);
  await invoke('syncMissingDeletePreview', event, roomId, rootId, rootId, 'a'.repeat(64), false);
  expect(manager.prepareFileSyncMissingDelete).toHaveBeenCalledWith(roomId, rootId, rootId, 'a'.repeat(64), false);
});
it('requires the main frame, UUIDs and explicit boolean choices for deletion', async () => {
  for (const name of ['syncDeletePreview', 'syncDeleteConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
  await expect(invoke('syncDeletePreview', event, roomId, rootId, '../path')).rejects.toThrow('Invalid');
  await expect(invoke('syncDeletePreview', event, roomId, rootId, rootId, 'true')).rejects.toThrow('Invalid');
  await expect(invoke('syncDeleteConfirm', event, roomId, rootId, 'keep')).rejects.toThrow('Invalid');
  await expect(invoke('syncRights', event, roomId, rootId, undefined, undefined, 'yes')).rejects.toThrow('Invalid');
  await expect(invoke('syncFiles', event, roomId, rootId, 0, 'yes')).rejects.toThrow('Invalid');
  expect(manager.prepareFileSyncDelete).not.toHaveBeenCalled(); expect(manager.confirmFileSyncDelete).not.toHaveBeenCalled();
  await invoke('syncDeletePreview', event, roomId, rootId, rootId, true); expect(manager.prepareFileSyncDelete).toHaveBeenCalledWith(roomId, rootId, rootId, true);
  await invoke('syncDeleteConfirm', event, roomId, rootId, false); expect(manager.confirmFileSyncDelete).toHaveBeenCalledWith(roomId, rootId, false);
});
it('takes history files only from native pickers and validates passwords, root IDs and retention counts', async () => {
  const password = 'fixture history password';
  for (const name of ['syncMetadata', 'syncMetadataExport', 'syncMetadataImport', 'syncMetadataConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, password)).rejects.toThrow('Untrusted');
  for (const keep of [-1, 9, 1.5, null, '0', NaN]) await expect(invoke('syncMetadata', event, roomId, rootId, keep)).rejects.toThrow('Invalid');
  for (const name of ['syncMetadataExport', 'syncMetadataImport']) for (const bad of ['', 'short', null, {}, 'a'.repeat(1025)]) await expect(invoke(name, event, roomId, rootId, bad)).rejects.toThrow('password');
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.pick).not.toHaveBeenCalled();
  await invoke('syncMetadata', event, roomId, rootId, 0); expect(manager.fileSyncMetadata).toHaveBeenCalledWith(roomId, rootId, 0);
  await invoke('syncMetadataExport', event, roomId, rootId, password, 'C:\\injected');
  expect(manager.exportFileSyncMetadata).toHaveBeenCalledWith(roomId, rootId, password, 'C:\\fixture\\export.havvn-history');
  await invoke('syncMetadataImport', event, roomId, rootId, password, 'C:\\injected');
  expect(manager.importFileSyncMetadata).toHaveBeenCalledWith(roomId, rootId, password, 'C:\\fixture\\chosen');
  mocks.save.mockResolvedValue({ canceled: true }); mocks.pick.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await invoke('syncMetadataExport', event, roomId, rootId, password)).toBeNull(); expect(await invoke('syncMetadataImport', event, roomId, rootId, password)).toBeNull();
  await invoke('syncMetadataConfirm', event, roomId, rootId); expect(manager.confirmFileSyncMetadata).toHaveBeenCalledWith(roomId, rootId);
});
it('validates conflict IDs, signed version hashes, free relative paths and confirmation tokens', async () => {
  for (const name of ['syncPathConflict', 'syncPathPreview', 'syncPathConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
  await expect(invoke('syncPathConflict', event, roomId, rootId, '../entry')).rejects.toThrow('Invalid');
  for (const hash of [null, '../version', rootId]) await expect(invoke('syncPathPreview', event, roomId, rootId, rootId, hash, 'new.ini')).rejects.toThrow('Invalid');
  for (const p of [null, '../outside', 'C:/outside', '.havvn-sync/private', 'CON']) await expect(invoke('syncPathPreview', event, roomId, rootId, rootId, 'a'.repeat(64), p)).rejects.toThrow('Invalid');
  await expect(invoke('syncPathConfirm', event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  expect(manager.prepareFileSyncPathResolution).not.toHaveBeenCalled();
  await invoke('syncPathConflict', event, roomId, rootId, rootId); expect(manager.fileSyncPathConflict).toHaveBeenCalledWith(roomId, rootId, rootId);
  await invoke('syncPathPreview', event, roomId, rootId, rootId, 'a'.repeat(64), 'new.ini'); expect(manager.prepareFileSyncPathResolution).toHaveBeenCalledWith(roomId, rootId, rootId, 'a'.repeat(64), 'new.ini');
  await invoke('syncPathConfirm', event, roomId, rootId); expect(manager.confirmFileSyncPathResolution).toHaveBeenCalledWith(roomId, rootId);
});
it('compacts only a reviewed local journal selected by identifiers from the trusted frame', async () => {
  for (const name of ['syncLogPreview', 'syncLogConfirm']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
    await expect(invoke(name, event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  }
  expect(manager.confirmFileSyncLog).not.toHaveBeenCalled();
  await invoke('syncLogPreview', event, roomId, rootId); expect(manager.previewFileSyncLog).toHaveBeenCalledWith(roomId, rootId);
  await invoke('syncLogConfirm', event, roomId, rootId); expect(manager.confirmFileSyncLog).toHaveBeenCalledWith(roomId, rootId);
});
it('accepts checkpoint review and confirmation only from the trusted frame with UUID tokens', async () => {
  for (const name of ['syncCheckpointPreview', 'syncCheckpointConfirm']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
    await expect(invoke(name, event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  }
  expect(manager.confirmFileSyncCheckpoint).not.toHaveBeenCalled();
  await invoke('syncCheckpointPreview', event, roomId, rootId); expect(manager.previewFileSyncCheckpoint).toHaveBeenCalledWith(roomId, rootId);
});
it('rejects malformed rights and foreign frames before forwarding owner authority', async () => {
  for (const name of ['syncRights', 'syncRightsConfirm']) await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
  for (const writers of [null, [], ['bad'], ['a'.repeat(32), 'a'.repeat(32)], Array(17).fill('a'.repeat(32))]) {
    await expect(invoke('syncRights', event, roomId, rootId, writers)).rejects.toThrow('Invalid');
  }
  await expect(invoke('syncRightsConfirm', event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
});
it('accepts editor identifiers only from the main frame and rejects injected paths, binary and oversized text', async () => {
  for (const name of ['syncEditorOpen', 'syncEditorSave', 'syncEditorClose']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
    await expect(invoke(name, event, roomId, 'C:\\injected', rootId)).rejects.toThrow('Invalid');
  }
  await expect(invoke('syncEditorOpen', event, roomId, rootId, '../file')).rejects.toThrow('Invalid');
  for (const text of [null, {}, '\u0000', '\ud800', 'я'.repeat(1024 * 1024)]) await expect(invoke('syncEditorSave', event, roomId, rootId, text)).rejects.toThrow('Invalid');
});
it('takes the local path only from the native dialog and treats cancel as no selection', async () => {
  expect(await invoke('syncChoose', event, roomId, { kind: 'bind', rootId, path: 'C:\\injected' })).toBe('C:\\fixture\\chosen');
  mocks.pick.mockResolvedValue({ canceled: true, filePaths: [] });
  expect(await invoke('syncChoose', event, roomId, { kind: 'create', name: 'Configs' })).toBeNull();
});
it('rejects malformed choices, consent values and paging before calling the manager', async () => {
  await expect(invoke('syncChoose', event, roomId, { kind: 'create', name: '' })).rejects.toThrow('Invalid');
  await expect(invoke('syncAction', event, roomId, rootId, 'auto-apply', 'yes')).rejects.toThrow('Invalid');
  await expect(invoke('syncAction', event, roomId, rootId, 'unknown')).rejects.toThrow('Invalid');
  await expect(invoke('syncAction', event, roomId, rootId, 'mode-sync', true)).rejects.toThrow('Invalid');
  await expect(invoke('syncAction', { sender, senderFrame: {} }, roomId, rootId, 'mode-sync')).rejects.toThrow('Untrusted');
  await expect(invoke('syncAction', event, roomId, rootId, 'cancel-work', true)).rejects.toThrow('Invalid');
  await expect(invoke('syncFiles', event, roomId, rootId, -1)).rejects.toThrow('Invalid');
  await expect(invoke('syncConfirm', event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  expect(manager.fileSyncAction).not.toHaveBeenCalled(); expect(manager.confirmFileSyncFolder).not.toHaveBeenCalled();
});
it('routes preparation cancellation only through the checked room action', async () => {
  await invoke('syncAction', event, roomId, rootId, 'cancel-work');
  expect(manager.fileSyncAction).toHaveBeenCalledWith(roomId, rootId, 'cancel-work', undefined);
});
it('validates history, restore and cache operations before granting access to the manager', async () => {
  for (const name of ['syncHistory', 'syncRestorePreview', 'syncRestoreConfirm', 'syncCache']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
  }
  await expect(invoke('syncHistory', event, roomId, rootId, rootId, -1)).rejects.toThrow('Invalid');
  await expect(invoke('syncHistory', event, roomId, rootId, '../file')).rejects.toThrow('Invalid');
  await expect(invoke('syncRestorePreview', event, roomId, rootId, 'C:\\file')).rejects.toThrow('Invalid');
  await expect(invoke('syncRestoreConfirm', event, roomId, 'C:\\file')).rejects.toThrow('Invalid');
  for (const limit of [-1, Infinity, 0.1, '100', 101 * 1024 ** 3]) await expect(invoke('syncCache', event, roomId, rootId, limit)).rejects.toThrow('Invalid');
});
it('rejects untrusted conflict requests and renderer-supplied paths or invalid actions', async () => {
  for (const name of ['syncConflictPreview', 'syncConflictConfirm', 'syncConflictDefer']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId, rootId)).rejects.toThrow('Untrusted');
  }
  await expect(invoke('syncConflictPreview', event, roomId, rootId, 'C:\\injected')).rejects.toThrow('Invalid');
  await expect(invoke('syncConflictDefer', event, roomId, rootId, '../file')).rejects.toThrow('Invalid');
  await expect(invoke('syncConflictConfirm', event, roomId, rootId, 'overwrite')).rejects.toThrow('Invalid');
  await expect(invoke('syncConflictConfirm', event, roomId, 'C:\\injected', 'accept')).rejects.toThrow('Invalid');
});
it('accepts backup review tokens only from the main frame and rejects injected paths, limits and pages', async () => {
  for (const name of ['syncBackups', 'syncBackupPage', 'syncBackupConfirm']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
    await expect(invoke(name, event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  }
  const policy = { enabled: false, keepVersions: 2, maxAgeDays: 0, limitBytes: 0 };
  for (const invalid of [null, {}, { ...policy, path: 'C:\\injected' }, { ...policy, enabled: 1 }, { ...policy, limitBytes: Infinity }, { ...policy, keepVersions: 1001 }]) {
    await expect(invoke('syncBackups', event, roomId, rootId, invalid)).rejects.toThrow('Invalid');
  }
  await expect(invoke('syncBackupPage', event, roomId, rootId, -1)).rejects.toThrow('Invalid');
  await expect(invoke('syncBackupPage', event, roomId, rootId, 100001)).rejects.toThrow('Invalid');
  expect(manager.previewFileSyncBackups).not.toHaveBeenCalled(); expect(manager.confirmFileSyncBackups).not.toHaveBeenCalled();
  await invoke('syncBackups', event, roomId, rootId, policy); expect(manager.previewFileSyncBackups).toHaveBeenCalledWith(roomId, rootId, policy);
  await invoke('syncBackupConfirm', event, roomId, rootId); expect(manager.confirmFileSyncBackups).toHaveBeenCalledWith(roomId, rootId);
});
it('guards exclusion previews, pattern budgets, paging and token confirmation before manager access', async () => {
  for (const name of ['syncFilters', 'syncFilterPage', 'syncFilterConfirm']) {
    await expect(invoke(name, { sender, senderFrame: {} }, roomId, rootId)).rejects.toThrow('Untrusted');
    await expect(invoke(name, event, roomId, 'C:\\injected')).rejects.toThrow('Invalid');
  }
  for (const rules of [null, {}, ['../x'], ['C:/x'], ['**x'], ['A', 'a']]) await expect(invoke('syncFilters', event, roomId, rootId, rules)).rejects.toThrow('Invalid');
  await expect(invoke('syncFilterPage', event, roomId, rootId, 12001)).rejects.toThrow('Invalid');
  expect(manager.previewFileSyncFilters).not.toHaveBeenCalled(); expect(manager.confirmFileSyncFilters).not.toHaveBeenCalled();
  await invoke('syncFilters', event, roomId, rootId, ['*.log']); expect(manager.previewFileSyncFilters).toHaveBeenCalledWith(roomId, rootId, ['*.log']);
  await invoke('syncFilterConfirm', event, roomId, rootId); expect(manager.confirmFileSyncFilters).toHaveBeenCalledWith(roomId, rootId);
});
