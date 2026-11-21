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
 * SHA-256 PINNING: verify the official ZIP digest before extracting any files.
 * An unpinned download is refused unless --trust-unpinned is passed explicitly.
 *
 * Usage: node scripts/fetch-wintun.mjs [--force] [--trust-unpinned]
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
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
// Accept either upstream license filename, and fail if neither is present.
const LICENSE_IN_ZIP = [
  path.join('wintun', 'LICENSE.txt'),
  path.join('wintun', 'prebuilt-binaries-license.txt'),
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(repoRoot, 'vendor', 'wintun', 'win32-x64');

/** Follow-redirect GET on node:https, resolving to the body. */
function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new Error('too many redirects')); return; }
        resolve(httpsGet(new URL(headers.location, url).toString(), redirects - 1));
        return;
      }
      if (statusCode !== 200) { res.resume(); reject(new Error(`http ${statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Windows ships curl since 1803, and every CI runner has it. Absolute path on
 *  purpose: PATH belongs to whoever launched us, and an MSYS/Cygwin shell puts its
 *  own build of these tools first. */
const SYSTEM32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const CURL = path.join(SYSTEM32, 'curl.exe');
const TAR = path.join(SYSTEM32, 'tar.exe');

function viaCurl(url, work) {
  const tmp = path.join(work, 'curl-download.bin');
  const r = spawnSync(CURL, ['-sS', '-L', '--fail', '--max-time', '300', '-o', tmp, url], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`curl exited ${r.status}: ${(r.stderr || '').trim()}`);
  const bytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return bytes;
}

async function viaFetch(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download the ZIP, retrying across three transports.
 *
 * Not belt-and-braces for its own sake: wintun.net answers 200 and then drops the
 * connection PART WAY through the ~750 KB body on some networks. `fetch` reports
 * a bare "terminated", node:https an "ECONNRESET", and curl pulls the same file in
 * under a second — so a single-transport download is a coin flip, and the coin was
 * observed landing badly several times in a row.
 *
 * Worth the code because of what sits downstream: this is a documented setup step
 * AND a release step, and the packaging that follows does NOT fail on a missing
 * vendored file — electron-builder logs "file source doesn't exist" and exits 0,
 * which turns a flaky download into an installer with no driver inside it.
 *
 * Trying several transports is safe precisely because trust does not live in the
 * transport: every byte is checked against the pinned SHA-256 below.
 */
async function download(url, work) {
  const transports = [['fetch', () => viaFetch(url)], ['node:https', () => httpsGet(url)], ['curl', () => viaCurl(url, work)]];
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const [name, get] of transports) {
      try {
        const bytes = await get();
        if (bytes?.length) {
          if (failures.length) console.log(`downloaded via ${name} after ${failures.length} failed attempt(s).`);
          return bytes;
        }
        throw new Error('empty body');
      } catch (e) {
        failures.push(`${name} (attempt ${attempt}): ${e.message ?? e}`);
      }
    }
  }
  throw new Error(`download failed on every transport:\n  ${failures.join('\n  ')}`);
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('wintun vendoring targets Windows only.');
    process.exit(1);
  }
  const force = process.argv.includes('--force');
  const trustUnpinned = process.argv.includes('--trust-unpinned');
  const dll = path.join(destDir, 'wintun.dll');
  const license = path.join(destDir, 'prebuilt-binaries-license.txt');
  if (!force && fs.existsSync(dll) && fs.existsSync(license)) {
    console.log(`Wintun ${VERSION} and its license are already present; use --force to re-fetch.`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wintun-fetch-'));
  try {
    const zipPath = path.join(work, `wintun-${VERSION}.zip`);
    console.log(`downloading ${ZIP_URL} ...`);
    const bytes = await download(ZIP_URL, work);
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

    // Use the inbox extractor to avoid mixing PowerShell 5 and 7 archive modules.
    const out = path.join(work, 'extract');
    fs.mkdirSync(out);
    const unzip = spawnSync(TAR, ['-xf', zipPath, '-C', out], { stdio: 'inherit', windowsHide: true });
    if (unzip.error) throw unzip.error;
    if (unzip.status !== 0) throw new Error(`Wintun extraction failed with code ${unzip.status}`);

    const dllSrc = path.join(out, DLL_IN_ZIP);
    if (!fs.existsSync(dllSrc)) throw new Error(`wintun.dll not found in archive at ${DLL_IN_ZIP}`);
    const licSrc = LICENSE_IN_ZIP.map((rel) => path.join(out, rel)).find((p) => fs.existsSync(p));
    if (!licSrc) throw new Error('Wintun license not found in the archive');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(dllSrc, dll);
    fs.copyFileSync(licSrc, license);

    console.log(`vendored wintun ${VERSION} → ${destDir}`);
    console.log('reminder: ship this DLL unmodified via extraResources, exclude it from signing, and surface the PBL license in-app.');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
