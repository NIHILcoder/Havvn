import { describe, expect, it } from 'vitest';
import { parseDownloadLink } from './download-link';
import { extractInfoHashFromMagnet } from './magnet';

const hash = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
describe('explicit download link', () => {
  it('passes a magnet to the existing add flow with its tracker and display name intact', () => {
    const source = `magnet:?xt=urn:btih:${hash}&dn=Example%20file&tr=http%3A%2F%2F127.0.0.1%3A9999%2Fannounce`;
    const result = parseDownloadLink('  ' + source + '  ');
    expect(result?.sourceType).toBe('magnet');
    expect(extractInfoHashFromMagnet(result!.sourceUri)).toBe(hash);
    const query = new URL(result!.sourceUri).searchParams;
    expect(query.get('dn')).toBe('Example file'); expect(query.get('tr')).toBe('http://127.0.0.1:9999/announce');
  });
  it('normalizes uppercase and percent-encoded xt for both engines', () => {
    const result = parseDownloadLink(`MAGNET:?XT=${encodeURIComponent('urn:btih:' + hash)}`);
    expect(result).toEqual({ sourceType: 'magnet', sourceUri: `magnet:?xt=urn:btih:${hash}` });
  });
  it('supports the same base32 hash as a hex magnet', () => {
    const result = parseDownloadLink('magnet:?xt=urn:btih:3WBFL3G4PSSV7MF37AJSHWDQMLNR63I4');
    expect(extractInfoHashFromMagnet(result!.sourceUri)).toBe(hash);
  });
  it('keeps encoded delimiters in a name from injecting new parameters', () => {
    const result = parseDownloadLink(`magnet:?xt=urn:btih:${hash}&dn=Example%26tr%3Dhttps%3A%2F%2Fexample.test`)!;
    expect(new URL(result.sourceUri).searchParams.has('tr')).toBe(false);
  });
  it.each(['http://127.0.0.1:4567/fixture.torrent', 'https://example.test/download?id=1'])('accepts a direct torrent URL: %s', source => {
    expect(parseDownloadLink(source)).toEqual({ sourceType: 'torrent_file', sourceUri: source });
  });
  it.each(['', ' ', 'not a link', 'javascript:alert(1)', 'file:///D:/private.torrent', 'ftp://example.test/a.torrent',
    'magnet:?dn=missing-hash', 'magnet:?xt=urn:btih:deadbeef', `magnet:garbage?xt=urn:btih:${hash}`,
    `magnet:?xt=urn:btih:${hash}X`, `magnet:?xt=urn:btih:${hash}\nhttps://example.test/other`,
    'https://example.test/' + 'x'.repeat(10_000)])('rejects invalid, unsupported or multiple links: %s', source => {
    expect(parseDownloadLink(source)).toBeNull();
  });
});
