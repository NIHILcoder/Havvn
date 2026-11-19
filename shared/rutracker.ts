import { decodeEntities } from './feed-parse';
import { ProviderNetworkError } from './provider-network';

export const RUTRACKER_URL = 'https://rutracker.net/forum';
export function rutrackerBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/(?:forum\/?)?$/.test(url.pathname)) throw new Error('Invalid RuTracker address');
  return url.origin + '/forum';
}
const clean = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const attr = (html: string, name: string) => decodeEntities(html.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? '');
export function checkRuTrackerPage(html: string): void {
  if (/\b(?:cap_sid|g-recaptcha|h-captcha|cf-chl-|challenge-platform)\b|<(?:input|img|iframe)[^>]*(?:captcha|recaptcha)/i.test(html)) throw new ProviderNetworkError('captcha');
  if (/name\s*=\s*["']login_username["']/i.test(html) && /name\s*=\s*["']login_password["']/i.test(html)) throw new ProviderNetworkError('auth');
  if (!/(?:login|tracker)\.php\?logout|id\s*=\s*["'](?:tor-tbl|search-results)["']|magnet:\?xt=urn:btih:/i.test(html)) throw new ProviderNetworkError('invalid-response');
}
export function ruTrackerQuery(query: string): string {
  const decoder = new TextDecoder('windows-1251');
  const codes = new Map(Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte] as const));
  return Array.from(query).map(char => {
    const byte = codes.get(char);
    if (byte === undefined) throw new Error('RuTracker query contains unsupported characters');
    return '%' + byte.toString(16).padStart(2, '0').toUpperCase();
  }).join('');
}
export function parseRuTrackerSearch(html: string, currentOffset = 0) {
  checkRuTrackerPage(html);
  const results: Array<{ id: string; title: string; size: number; seeds: number; leechers: number; category: string }> = [];
  const seen = new Set<string>();
  for (const block of html.split(/<tr\b[^>]*\bid\s*=\s*["']trs-tr-/i).slice(1)) {
    const row = block.split(/<\/tr\s*>/i)[0];
    const links = [...row.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)];
    const topics = links.filter(link => /(?:^|\/)viewtopic\.php\?t=\d+(?:&|$)/i.test(attr(link[0], 'href')) && clean(link[0]));
    const topic = topics.find(link => attr(link[0], 'class').split(/\s+/).includes('tLink')) ?? topics[0];
    if (!topic) continue;
    const id = attr(topic[0], 'href').match(/[?&]t=(\d+)/)?.[1], title = clean(topic[0]);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const cells = [...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td\s*>/gi)].map(cell => cell[0]);
    const cell = (name: string) => cells.find(value => attr(value, 'class').split(/\s+/).includes(name)) ?? '';
    const sizeCell = cell('tor-size'), exact = attr(sizeCell, 'data-ts_text');
    const human = clean(sizeCell).match(/([\d.,]+)\s*([KMGT]?B|[КМГТ]?Б)/i);
    const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, 'Б': 1, 'КБ': 1024, 'МБ': 1024 ** 2, 'ГБ': 1024 ** 3, 'ТБ': 1024 ** 4 };
    const size = /^\d+$/.test(exact) ? Number(exact) : human ? Number(human[1].replace(',', '.')) * (units[human[2].toUpperCase()] ?? 1) : 0;
    const count = (name: string) => {
      const tag = [...row.matchAll(/<([a-z][a-z\d]*)\b[^>]*>/gi)].find(match => attr(match[0], 'class').split(/\s+/).includes(name));
      const content = tag ? row.slice(tag.index! + tag[0].length).split(new RegExp(`</${tag[1]}\\s*>`, 'i'))[0] : '';
      const value = Number(clean(content).replace(/[^\d]/g, '')) || 0;
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    results.push({ id, title, size: Number.isFinite(size) && size >= 0 && size <= Number.MAX_SAFE_INTEGER ? Math.floor(size) : 0, seeds: count('seedmed'), leechers: count('leechmed'), category: clean(cell('f-name')) });
  }
  if (!results.length && /\bid\s*=\s*["']trs-tr-/i.test(html)) throw new ProviderNetworkError('invalid-response');
  const offsets = [...html.matchAll(/<a\b[^>]*>/gi)].flatMap(link => {
    const href = attr(link[0], 'href');
    if (!/(?:^|\/)tracker\.php\?/i.test(href)) return [];
    const offset = Number(href.match(/[?&]start=(\d+)(?:&|$)/)?.[1]);
    return Number.isSafeInteger(offset) && offset > currentOffset && offset <= 100000 ? [offset] : [];
  });
  return { results, nextOffset: offsets.length ? Math.min(...offsets) : undefined };
}
export function ruTrackerMagnet(html: string): string | undefined {
  checkRuTrackerPage(html);
  for (const link of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(link[0], 'href');
    if (/^magnet:\?xt=urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})(?:&|$)/i.test(href)) return href;
  }
  return undefined;
}
