import type { RawReleaseDetails, ReleaseTextBlock } from './search-release-details';

/** Self-contained: runs in the browser's isolated world, never the app renderer. */
export function extractRuTrackerDetails(doc: Document, pageUrl: string): RawReleaseDetails {
  const body = doc.querySelector('.post_body');
  const clean = (text: string, limit = 4000) => text.replace(/\p{Cc}|[\u202a-\u202e\u2066-\u2069]/gu,
    char => char === '\n' || char === '\r' || char === '\t' ? char : '').trim().slice(0, limit);
  const title = clean(doc.querySelector('#topic-title, .maintitle, h1')?.textContent ?? '', 500);
  const result: RawReleaseDetails = { available: !!body, title, blocks: [], images: [], truncated: false };
  if (!body) return result;
  let buffer = '', characters = 0, visited = 0;
  const flush = (kind: ReleaseTextBlock['kind'] = 'paragraph') => {
    const normalized = kind === 'code' ? buffer : buffer.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
    if (normalized.trim().length > 8000) result.truncated = true;
    const text = clean(normalized, 8000);
    buffer = '';
    if (!text) return;
    if (result.blocks.length >= 250 || characters >= 60000) { result.truncated = true; return; }
    const bounded = text.slice(0, 60000 - characters); characters += bounded.length;
    result.blocks.push({ kind, text: bounded });
    if (bounded.length !== text.length) result.truncated = true;
  };
  const visit = (node: Node, depth: number) => {
    if (++visited > 12000 || depth > 64 || characters >= 60000 || result.blocks.length >= 250) { result.truncated = true; return; }
    if (node.nodeType === 3) { const text = node.nodeValue ?? ''; if (text.length > 8000) result.truncated = true; buffer += text.slice(0, 8000); return; }
    if (node.nodeType !== 1) return;
    const el = node as Element, tag = el.tagName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'form', 'button', 'input', 'select', 'textarea', 'noscript'].includes(tag)
      || el.matches('.signature, .post_btn, .attach_link, [hidden]')) return;
    if (tag === 'br') { buffer += '\n'; return; }
    if (['img', 'var'].includes(tag)) return;
    const block = /^(?:p|div|tr|ul|ol|li|blockquote|pre|h[1-6]|hr)$/.test(tag);
    if (block) flush();
    if (tag === 'li') buffer += '• ';
    if (tag === 'pre') { const text = el.textContent ?? ''; if (text.length > 8000) result.truncated = true; buffer = text.slice(0, 8000); flush('code'); return; }
    for (const child of Array.from(el.childNodes)) visit(child, depth + 1);
    if (block) flush(/^h[1-6]$/.test(tag) ? 'heading' : 'paragraph');
  };
  visit(body, 0); flush();
  const seen = new Set<string>();
  for (const el of Array.from(body.querySelectorAll('img, var.postImg')).slice(0, 100)) {
    if (result.images.length >= 9) { result.truncated = true; break; }
    if (el.matches('.smile, .smilies, .avatar') || el.closest('.signature, .post_btn')) continue;
    const value = el.getAttribute('data-src') || (el.tagName.toLowerCase() === 'var' ? el.getAttribute('title') : el.getAttribute('src'));
    if (!value || value.length > 2048) continue;
    try {
      const thumbnail = new URL(value, pageUrl), link = el.closest('a')?.getAttribute('href');
      const full = link ? new URL(link, pageUrl) : undefined;
      const url = full && /\.(?:jpe?g|png|webp)$/i.test(full.pathname) ? full : thumbnail;
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || /(?:smil|icon|banner|avatar)|\.gif$/i.test(url.pathname)) continue;
      const width = Number(el.getAttribute('width')), height = Number(el.getAttribute('height'));
      if (width > 0 && height > 0 && width <= 64 && height <= 64) continue;
      url.hash = '';
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      result.images.push({ url: url.href, label: clean(el.getAttribute('alt') ?? '', 160),
        poster: /postImgAligned|img-right|img-left/i.test(el.className) || height > width * 1.2 && width > 0 });
    } catch { /* Invalid source markup is omitted. */ }
  }
  if (result.images.length && !result.images.some(image => image.poster)) result.images[0].poster = true;
  // Only one cover; the rest belong to the gallery.
  let cover = false;
  for (const image of result.images) { if (image.poster && !cover) cover = true; else image.poster = false; }
  return result;
}
