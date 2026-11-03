/** Local editor contract. Text and guards never enter room gossip. */
export const SYNC_EDITOR_BYTES = 1024 * 1024;
export type SyncEditorLanguage = 'text' | 'markdown' | 'json' | 'xml';
export function syncEditorLanguage(file: string): SyncEditorLanguage | null {
  const ext = file.split('/').at(-1)?.split('.').at(-1)?.toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') return 'json';
  if (['xml', 'csproj', 'props', 'targets', 'config', 'svg'].includes(ext ?? '')) return 'xml';
  return ['txt', 'ini', 'cfg', 'conf', 'jsonc', 'yaml', 'yml', 'cs', 'sln', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'log', 'toml', 'sql', 'sh', 'ps1', 'bat', 'csv', 'tsv'].includes(ext ?? '') ? 'text' : null;
}
export interface SyncEditorDraft {
  token: string; rootId: string; entryId: string; path: string; text: string; language: SyncEditorLanguage;
  revisionId: string; writable: boolean; newline: 'lf' | 'crlf'; bom: boolean; localChanges: boolean;
}
/** Reject lossy encodings and binary/control data rather than silently rewriting them. */
export function validSyncEditorText(text: unknown): text is string {
  // eslint-disable-next-line no-control-regex -- Binary controls must be rejected before editing.
  return typeof text === 'string' && text.length <= SYNC_EDITOR_BYTES && !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(text)
    && new TextEncoder().encode(text).length <= SYNC_EDITOR_BYTES;
}
