import { describe, it, expect } from 'vitest';
import { decodeBody } from './http-fetch';

/**
 * The charset half of the fetcher is the part that was actually broken: bodies
 * used to be accumulated with `data += chunk`, so any multi-byte character that
 * straddled a chunk boundary decoded to U+FFFD, and a non-UTF-8 document was
 * mojibake from the first byte.
 */
describe('decodeBody', () => {
  it('decodes UTF-8 by default', () => {
    const buf = Buffer.from(' Subtitle пример 日本語', 'utf8');
    expect(decodeBody(buf)).toBe(' Subtitle пример 日本語');
  });

  it('keeps a multi-byte character intact when it spans chunks', () => {
    // What the old `data += chunk` reader mangled: split "п" down the middle and
    // concatenate the halves back into one buffer, as the socket would.
    const whole = Buffer.from('Сезон 1, серия 2', 'utf8');
    const cut = 3; // lands inside a two-byte Cyrillic character
    const rejoined = Buffer.concat([whole.subarray(0, cut), whole.subarray(cut)]);

    expect(decodeBody(rejoined)).toBe('Сезон 1, серия 2');
    expect(decodeBody(rejoined)).not.toContain('�');
  });

  it('honours the charset from Content-Type', () => {
    const buf = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    expect(decodeBody(buf, 'text/xml; charset=windows-1251')).toBe('Привет');
    expect(decodeBody(buf, 'text/xml; charset="windows-1251"')).toBe('Привет');
  });

  it('falls back to the XML declaration when the header says nothing', () => {
    const head = Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><rss><title>`, 'latin1');
    const body = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const tail = Buffer.from('</title></rss>', 'latin1');

    const text = decodeBody(Buffer.concat([head, body, tail]));
    expect(text).toContain('Привет');
  });

  it('prefers the header over the declaration', () => {
    const xml = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><t>é</t>', 'utf8');
    expect(decodeBody(xml, 'application/xml; charset=utf-8')).toContain('é');
  });

  it('strips a UTF-8 BOM so parsers do not choke on U+FEFF', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<rss/>', 'utf8')]);
    const text = decodeBody(buf);
    expect(text).toBe('<rss/>');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('reads UTF-16 documents via their BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<rss/>', 'utf16le')]);
    expect(decodeBody(buf)).toBe('<rss/>');
  });

  it('falls back to UTF-8 on an unknown charset label instead of throwing', () => {
    const buf = Buffer.from('plain', 'utf8');
    expect(decodeBody(buf, 'text/xml; charset=not-a-real-encoding')).toBe('plain');
  });

  it('handles an empty body', () => {
    expect(decodeBody(Buffer.alloc(0))).toBe('');
  });
});
