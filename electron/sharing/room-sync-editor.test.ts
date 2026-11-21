import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { encodeSyncEditorFile, readSyncEditorFile } from './room-sync-editor';
import { SYNC_EDITOR_BYTES, syncEditorLanguage, validSyncEditorText } from '../../shared/room-file-sync-editor';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-text-editor-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });
it.each([false, true])('round-trips UTF-8, BOM and CRLF without changing bytes (BOM %s)', async bom => {
  const file = path.join(directory, 'note.md'), bytes = Buffer.from((bom ? '\uFEFF' : '') + '# Заметка\r\nПривет 👋\r\n'); fs.writeFileSync(file, bytes);
  const read = await readSyncEditorFile(file);
  expect(read.text).toBe('# Заметка\nПривет 👋\n'); expect(read.newline).toBe('crlf'); expect(read.bom).toBe(bom);
  expect(encodeSyncEditorFile(read.text, read.newline, read.bom)).toEqual(bytes);
});
it('refuses invalid UTF-8, binary controls, mixed endings, linked files and oversized text', async () => {
  const file = path.join(directory, 'file.txt');
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from('a\0b'), Buffer.from('a\r\nb\nc'), Buffer.alloc(SYNC_EDITOR_BYTES + 1, 97)]) {
    fs.writeFileSync(file, bytes); await expect(readSyncEditorFile(file)).rejects.toThrow();
  }
  fs.writeFileSync(file, 'text'); fs.linkSync(file, path.join(directory, 'alias.txt'));
  await expect(readSyncEditorFile(file)).rejects.toThrow('Linked');
  expect(() => encodeSyncEditorFile('\ud800', 'lf', false)).toThrow();
  expect(() => encodeSyncEditorFile('x\r\ny', 'crlf', false)).toThrow();
  expect(() => encodeSyncEditorFile('\n'.repeat(SYNC_EDITOR_BYTES), 'crlf', true)).toThrow('encoding');
  expect(validSyncEditorText('я'.repeat(SYNC_EDITOR_BYTES))).toBe(false);
});
it('uses explicit text formats and never treats Office archives as text', () => {
  expect(syncEditorLanguage('a/note.MD')).toBe('markdown'); expect(syncEditorLanguage('a/project.csproj')).toBe('xml');
  expect(syncEditorLanguage('a/config.json')).toBe('json'); expect(syncEditorLanguage('a/config.ini')).toBe('text');
  expect(syncEditorLanguage('document.docx')).toBeNull(); expect(syncEditorLanguage('table.xlsx')).toBeNull();
});
