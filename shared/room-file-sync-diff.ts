/** Bounded, literal text preview. No HTML, automatic merge or new dependency. */
export const SYNC_DIFF_BYTES = 128 * 1024;
export const SYNC_DIFF_LINES = 400;
export type SyncTextDiff = { kind: 'text'; lines: Array<{ kind: 'same' | 'removed' | 'added'; text: string; local: number | null; incoming: number | null }> }
  | { kind: 'unavailable'; reason: 'binary' | 'large' };

export function syncTextDiff(local: Uint8Array, incoming: Uint8Array, name = ''): SyncTextDiff {
  if (local.byteLength > SYNC_DIFF_BYTES || incoming.byteLength > SYNC_DIFF_BYTES) return { kind: 'unavailable', reason: 'large' };
  if (/\.(docx?|xlsx?|pptx?|pdf|zip|7z|rar|exe|dll|png|jpe?g|gif|webp|mp[34]|db|sqlite)$/i.test(name)) return { kind: 'unavailable', reason: 'binary' };
  let before: string, after: string;
  try { before = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(local); after = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(incoming); }
  catch { return { kind: 'unavailable', reason: 'binary' }; }
  for (const c of before + after) {
    const code = c.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) return { kind: 'unavailable', reason: 'binary' };
  }
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  if (a.length > SYNC_DIFF_LINES || b.length > SYNC_DIFF_LINES) return { kind: 'unavailable', reason: 'large' };
  const width = b.length + 1, matrix = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    matrix[i * width + j] = a[i] === b[j] ? matrix[(i + 1) * width + j + 1] + 1 : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
  }
  const lines: Extract<SyncTextDiff, { kind: 'text' }>['lines'] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'same', text: a[i], local: ++i, incoming: ++j }); }
    else if (i < a.length && (j === b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) { lines.push({ kind: 'removed', text: a[i], local: ++i, incoming: null }); }
    else { lines.push({ kind: 'added', text: b[j], local: null, incoming: ++j }); }
  }
  return { kind: 'text', lines };
}
