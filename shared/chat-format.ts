/**
 * Chat message formatting — splits a message body into text and fenced-code
 * segments. Pure and dependency-free so it unit-tests without a DOM and could be
 * reused by the engine (e.g. notification previews) if ever needed.
 *
 * Supported syntax: triple-backtick fences on their own lines:
 *   ```
 *   code here
 *   ```
 * An optional language tag after the opening fence (```bat) is accepted and
 * DISCARDED (no highlighting — the tag just must not leak into the code body).
 * An unclosed fence swallows the rest of the message as code (forgiving — people
 * forget the closing fence). Everything else renders as plain text; whitespace
 * preservation is the renderer's job (white-space: pre-wrap).
 */

export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string };

export function parseChatSegments(body: string): ChatSegment[] {
  const src = String(body ?? '');
  if (!src.includes('```')) return src ? [{ kind: 'text', text: src }] : [];
  const segments: ChatSegment[] = [];
  const lines = src.split('\n');
  let buf: string[] = [];
  let inCode = false;
  const flush = (kind: 'text' | 'code') => {
    const text = buf.join('\n');
    buf = [];
    // Drop empty TEXT runs (an empty line between two fences); keep empty code
    // blocks out too — an empty fence pair renders as nothing.
    if (text.trim() || (kind === 'code' && text)) segments.push({ kind, text });
  };
  for (const line of lines) {
    // A fence line: ``` optionally followed by a language tag (no spaces inside).
    if (/^```[^`]*$/.test(line.trim())) {
      flush(inCode ? 'code' : 'text');
      inCode = !inCode;
      continue;
    }
    buf.push(line);
  }
  flush(inCode ? 'code' : 'text'); // unclosed fence → rest is code
  // Everything was stripped (a body of bare fences like '```') — fall back to the
  // raw text so the message never renders as an empty bubble.
  if (segments.length === 0) return [{ kind: 'text', text: src }];
  return segments;
}

/** True when the message benefits from a copy button (code or multiline). */
export function isCopyworthy(body: string): boolean {
  const s = String(body ?? '');
  return s.includes('```') || s.includes('\n');
}

/** A run of plain text or a clickable link inside a TEXT chat segment. */
export type TextRun =
  | { kind: 'plain'; text: string }
  | { kind: 'link'; text: string; href: string };

// http(s) only — the scheme allow-list IS the safety gate (no javascript:,
// file:, etc. can ever match). Applied to TEXT segments only, never to code.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
// Punctuation people type right after a URL ("see https://x.com, ok") — not
// part of the link. A ')' is kept only while the URL has an unmatched '('.
const TRAIL_RE = /[.,;:!?…»›"']+$/;

/**
 * Split a plain-text run into text/link runs for rendering. Pure and
 * DOM-free; the renderer decides what a link run becomes (an <a> that the
 * main process routes to the system browser).
 */
export function splitLinks(text: string): TextRun[] {
  const src = String(text ?? '');
  const runs: TextRun[] = [];
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(src); m; m = URL_RE.exec(src)) {
    let url = m[0];
    // Trim trailing punctuation, then unbalanced closing parens, repeatedly —
    // "(see https://a.b/c)." peels ')' then '.'.
    for (;;) {
      const trimmed = url.replace(TRAIL_RE, '');
      if (trimmed !== url) { url = trimmed; continue; }
      if (url.endsWith(')')) {
        const opens = (url.match(/\(/g) || []).length;
        const closes = (url.match(/\)/g) || []).length;
        if (closes > opens) { url = url.slice(0, -1); continue; }
      }
      break;
    }
    if (/^https?:\/\/$/i.test(url)) continue; // a bare scheme is not a link
    if (m.index > last) runs.push({ kind: 'plain', text: src.slice(last, m.index) });
    runs.push({ kind: 'link', text: url, href: url });
    last = m.index + url.length;
  }
  if (last < src.length) runs.push({ kind: 'plain', text: src.slice(last) });
  if (runs.length === 0 && src) runs.push({ kind: 'plain', text: src });
  return runs;
}
