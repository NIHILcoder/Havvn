import { expect, it, vi } from 'vitest';
import { createDownloadUndoState } from './download-undo-state';
import type { DownloadUndoState } from '../../shared/download-removal';

it('retains a newer journal revision over an old read and shares one subscription across owners', async () => {
  const read = vi.fn().mockResolvedValue({ revision: 2, items: [] }); let finish!: (state: DownloadUndoState) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const off = vi.fn(), subscribe = vi.fn(() => off), model = createDownloadUndoState({ read, subscribe, undo: vi.fn() }, async () => {});
  const a = model.acquire(), b = model.acquire(); await model.refresh(); finish({ revision: 1, items: [] }); await Promise.resolve();
  expect(model.getSnapshot().state.revision).toBe(2); expect(subscribe).toHaveBeenCalledOnce();
  a(); a(); expect(off).not.toHaveBeenCalled(); b(); expect(off).toHaveBeenCalledOnce();
});
it('coalesces clicks and refreshes downloads only after confirmed restoration', async () => {
  let finish!: (value: { success: true; downloadId: string; warnings: [] }) => void;
  const undo = vi.fn(() => new Promise<{ success: true; downloadId: string; warnings: [] }>(resolve => { finish = resolve; }));
  const refreshed = vi.fn().mockResolvedValue(undefined), model = createDownloadUndoState({ read: async () => ({ revision: 1, items: [] }), subscribe: () => () => {}, undo }, refreshed);
  const a = model.undo('token'), b = model.undo('token'); expect(a).toBe(b); await Promise.resolve();
  expect(model.getSnapshot().pending.has('token')).toBe(true); expect(refreshed).not.toHaveBeenCalled();
  finish({ success: true, downloadId: 'id', warnings: [] }); await a;
  expect(undo).toHaveBeenCalledOnce(); expect(refreshed).toHaveBeenCalledOnce(); expect(model.getSnapshot().pending.size).toBe(0);
});
