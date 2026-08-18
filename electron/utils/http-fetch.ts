/**
 * Shared HTTP(S) fetcher for the feed-ish services (RSS, search providers).
 *
 * Both services grew their own copy of "get a URL as text", and both copies had
 * the same four holes:
 *   - redirects followed recursively with no hop limit and no resolution against
 *     the base URL, so a relative `Location` threw "Invalid URL" and a redirect
 *     cycle looped forever;
 *   - no scheme allow-list, so a redirect could walk off http(s);
 *   - no cap on the response body, so a hostile/broken endpoint could buffer
 *     hundreds of MB into memory;
 *   - the body was accumulated with `data += chunk`, which calls Buffer#toString
 *     per chunk — a multi-byte character split across a chunk boundary became
 *     "�". That corrupted every Cyrillic feed and tracker title.
 *
 * This module is the one fixed implementation. It deliberately does NOT do
 * conditional GET or compression yet — those land with the RSS caching work
 * (plan phase 3.5) and slot into `headers` / `onResponse` without changing
 * callers.
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { TextDecoder } from 'util';
import { IncomingHttpHeaders, IncomingMessage } from 'http';

/** Redirect hops we follow before giving up. */
const MAX_REDIRECTS = 5;

/** Default ceiling on a response body. Feeds and API pages are far below this. */
const MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 20000;

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Reject once the body exceeds this many bytes. Defaults to 10 MB. */
  maxBytes?: number;
  /** Redirect hops to follow. Defaults to 5. */
  maxRedirects?: number;
  /** Label used in error messages, e.g. "RSS feed" -> "HTTP 404 fetching RSS feed". */
  what?: string;
}

export interface HttpFetchResult {
  body: Buffer;
  status: number;
  headers: IncomingHttpHeaders;
  /** The URL the body actually came from (after redirects). */
  url: string;
}

/** Only ever talk HTTP(S) — never file:, data:, or anything a redirect suggests. */
function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  return parsed;
}

/**
 * GET a URL and return the raw bytes. Follows redirects (capped, resolved
 * against the current URL, re-validated for scheme) and enforces a body cap.
 */
export function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<HttpFetchResult> {
  const {
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    maxRedirects = MAX_REDIRECTS,
    what = 'resource',
  } = options;

  const fetchOnce = (current: string, hopsLeft: number): Promise<HttpFetchResult> =>
    new Promise((resolve, reject) => {
      const parsed = assertFetchableUrl(current);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.get(current, { headers, timeout: timeoutMs }, (res: IncomingMessage) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain, or the socket is never released
          if (hopsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${what}`));
            return;
          }
          let next: string;
          try {
            // Relative Location is legal and common — resolve against the URL we
            // just asked, not against nothing.
            next = new URL(res.headers.location, current).toString();
          } catch {
            reject(new Error(`Bad redirect target fetching ${what}`));
            return;
          }
          fetchOnce(next, hopsLeft - 1).then(resolve).catch(reject);
          return;
        }

        if (status >= 400) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching ${what}`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Kill the socket rather than keep buffering something oversized.
            req.destroy();
            reject(new Error(`Response too large fetching ${what}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ body: Buffer.concat(chunks), status, headers: res.headers, url: current });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${what}`));
      });
    });

  return fetchOnce(url, maxRedirects);
}

/** GET a URL and decode it to text using the charset the server/document declares. */
export async function httpFetchText(url: string, options: HttpFetchOptions = {}): Promise<string> {
  const res = await httpFetch(url, options);
  return decodeBody(res.body, String(res.headers['content-type'] || ''));
}

/**
 * Decode a response body to a string, honouring (in order): the Content-Type
 * charset, a BOM, and an XML/HTML declaration. Trackers in the RU/CN world still
 * serve windows-1251 / gbk feeds, and Buffer#toString would mangle them.
 */
export function decodeBody(buf: Buffer, contentType = ''): string {
  const charset =
    charsetFromContentType(contentType) ||
    charsetFromBOM(buf) ||
    charsetFromDeclaration(buf) ||
    'utf-8';

  let text: string;
  try {
    text = new TextDecoder(charset).decode(buf);
  } catch {
    // Unknown label (or one ICU doesn't carry) — UTF-8 is the safe default.
    text = new TextDecoder('utf-8').decode(buf);
  }

  // A decoded BOM survives as U+FEFF and breaks strict XML parsers / regexes
  // anchored at the start of the document.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function charsetFromContentType(contentType: string): string | null {
  const m = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i);
  return m ? m[1].toLowerCase() : null;
}

function charsetFromBOM(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return null;
}

function charsetFromDeclaration(buf: Buffer): string | null {
  // The declaration is ASCII by definition, so a latin1 peek at the head is safe
  // regardless of the document's real encoding.
  const head = buf.subarray(0, 1024).toString('latin1');
  const xml = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i);
  if (xml) return xml[1].toLowerCase();
  const meta = head.match(/<meta[^>]*charset\s*=\s*["']?([\w-]+)/i);
  if (meta) return meta[1].toLowerCase();
  return null;
}
