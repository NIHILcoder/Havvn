import { describe, expect, it } from 'vitest';
import { parseRoomObjectLink, roomObjectLink, splitRoomObjectLinks, type RoomObjectLink } from './room-object-links';
describe('versioned room object links', () => {
  it.each<RoomObjectLink>([{ kind: 'file', id: 'a'.repeat(40), name: 'Фильм.mp4' }, { kind: 'document', id: 'uuid-doc', name: 'Общий план' }, { kind: 'project', rootId: 'root', entryId: 'entry', name: 'App.csproj', revisionId: 'b'.repeat(64) }])('round trips $kind without room secrets or disk paths', value => {
    const text = roomObjectLink(value); expect(parseRoomObjectLink(text)).toEqual(value); expect(text).not.toContain('roomId'); expect(text).not.toContain('secret');
  });
  it('strips directory information from copied labels', () => {
    const text = roomObjectLink({ kind: 'file', id: 'file', name: 'C:\\Private\\film.mp4' });
    expect(parseRoomObjectLink(text)?.name).toBe('film.mp4'); expect(decodeURIComponent(text)).not.toContain('Private');
  });
  it.each(['https://example.com/v1/file/id?name=X', 'havvn-object://v2/file/id?name=X', 'havvn-object://user:password@v1/file/id?name=X', 'havvn-object://v1/file/..%2Fsecret?name=X', 'havvn-object://v1/file/id?name=X&roomKey=SECRET', 'havvn-object://v1/file/id?name=X&name=Y', 'havvn-object://v1/project/r/e?name=X&revision=wrong'])('keeps malformed or unsupported links as ordinary text: %s', text => {
    expect(parseRoomObjectLink(text)).toBeNull(); expect(splitRoomObjectLinks(text)).toEqual([{ text }]);
  });
  it('separates labels and caps interactive links per message', () => {
    const link = roomObjectLink({ kind: 'document', id: 'doc', name: 'Read me' });
    expect(splitRoomObjectLinks('Before ' + link + ' after').map(row => row.link?.name ?? row.text)).toEqual(['Before ', 'Read me', ' after']);
    expect(splitRoomObjectLinks(Array(50).fill(link).join(' ')).filter(row => row.link)).toHaveLength(16);
  });
});
