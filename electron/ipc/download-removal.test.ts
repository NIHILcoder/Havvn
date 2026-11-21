import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { Download } from '../../shared/types';
import type { DownloadRemovalSnapshot } from '../../shared/download-removal';

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn) } }));
import { registerDownloadRemovalIpc } from './download-removal';
const frame = {}, sender = { mainFrame: frame, send: vi.fn() }, win = { isDestroyed: () => false, webContents: sender };
const event = { sender, senderFrame: frame };
let dispose: (() => void) | undefined;
beforeEach(() => { mocks.handlers.clear(); vi.clearAllMocks(); });
afterEach(() => dispose?.());
function fixture() {
  const snapshot = { download: { id: 'download', name: 'Visible name', status: 'downloading', sourceUri: 'PRIVATE_MAGNET', savePath: 'PRIVATE_PATH' } as Download,
    signature: 'PRIVATE_SIGNATURE', metadata: 'PRIVATE_METADATA', files: [], existingFiles: [] } satisfies DownloadRemovalSnapshot;
  const engine = { captureDownloadRemoval: vi.fn(async () => snapshot), removeDownload: vi.fn().mockResolvedValue(undefined),
    restoreRemovedDownload: vi.fn().mockResolvedValue({ warnings: [] }), activateRestoredDownload: vi.fn().mockResolvedValue(undefined) };
  const warnings = vi.fn().mockResolvedValue([]);
  const registered = registerDownloadRemovalIpc(() => win as unknown as BrowserWindow, engine, warnings); dispose = registered.dispose;
  return { ...registered, engine, warnings, snapshot };
}
it('restricts deletion previews to the main frame and validates IDs before capture', async () => {
  const f = fixture(), preview = mocks.handlers.get('downloads:deletePreview')!;
  expect(() => preview({ sender: {}, senderFrame: frame }, 'download')).toThrow('Untrusted');
  expect(() => preview({ sender, senderFrame: {} }, 'download')).toThrow('Untrusted');
  expect(() => preview(event, { id: 'download' })).toThrow('Invalid download id');
  expect(f.engine.captureDownloadRemoval).not.toHaveBeenCalled();
  const result = await preview(event, 'download');
  expect(result).toMatchObject({ downloadId: 'download', name: 'Visible name', files: [] });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});
it('only accepts the current main frame and exposes no restore snapshot to the renderer', async () => {
  const f = fixture(); const removed = await f.journal.remove('download', false);
  const list = mocks.handlers.get('downloads:undo:list')!;
  expect(() => list({ sender: {}, senderFrame: frame })).toThrow('Untrusted');
  expect(() => list({ sender, senderFrame: {} })).toThrow('Untrusted');
  expect(JSON.stringify(list(event))).not.toContain('PRIVATE');
  const undo = mocks.handlers.get('downloads:undo')!;
  expect(() => undo(event, { snapshot: f.snapshot })).toThrow('Invalid undo token');
  expect((await undo(event, removed.undo!.token)).success).toBe(true);
  expect(sender.send).toHaveBeenCalledWith('downloads:undo:changed');
});
it('checks protection after engine verification and never resumes a formerly paused record', async () => {
  const f = fixture(); const removed = await f.journal.remove('download', false);
  let finish!: (value: { warnings: [] }) => void;
  f.engine.restoreRemovedDownload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const work = f.journal.undo(removed.undo!.token);
  await vi.waitFor(() => expect(f.engine.restoreRemovedDownload).toHaveBeenCalledOnce());
  expect(f.warnings).toHaveBeenCalledOnce(); f.warnings.mockResolvedValue(['vpn']); finish({ warnings: [] });
  expect(await work).toMatchObject({ success: true, warnings: ['vpn'] }); expect(f.engine.activateRestoredDownload).not.toHaveBeenCalled();
  f.snapshot.download.status = 'paused'; const paused = await f.journal.remove('download', false);
  await f.journal.undo(paused.undo!.token); expect(f.warnings).toHaveBeenCalledTimes(3);
});
it('restores only the record when current protection disallows even paused engine discovery', async () => {
  const f = fixture(); f.warnings.mockResolvedValue(['vpn']);
  const removed = await f.journal.remove('download', false);
  expect(await f.journal.undo(removed.undo!.token)).toMatchObject({ success: true, warnings: ['vpn'] });
  expect(f.engine.restoreRemovedDownload).toHaveBeenCalledWith(f.snapshot, true);
  expect(f.engine.activateRestoredDownload).not.toHaveBeenCalled();
});
it('restores the record but does not resume when verification detected changed data', async () => {
  const f = fixture(); f.engine.restoreRemovedDownload.mockResolvedValue({ warnings: ['data-changed'] });
  const removed = await f.journal.remove('download', false);
  expect(await f.journal.undo(removed.undo!.token)).toMatchObject({ success: true, warnings: ['data-changed'] });
  expect(f.engine.activateRestoredDownload).not.toHaveBeenCalled();
});
