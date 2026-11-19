import fs from 'node:fs';
import crypto from 'node:crypto';
import { SYNC_EDITOR_BYTES, validSyncEditorText } from '../../shared/room-file-sync-editor';
import { assertSyncPlainPath } from './room-sync-snapshot';

export async function readSyncEditorFile(file: string) {
  assertSyncPlainPath(file);
  const handle = await fs.promises.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > SYNC_EDITOR_BYTES) throw new Error('Editor requires a regular UTF-8 file of at most 1 MiB');
    const buffer = Buffer.alloc(SYNC_EDITOR_BYTES + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat(); assertSyncPlainPath(file); const linked = await fs.promises.stat(file);
    if (length > SYNC_EDITOR_BYTES || before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || linked.dev !== after.dev || linked.ino !== after.ino || linked.nlink !== 1) throw new Error('Editor file changed while reading');
    const bytes = buffer.subarray(0, length), bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes); }
    catch { throw new Error('Editor supports UTF-8 only; keep other encodings in the external editor'); }
    const crlf = raw.includes('\r\n');
    if (/\r(?!\n)/.test(raw) || crlf && /(?<!\r)\n/.test(raw)) throw new Error('Mixed line endings require an external editor');
    const text = raw.replace(/\r\n/g, '\n');
    if (!validSyncEditorText(text)) throw new Error('Editor cannot open binary or unsupported text');
    return { text, bom, newline: crlf ? 'crlf' as const : 'lf' as const, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

export function encodeSyncEditorFile(text: unknown, newline: 'lf' | 'crlf', bom: boolean): Buffer {
  if (!validSyncEditorText(text)) throw new Error('Editor text is invalid or exceeds 1 MiB');
  const bytes = Buffer.from((bom ? '\uFEFF' : '') + (newline === 'crlf' ? text.replace(/\n/g, '\r\n') : text), 'utf8');
  if (bytes.length > SYNC_EDITOR_BYTES) throw new Error('Editor text exceeds 1 MiB after encoding');
  return bytes;
}
