/** Device-local, additive exclusions. No regular expressions or allow/negation rules. */
export const SYNC_FILTER_LIMIT = 64;
export function validSyncExclusions(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > SYNC_FILTER_LIMIT || Array.from(value).some(p => typeof p !== 'string')) return false;
  const rules = value as string[];
  return rules.join('\n').length <= 8192 && new Set(rules.map(p => p.normalize('NFC').toLowerCase())).size === rules.length
    && rules.every(p => p.length > 0 && p.length <= 256 && p === p.trim() && !Array.from(p).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '\\:![]{}'.includes(c))
      && p.split('/').length <= 16 && p.split('/').every(s => !!s && s !== '.' && s !== '..' && (!s.includes('**') || s === '**')));
}
const DEFAULTS = new Set(['.git', '.hg', '.svn', '.vs', '.idea', 'node_modules', 'bin', 'obj', 'dist', 'build']);
export type SyncExclusionReason = 'system' | 'default' | 'rule';
export interface SyncExclusion { reason: SyncExclusionReason; rule?: string }
function segment(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === value;
  const p = Array.from(pattern), v = Array.from(value); let i = 0, j = 0, star = -1, resume = 0;
  while (j < v.length) {
    if (p[i] === '?' || p[i] === v[j]) { i++; j++; }
    else if (p[i] === '*') { star = i++; resume = j; }
    else if (star >= 0) { i = star + 1; j = ++resume; }
    else return false;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}
function matches(pattern: string, parts: string[]): boolean {
  const tokens = pattern.split('/');
  if (tokens.length === 1) return parts.some(part => tokens[0] === '**' || segment(tokens[0], part));
  // Each prefix represents an ancestor directory; excluded directories exclude their subtree.
  let reachable = Array<boolean>(parts.length + 1).fill(false); reachable[0] = true;
  for (const token of tokens) {
    const next = Array<boolean>(parts.length + 1).fill(false); let open = false;
    for (let at = 0; at <= parts.length; at++) {
      if (token === '**') { open ||= reachable[at]; next[at] = open; }
      else if (reachable[at] && at < parts.length && segment(token, parts[at])) next[at + 1] = true;
    }
    if (!next.some(Boolean)) return false;
    reachable = next;
  }
  return reachable.some(Boolean);
}
export function syncPathExclusion(relative: string, rules: readonly string[] = []): SyncExclusion | null {
  const parts = relative.normalize('NFC').toLowerCase().split('/');
  if (parts.some(part => /^\.havvn-/i.test(part))) return { reason: 'system' };
  if (parts.some(part => DEFAULTS.has(part) || /^(?:~\$|\.~|\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/i.test(part)
    || /(?:\.(?:tmp|temp|swp|swx|part|crdownload|key|pem|pfx|p12)|~)$/i.test(part))) return { reason: 'default' };
  const rule = rules.find(p => matches(p.normalize('NFC').toLowerCase(), parts));
  return rule === undefined ? null : { reason: 'rule', rule };
}
export interface SyncFilterRow {
  path: string; size: number | null; directory: boolean; source: 'local' | 'shared';
  reason: 'included' | SyncExclusionReason | 'invalid' | 'linked' | 'size' | 'type'; rule?: string;
  change?: 'include' | 'exclude';
}
export interface SyncFilterPreview {
  rootId: string; previewId: string; rules: string[]; publisher: boolean;
  included: number; skipped: number; sharedIncluded: number; sharedSkipped: number;
  items: SyncFilterRow[]; next: number | null;
  scanError?: string;
}
