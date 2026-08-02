/**
 * The ONE place game-server bytes enter this machine. Everything a module wants
 * downloaded goes through here, and this module refuses to hand back a file
 * whose digest does not match what the plan declared.
 *
 * Centralising it is the whole point: hash verification cannot be "forgotten" by
 * a module author, because a module has no other way to obtain a file. The
 * download lands in a temp sibling and is only renamed into place AFTER the
 * digest matches, so a mismatch or an interrupted transfer can never leave a
 * half-written artifact that a later run mistakes for a good one.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { logger } from '../utils';
import { ensureDir, catalogCacheDir } from './paths';
import { MAX_ARTIFACT_BYTES, MAX_CATALOG_BYTES } from '../../shared/gameserver-types';
import type { HashRef } from '../../shared/gameserver-types';
import { isSafeArtifactUrl } from '../../shared/gameserver-core';

const log = logger.child('GameFetcher');

/** Connect/first-byte timeout. The overall transfer is bounded by the size cap
 *  and by the caller's own cancellation, not by a wall-clock deadline: a 200 MB
 *  JRE on a slow line is legitimate and must not be cut off mid-way. */
const CONNECT_TIMEOUT_MS = 30_000;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Who we say we are to every upstream, on every request.
 *
 * This is not politeness — PaperMC now REQUIRES a User-Agent that names the
 * software and carries a contact URL, and explicitly rejects generic defaults
 * (`curl`, `wget`, and by extension whatever Electron's fetch would send). The
 * other vendors do not mandate one, but all of them rate-limit by client, and an
 * anonymous client is the first thing a vendor throttles when a mirror is under
 * load. One constant, applied in all three request paths below, so a future
 * upstream cannot be added without it.
 *
 * The version is deliberately NOT read from package.json at runtime: this module
 * is unit-tested outside Electron, and a bundler resolving a JSON import here is
 * a build-config dependency for a string.
 */
const USER_AGENT = 'Havvn/2.24 (https://github.com/NIHILcoder/Havvn)';

/** Headers every outbound request carries. `accept` is stated so a CDN cannot
 *  decide an HTML error page satisfies a JSON request. */
function requestHeaders(accept: string): Record<string, string> {
  return { 'user-agent': USER_AGENT, accept };
}

export interface DownloadProgress {
  received: number;
  /** Absent when the server sends no content-length. */
  total?: number;
}

export class DigestMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string, readonly url: string) {
    super(`digest mismatch for ${url}: expected ${expected}, got ${actual}`);
    this.name = 'DigestMismatchError';
  }
}

function digestAlgo(hash: HashRef): 'sha1' | 'sha256' | 'sha512' {
  return hash.algo === 'vendor' ? hash.digest : hash.algo;
}

/**
 * Download `url` to `dest`, verifying the digest. Returns the number of bytes
 * written. Throws DigestMismatchError (and deletes the partial file) on
 * mismatch, so a caller can report the tampering distinctly from a network fault.
 */
