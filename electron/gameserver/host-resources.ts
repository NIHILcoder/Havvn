/**
 * The two questions about this machine that a plan cannot answer for itself:
 * "is this port actually free" and "is there room to install".
 *
 * Both are effects, so they live out here rather than in shared/gameserver-core —
 * the core picks a CANDIDATE port from what sibling instances hold, and this file
 * asks the operating system whether that candidate survives contact with reality.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { logger } from '../utils';

const log = logger.child('GameHostResources');

/**
 * Can we bind `port` right now?
 *
 * Binds for real and closes again, because that is the only answer that counts.
 * The alternative — a connect probe — reports "free" for a port held by a
 * listener bound to a different interface, which is precisely the case that
 * bites: another Minecraft server on 0.0.0.0 while we test 127.0.0.1.
 *
 * `exclusive` matters on Windows, where two sockets can otherwise share a port
 * and both appear to succeed.
 */
export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (free: boolean): void => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    server.once('error', () => resolve(false));
    server.once('listening', () => done(true));
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/**
 * First port at or after `from` that both the caller's own bookkeeping and the OS
 * agree is free. Bounded by `span` so a machine with a busy range fails with an
 * answer instead of scanning to 65535.
 */
export async function findFreePort(
  from: number,
  span: number,
  taken: ReadonlySet<number>,
): Promise<number | null> {
  for (let port = from; port < from + span && port <= 65535; port++) {
    if (taken.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return null;
}

/**
 * Bytes free on the volume containing `dir`.
 *
 * Returns null when the platform will not say — statfs is unavailable on some
 * targets and throws on a path that does not exist yet. A null must be treated as
 * "unknown", never as "zero": refusing to install because we could not measure
 * the disk would be a worse bug than the one this guards against.
 */
export function freeBytes(dir: string): number | null {
  try {
    // Walk up to the nearest existing ancestor: the instance directory is usually
    // created after this check, and statfs on a missing path throws.
    let probe = dir;
    for (let i = 0; i < 8 && !fs.existsSync(probe); i++) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const stats = fs.statfsSync(probe);
    return stats.bavail * stats.bsize;
  } catch (err) {
    log.debug('could not measure free space', { dir, err: String(err) });
    return null;
  }
}

/**
 * What an install of this shape needs, roughly, in bytes.
 *
 * Deliberately coarse. The point is not to predict the install to the megabyte —
 * a Forge installer downloads a few hundred libraries of sizes nobody publishes
 * up front — but to catch the case where there is plainly not enough room, so the
 * user gets a sentence about disk space instead of a confusing extraction failure
 * partway through.
 *
 * Skewed to OVER-estimate: a false "not enough space" the user can override by
 * freeing a gigabyte is a better failure than a half-written instance.
 */
export function estimateInstallBytes(opts: { needsRuntime: boolean; runsInstaller: boolean }): number {
  const GB = 1024 * 1024 * 1024;
  // A Temurin JRE is ~50 MB compressed and ~200 MB unpacked, and both exist at
  // once during extraction.
  const runtime = opts.needsRuntime ? 300 * 1024 * 1024 : 0;
  // A loader installer pulls the vanilla jar plus its whole library tree; a plain
  // jar is just the jar plus room for a world to grow into.
  const payload = opts.runsInstaller ? 2 * GB : GB;
  return runtime + payload;
}
