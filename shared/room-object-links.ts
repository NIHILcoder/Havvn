export type RoomObjectLink = { kind: 'file'; id: string; name: string } | { kind: 'document'; id: string; name: string } | { kind: 'project'; rootId: string; entryId: string; name: string; revisionId?: string };
export type RoomWorkspaceObject = Exclude<RoomObjectLink, { kind: 'file' }>;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
/** Versioned plain text: old clients can display/copy it without a protocol change. */
export function roomObjectLink(value: RoomObjectLink): string {
  if (value.kind === 'project' ? !id(value.rootId) || !id(value.entryId) || value.revisionId !== undefined && !/^[a-f0-9]{64}$/i.test(value.revisionId) : !id(value.id)) throw Error('Invalid room object');
  const location = value.kind === 'project' ? `${value.rootId}/${value.entryId}` : value.id;
  // Labels never carry an absolute local path; object identifiers are opaque.
  const name = value.name.replace(/\\/g, '/').split('/').at(-1)!.replace(/[\r\n\t]/g, ' ').slice(0, 120);
  return `havvn-object://v1/${value.kind}/${location}?name=${encodeURIComponent(name)}${value.kind === 'project' && value.revisionId ? '&revision=' + value.revisionId : ''}`;
}
export function parseRoomObjectLink(text: string): RoomObjectLink | null {
  if (text.length > 2048) return null;
  try {
    const u = new URL(text), parts = u.pathname.split('/').filter(Boolean);
    if (u.protocol !== 'havvn-object:' || u.hostname !== 'v1' || u.port || u.username || u.password || u.hash || [...u.searchParams.keys()].some(k => !['name', 'revision'].includes(k)) || u.searchParams.getAll('name').length !== 1 || u.searchParams.getAll('revision').length > 1) return null;
    const name = u.searchParams.get('name')!;
    if (!name || name.length > 120 || /[\\/\r\n\t]/.test(name)) return null;
    if (parts[0] === 'project' && parts.length === 3 && id(parts[1]) && id(parts[2])) {
      const revisionId = u.searchParams.get('revision') ?? undefined;
      return revisionId === undefined || /^[a-f0-9]{64}$/i.test(revisionId) ? { kind: 'project', rootId: parts[1], entryId: parts[2], name, revisionId } : null;
    }
    return parts.length === 2 && ['file', 'document'].includes(parts[0]) && id(parts[1]) && !u.searchParams.has('revision') ? { kind: parts[0] as 'file' | 'document', id: parts[1], name } : null;
  } catch { return null; }
}
export function splitRoomObjectLinks(text: string): Array<{ text: string; link?: RoomObjectLink }> {
  const rows: Array<{ text: string; link?: RoomObjectLink }> = []; let at = 0, count = 0;
  for (const match of text.matchAll(/havvn-object:\/\/v1\/[^\s<>"']{1,2048}/g)) {
    if (++count > 16) break;
    const link = parseRoomObjectLink(match[0]); if (!link) continue;
    if (match.index! > at) rows.push({ text: text.slice(at, match.index) });
    rows.push({ text: match[0], link }); at = match.index! + match[0].length;
  }
  if (at < text.length || !rows.length) rows.push({ text: text.slice(at) });
  return rows;
}