export async function downloadVerified(
  url: string,
  hash: HashRef,
  dest: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {},
): Promise<number> {
  if (!isSafeArtifactUrl(url)) throw new Error(`refusing to download from an unsafe url: ${url}`);

  ensureDir(path.dirname(dest));
  const tmp = `${dest}.part-${process.pid}-${Date.now().toString(36)}`;

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: requestHeaders('application/octet-stream, */*'),
    });
    clearTimeout(connectTimer);
    if (!res.ok) throw new Error(`http ${res.status} for ${url}`);
    if (!res.body) throw new Error(`empty response body for ${url}`);

    const declared = Number(res.headers.get('content-length') ?? '');
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    if (total !== undefined && total > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact too large (${total} bytes) for ${url}`);
    }

    const algo = digestAlgo(hash);
    const hasher = crypto.createHash(algo);
    let received = 0;

    // Count and hash as the bytes flow, so the size cap bites on a server that
    // lied in (or omitted) content-length rather than after the disk is full.
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_ARTIFACT_BYTES) {
          cb(new Error(`artifact exceeded ${MAX_ARTIFACT_BYTES} bytes for ${url}`));
          return;
        }
        hasher.update(chunk);
        opts.onProgress?.({ received, ...(total !== undefined ? { total } : {}) });
        cb(null, chunk);
      },
    });

    await pipeline(source, meter, fs.createWriteStream(tmp));

    const actual = hasher.digest('hex');
    if (actual !== hash.hex.toLowerCase()) {
      fs.rmSync(tmp, { force: true });
      throw new DigestMismatchError(hash.hex, actual, url);
    }

    // Rename last: until this point nothing at `dest` looks installed.
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
    log.info('artifact verified', { url, bytes: received, algo, vendor: hash.algo === 'vendor' ? hash.from : undefined });
    return received;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    clearTimeout(connectTimer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog JSON — small, cacheable, and NOT hash-verifiable (it is the thing that
// tells us the hashes). Its integrity rests on TLS to the vendor, which is why
// the trust tier is named 'vendor' in HashRef and must be surfaced in the UI.
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  at: number;
  body: unknown;
}

const memCache = new Map<string, CacheEntry>();

function cacheFile(url: string): string {
  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  return path.join(catalogCacheDir(), `${key}.json`);
}

/** The on-disk half of the cache, promoted into memory. Absent or corrupt reads
 *  as "no cache" — this is a speed and offline aid, never a correctness input. */
function readDiskCache(url: string): CacheEntry | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8')) as CacheEntry;
    if (!raw || typeof raw.at !== 'number') return null;
    memCache.set(url, raw);
    return raw;
  } catch {
    return null;
  }
}

/**
 * GET + parse JSON, with a memory and on-disk cache. The disk copy is what makes
 * an offline launch usable: a cached catalog lets the user start an ALREADY
 * INSTALLED server without the network, which is the common case.
 */
export async function fetchJsonCached(url: string, ttlMs = 6 * 60 * 60_000): Promise<unknown> {
  if (!isSafeArtifactUrl(url)) throw new Error(`refusing to fetch from an unsafe url: ${url}`);
  const now = Date.now();

  const hit = memCache.get(url);
  if (hit && now - hit.at < ttlMs) return hit.body;

  const file = cacheFile(url);
  if (!hit) {
    const disk = readDiskCache(url);
    if (disk && now - disk.at < ttlMs) return disk.body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: requestHeaders('application/json'),
    });
    if (!res.ok) throw new Error(`http ${res.status} for ${url}`);
    const text = await res.text();
    if (text.length > MAX_CATALOG_BYTES) throw new Error(`catalog response too large for ${url}`);
    const body = JSON.parse(text) as unknown;
    const entry: CacheEntry = { at: now, body };
    memCache.set(url, entry);
    try {
      ensureDir(catalogCacheDir());
      fs.writeFileSync(file, JSON.stringify(entry));
    } catch (err) {
      log.warn('could not persist catalog cache', { url, err: String(err) });
    }
    return body;
  } catch (err) {
    // Serve a stale cache rather than failing: an outdated version list is far
    // more useful than an empty one, and installs are hash-verified regardless.
    const stale = memCache.get(url);
    if (stale) {
      log.warn('catalog fetch failed, serving stale cache', { url, err: String(err) });
      return stale.body;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Longest response `fetchTextCached` will accept. A Maven `.sha256` is 64 bytes
 * plus a newline; this leaves room for a mirror that appends the filename and no
 * room at all for the thing we are actually guarding against — a captive-portal
 * or CDN error page arriving with HTTP 200, whose first "word" would otherwise be
 * handed to the verifier as a digest.
 */
const MAX_DIGEST_BYTES = 1024;

/**
 * GET a small text document (a Maven checksum), cached like the catalog JSON.
 *
 * Shares fetchJsonCached's on-disk cache by storing the string as the body, so a
 * resolved version keeps working offline for as long as its TTL — and checksums
 * are immutable per artifact, so that TTL is a month rather than hours.
 */
export async function fetchTextCached(url: string, ttlMs = 30 * 24 * 60 * 60_000): Promise<string> {
  if (!isSafeArtifactUrl(url)) throw new Error(`refusing to fetch from an unsafe url: ${url}`);
  const now = Date.now();

  const hit = memCache.get(url) ?? readDiskCache(url);
  if (hit && now - hit.at < ttlMs && typeof hit.body === 'string') return hit.body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: requestHeaders('text/plain, */*'),
    });
    if (!res.ok) throw new Error(`http ${res.status} for ${url}`);
    const text = await res.text();
    if (text.length > MAX_DIGEST_BYTES) throw new Error(`expected a checksum, got ${text.length} bytes from ${url}`);
    const entry: CacheEntry = { at: now, body: text };
    memCache.set(url, entry);
    try {
      ensureDir(catalogCacheDir());
      fs.writeFileSync(cacheFile(url), JSON.stringify(entry));
    } catch (err) {
      log.warn('could not persist checksum cache', { url, err: String(err) });
    }
    return text;
  } catch (err) {
    const stale = memCache.get(url);
    if (stale && typeof stale.body === 'string') {
      log.warn('checksum fetch failed, serving cached copy', { url, err: String(err) });
      return stale.body;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
