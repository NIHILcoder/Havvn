import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RoomManager } from '../sharing/room-manager';
type Handler = (...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), picker: vi.fn(), privateRoot: '' }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => mocks.handlers.set(name, handler) }, dialog: { showSaveDialog: mocks.picker }, app: { getPath: () => mocks.privateRoot } }));
import { registerRoomDocumentsIpc } from './room-documents';
const room = '11111111-1111-4111-8111-111111111111', token = '22222222-2222-4222-8222-222222222222', member = 'a'.repeat(32), hash = 'b'.repeat(64);
const mainFrame = {}, sender = { mainFrame }, window = { webContents: sender }, trusted = { sender, senderFrame: mainFrame };
const service = { requestAccess: vi.fn(), dismissAccess: vi.fn(), create: vi.fn(), open: vi.fn(), poll: vi.fn(), update: vi.fn(), closeDocument: vi.fn(), presence: vi.fn(), changePolicy: vi.fn(), history: vi.fn(), snapshot: vi.fn(), keepDraft: vi.fn(), restoreSnapshot: vi.fn(), reviewDraft: vi.fn(),
  exportText: vi.fn(async () => ({ title: 'Notes', language: 'markdown', text: 'a private draft' })), current: vi.fn(() => true) };
const manager = { documents: vi.fn(() => service), documentsView: vi.fn() };
let directory: string;
const invoke = (name: string, ...args: unknown[]) => Promise.resolve().then(() => mocks.handlers.get('rooms:docs' + name)!(...args));
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-docs-ipc-')); mocks.privateRoot = path.join(directory, 'profile'); fs.mkdirSync(mocks.privateRoot);
  service.current.mockReturnValue(true); mocks.picker.mockResolvedValue({ canceled: false, filePath: path.join(directory, 'document.md') });
  registerRoomDocumentsIpc(window as unknown as BrowserWindow, manager as unknown as RoomManager);
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
it('authenticates the window and top-level frame for every documents IPC method', async () => {
  const names = ['View', 'Create', 'Open', 'Poll', 'Update', 'Close', 'Presence', 'Policy', 'History', 'Snapshot', 'KeepDraft', 'Restore', 'Review', 'Export', 'RequestAccess', 'DismissAccess'];
  for (const name of names) for (const event of [{ sender: { mainFrame }, senderFrame: mainFrame }, { sender, senderFrame: {} }]) await expect(invoke(name, event, room, token)).rejects.toThrow('Untrusted');
  expect(manager.documents).not.toHaveBeenCalled(); expect(manager.documentsView).not.toHaveBeenCalled(); expect(mocks.picker).not.toHaveBeenCalled();
});
it('bounds IDs, text, writers, update bytes, cursor data and policy versions before use', async () => {
  await expect(invoke('View', trusted, '../room')).rejects.toThrow('Invalid');
  await expect(invoke('Open', trusted, room, '../file')).rejects.toThrow('Invalid');
  for (const text of ['\0', 'я'.repeat(140000)]) await expect(invoke('Create', trusted, room, 'Notes', 'text', text, [member])).rejects.toThrow('Invalid');
  await expect(invoke('Create', trusted, room, 'Notes', 'text', '', Array(33).fill(member))).rejects.toThrow('Invalid');
  await expect(invoke('Update', trusted, room, token, 'a'.repeat(600000))).rejects.toThrow('Invalid');
  await expect(invoke('Presence', trusted, room, token, { clientId: -1, anchor: null, head: null })).rejects.toThrow('Invalid');
  await expect(invoke('Policy', trusted, room, token, 'not-hash', 'Notes', [member], false)).rejects.toThrow('Invalid');
  await expect(invoke('RequestAccess', trusted, room, token, 'invalid')).rejects.toThrow('Invalid');
  await expect(invoke('DismissAccess', trusted, room, token, '../request')).rejects.toThrow('Invalid');
  await expect(invoke('Poll', trusted, room, token, Infinity)).rejects.toThrow('Invalid'); expect(manager.documents).not.toHaveBeenCalled();
});
it('passes validated inputs to the room-scoped document service', async () => {
  await invoke('Create', trusted, room, 'Notes', 'text', 'Hello', [member]); expect(service.create).toHaveBeenCalledWith('Notes', 'text', 'Hello', [member]);
  await invoke('Policy', trusted, room, token, hash, 'New name', [member], false); expect(service.changePolicy).toHaveBeenCalledWith(token, hash, 'New name', [member], false);
  await invoke('RequestAccess', trusted, room, token, hash); expect(service.requestAccess).toHaveBeenCalledWith(token, hash);
  await invoke('DismissAccess', trusted, room, token, token); expect(service.dismissAccess).toHaveBeenCalledWith(token, token);
  await invoke('KeepDraft', trusted, room, token, 'Local text'); expect(service.keepDraft).toHaveBeenCalledWith(token, 'Local text');
});
it('exports main-process text into a new explicitly selected file', async () => {
  expect(await invoke('Export', trusted, room, token)).toBe(true); expect(fs.readFileSync(path.join(directory, 'document.md'), 'utf8')).toBe('a private draft');
  await expect(invoke('Export', trusted, room, token)).rejects.toThrow(); expect(fs.readFileSync(path.join(directory, 'document.md'), 'utf8')).toBe('a private draft');
});
it('cancels exports and refuses application storage and stale contexts', async () => {
  mocks.picker.mockResolvedValueOnce({ canceled: true }); expect(await invoke('Export', trusted, room, token)).toBe(false);
  mocks.picker.mockResolvedValueOnce({ canceled: false, filePath: path.join(mocks.privateRoot, 'private.md') }); await expect(invoke('Export', trusted, room, token)).rejects.toThrow('outside');
  service.current.mockReturnValue(false); await expect(invoke('Export', trusted, room, token)).rejects.toThrow('context'); expect(fs.existsSync(path.join(directory, 'document.md'))).toBe(false);
});
