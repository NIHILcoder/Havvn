import { expect, it } from 'vitest';
import { checkRuTrackerPage, parseRuTrackerSearch, ruTrackerMagnet, ruTrackerQuery, rutrackerBase } from './rutracker';
import { mergeResults } from './search-dedupe';

const row = (id: number, title = 'Фильм &amp; сериал') => `<tr id='trs-tr-${id}' data-topic_id='${id}'>
<td class='f-name'><a href='tracker.php?f=3'>Кино</a></td><td class='t-title'><a href='viewtopic.php?t=${id}'>${title}</a></td>
<td class='tor-size' data-ts_text='1048576'>1 MB</td><td class='seedmed'><b>12</b></td><td class='leechmed'>3</td></tr>`;
it('extracts topics, decoded titles, sizes and counts without requiring magnet links', () => {
  const page = parseRuTrackerSearch(`<table id='tor-tbl'>${row(42)}${row(43)}</table><a href='tracker.php?nm=test&amp;start=50'>2</a><a href='tracker.php?start=100'>3</a>`);
  expect(page.results).toHaveLength(2); expect(page.results[0]).toEqual({ id: '42', title: 'Фильм & сериал', category: 'Кино', size: 1048576, seeds: 12, leechers: 3 });
  expect(page.nextOffset).toBe(50);
});
it('accepts valid empty searches but refuses login, captcha and unrecognized pages', () => {
  expect(parseRuTrackerSearch('<a href="login.php?logout=1">Выход</a>').results).toEqual([]);
  expect(() => checkRuTrackerPage('<input name="login_username"><input name="login_password">')).toThrow();
  expect(() => checkRuTrackerPage('<input name="cap_sid">')).toThrow();
  expect(() => checkRuTrackerPage('<html>Access denied</html>')).toThrow();
  expect(() => parseRuTrackerSearch('<table id="tor-tbl"><tr id="trs-tr-4"><td>changed markup</td></tr></table>')).toThrow();
});
it('only advances to bounded numeric page offsets and deduplicates repeated topics', () => {
  const page = parseRuTrackerSearch(`<table id='tor-tbl'>${row(1)}${row(1)}</table><a href='tracker.php?start=0'>1</a><a href='tracker.php?start=50'>2</a><a href='tracker.php?start=100'>3</a><a href='tracker.php?start=999999999'>bad</a>`, 50);
  expect(page.results).toHaveLength(1); expect(page.nextOffset).toBe(100);
});
it('reads counts from nested seed/leech labels rather than requiring special table-cell classes', () => {
  const html = `<table id="tor-tbl">${row(1).replace("<td class='seedmed'><b>12</b></td>", "<td class='row4'><b class='seedmed'>1 234</b></td>")}</table>`;
  expect(parseRuTrackerSearch(html).results[0].seeds).toBe(1234);
});
it('prefers the topic title over an earlier icon linking to the same topic', () => {
  const html = `<table id="tor-tbl">${row(3).replace("<td class='t-title'>", "<td><a href='viewtopic.php?t=3'><img src='icon.png'></a></td><td class='t-title'>")}</table>`;
  expect(parseRuTrackerSearch(html).results[0].title).toBe('Фильм & сериал');
});
it('encodes a Russian query as Windows-1251 bytes and never interpolates query syntax', () => {
  expect(ruTrackerQuery('Ёж & +')).toBe('%A8%E6%20%26%20%2B');
  expect(() => ruTrackerQuery('film 🎬')).toThrow(/unsupported/);
});
it('extracts only valid magnets, decoding parameter entities', () => {
  const hash = 'a'.repeat(40);
  expect(ruTrackerMagnet(`<a href='magnet:?xt=urn:btih:${hash}&amp;dn=Title'>Magnet</a>`)).toBe(`magnet:?xt=urn:btih:${hash}&dn=Title`);
  expect(ruTrackerMagnet('<a href="login.php?logout=1">Logout</a><a href="magnet:?xt=urn:btih:bad">bad</a>')).toBeUndefined();
});
it('normalizes HTTPS source roots and rejects credentials, endpoints and downgraded mirrors', () => {
  expect(rutrackerBase('https://mirror.test')).toBe('https://mirror.test/forum');
  expect(rutrackerBase('https://mirror.test/forum/')).toBe('https://mirror.test/forum');
  for (const url of ['http://mirror.test/forum', 'https://user:password@mirror.test', 'https://mirror.test/forum/login.php', 'https://mirror.test?key=secret']) expect(() => rutrackerBase(url)).toThrow();
});
it('keeps unresolved lookalike topics separate while repeat pages update one topic', () => {
  const base = { title: 'Film', size: 100, seeds: 1, leechers: 0, provider: 'RuTracker' };
  const first = mergeResults([], [{ ...base, deferredSource: 'source:1' }, { ...base, deferredSource: 'source:2' }]);
  const second = mergeResults(first, [{ ...base, deferredSource: 'source:1', seeds: 5 }, { ...base, provider: 'Other', infoHash: 'a'.repeat(40) }]);
  expect(second).toHaveLength(3); expect(second[0].sourceCount).toBe(1); expect(second[0].seeds).toBe(5); expect(first[0].seeds).toBe(1);
});
