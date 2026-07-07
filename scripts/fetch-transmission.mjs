/**
 * Vendors the transmission-daemon sidecar binary for Windows x64.
 *
 * Downloads the official MSI from the pinned GitHub release, verifies its
 * SHA-256 against the pinned digest, extracts it with an msiexec
 * administrative install (no elevation needed), and copies the minimal
 * 5-file portable set into vendor/transmission/win32-x64/:
 *   transmission-daemon.exe + libcurl.dll + libcrypto-3-x64.dll +
 *   libssl-3-x64.dll + zlib.dll
 * (minimal set = transitive closure of the PE import tables; the Qt DLLs are
 * GUI-only). Everything else from the MSI — GUI, CLI tools, web UI — is
 * discarded.
 *
 * Usage: node scripts/fetch-transmission.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned release. 4.1.3 fixes a CSRF-nonce CORS leak and a peer-code
// use-after-free — do not downgrade below it.
const VERSION = '4.1.3';
const MSI_URL = `https://github.com/transmission/transmission/releases/download/${VERSION}/transmission-${VERSION}-x64.msi`;
const MSI_SHA256 = 'c8ea492d8f46fadac26e0c05b244cabba556201d5fe348dfcf1cf036621741f8';
const PORTABLE_FILES = ['transmission-daemon.exe', 'libcurl.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'zlib.dll'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(repoRoot, 'vendor', 'transmission', 'win32-x64');

async function main() {
  if (process.platform !== 'win32') {
    console.error('transmission vendoring currently targets Windows only (msiexec extraction).');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  if (!force && PORTABLE_FILES.every((f) => fs.existsSync(path.join(destDir, f)))) {
    console.log(`vendor/transmission/win32-x64 already populated (transmission ${VERSION}); use --force to re-fetch.`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'transmission-fetch-'));
  try {
    const msiPath = path.join(work, `transmission-${VERSION}-x64.msi`);
    console.log(`downloading ${MSI_URL} ...`);
    const res = await fetch(MSI_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: http ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== MSI_SHA256) throw new Error(`SHA-256 mismatch: expected ${MSI_SHA256}, got ${digest}`);
    fs.writeFileSync(msiPath, bytes);
    console.log(`verified sha256 ${digest} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);

    // Administrative install = plain extraction, runs without elevation.
    // TARGETDIR must be absolute; payload lands under <target>\PFiles\Transmission.
    const target = path.join(work, 'extract');
    const msi = spawnSync('msiexec', ['/a', msiPath, '/qn', `TARGETDIR=${target}`], { stdio: 'inherit' });
    if (msi.status !== 0) throw new Error(`msiexec /a failed with code ${msi.status}`);
    const payload = path.join(target, 'PFiles', 'Transmission');

    fs.mkdirSync(destDir, { recursive: true });
    for (const f of PORTABLE_FILES) fs.copyFileSync(path.join(payload, f), path.join(destDir, f));

    const check = spawnSync(path.join(destDir, 'transmission-daemon.exe'), ['-V'], { encoding: 'utf8' });
    const version = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
    if (!version.includes(VERSION)) throw new Error(`vendored daemon failed self-check: ${version || `exit ${check.status}`}`);
    console.log(`vendored: ${version} → ${destDir}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
