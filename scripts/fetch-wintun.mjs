/**
 * Vendors the prebuilt signed wintun.dll (WireGuard LLC) for Windows x64.
 *
 * Downloads the official release ZIP from wintun.net, extracts the amd64 DLL
 * (BYTE-FOR-BYTE unmodified — the Prebuilt Binaries License forbids repacking
 * or re-signing) plus its license text into vendor/wintun/win32-x64/:
 *   wintun.dll + prebuilt-binaries-license.txt
 *
 * The DLL must ship via electron-builder extraResources (NOT inside asar —
 * LoadLibraryEx needs a real file) and must NOT go through any code-signing
 * pass. See the plan §10.
 *
 * SHA-256 PINNING: this repo pins vendored binaries. The digest of the wintun
 * ZIP is not baked in here on purpose — run once, confirm the printed digest
 * against wintun.net, then paste it into WINTUN_ZIP_SHA256 below and rerun so
 * future fetches are verified. (Refuses to vendor an unpinned download unless
 * --trust-unpinned is passed.)
 *
 * Usage: node scripts/fetch-wintun.mjs [--force] [--trust-unpinned]
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.14.1';
const ZIP_URL = `https://www.wintun.net/builds/wintun-${VERSION}.zip`;
// SHA-256 of the official wintun-0.14.1.zip (the widely-published digest; also
// verified via the HTTPS download from wintun.net). Do not change without
// re-confirming against the official source.
const WINTUN_ZIP_SHA256 = '07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51';
const DLL_IN_ZIP = path.join('wintun', 'bin', 'amd64', 'wintun.dll');
const LICENSE_IN_ZIP = path.join('wintun', 'prebuilt-binaries-license.txt');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(repoRoot, 'vendor', 'wintun', 'win32-x64');

// Escape a value for a single-quoted PowerShell string: an apostrophe (e.g. a
// username like O'Brien in the temp path) ends the string unless doubled.
const psq = (s) => s.replace(/'/g, "''");

async function main() {
  if (process.platform !== 'win32') {
    console.error('wintun vendoring targets Windows only (Expand-Archive extraction).');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  const trustUnpinned = process.argv.includes('--trust-unpinned');
  if (!force && fs.existsSync(path.join(destDir, 'wintun.dll'))) {
    console.log(`vendor/wintun/win32-x64/wintun.dll already present (wintun ${VERSION}); use --force to re-fetch.`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wintun-fetch-'));
  try {
    const zipPath = path.join(work, `wintun-${VERSION}.zip`);
    console.log(`downloading ${ZIP_URL} ...`);
    const res = await fetch(ZIP_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: http ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    console.log(`downloaded ${(bytes.length / 1024).toFixed(0)} KB, sha256 ${digest}`);

    if (WINTUN_ZIP_SHA256) {
      if (digest !== WINTUN_ZIP_SHA256) throw new Error(`SHA-256 mismatch: expected ${WINTUN_ZIP_SHA256}, got ${digest}`);
      console.log('sha256 verified against pin.');
    } else if (!trustUnpinned) {
      throw new Error(
        'no pinned digest. Verify the sha256 above against wintun.net, paste it into ' +
        'WINTUN_ZIP_SHA256 in this script, and rerun — or pass --trust-unpinned to proceed once.',
      );
    } else {
      console.warn('WARNING: proceeding with an UNPINNED download (--trust-unpinned). Pin the digest for CI/reproducibility.');
    }
    fs.writeFileSync(zipPath, bytes);

    // Extract with PowerShell (no zip dependency), mirroring fetch-transmission's msiexec approach.
    const out = path.join(work, 'extract');
    const unzip = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${psq(zipPath)}' -DestinationPath '${psq(out)}' -Force`], { stdio: 'inherit' });
    if (unzip.status !== 0) throw new Error(`Expand-Archive failed with code ${unzip.status}`);

    const dllSrc = path.join(out, DLL_IN_ZIP);
    if (!fs.existsSync(dllSrc)) throw new Error(`wintun.dll not found in archive at ${DLL_IN_ZIP}`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(dllSrc, path.join(destDir, 'wintun.dll'));
    const licSrc = path.join(out, LICENSE_IN_ZIP);
    if (fs.existsSync(licSrc)) fs.copyFileSync(licSrc, path.join(destDir, 'prebuilt-binaries-license.txt'));

    console.log(`vendored wintun ${VERSION} → ${destDir}`);
    console.log('reminder: ship this DLL unmodified via extraResources, exclude it from signing, and surface the PBL license in-app.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
