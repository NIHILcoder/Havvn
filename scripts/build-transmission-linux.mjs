/** Build the pinned upstream daemon on Linux x64 and bundle its non-glibc
 * shared-library closure. Nothing is installed system-wide by this script.
 * Ubuntu 22.04 CI establishes the glibc 2.35 baseline. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '4.1.3';
const sha256 = 'ce7d2d8b101f7eb54bc3cf0bc55f52f7ebd4a25fa48e00bdca9a7e0fc02617da';
const url = `https://github.com/transmission/transmission/releases/download/${version}/transmission-${version}.tar.xz`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'vendor/transmission/linux-x64');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(command + ' failed (' + result.status + '): ' + (result.stderr || ''));
  return (result.stdout || '') + (result.stderr || '');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build Linux x64 packages on Linux x64 with a fresh npm ci (Windows native modules cannot be reused).');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-transmission-linux-'));
  try {
    const archive = path.join(work, 'transmission-source.tar.xz');
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Transmission download failed: HTTP ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Transmission source SHA-256 mismatch');
    fs.writeFileSync(archive, bytes);
    run('tar', ['-xf', archive, '-C', work]);
    const source = path.join(work, 'transmission-' + version);
    const build = path.join(work, 'build');
    run('cmake', ['-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
      '-DENABLE_DAEMON=ON', '-DENABLE_GTK=OFF', '-DENABLE_QT=OFF', '-DENABLE_MAC=OFF',
      '-DENABLE_UTILS=OFF', '-DENABLE_TESTS=OFF', '-DENABLE_CLI=OFF', '-DENABLE_NLS=OFF',
      '-DINSTALL_WEB=OFF', '-DWITH_SYSTEMD=OFF', '-DRUN_CLANG_TIDY=OFF', '-DWITH_CRYPTO=openssl'], { stdio: 'inherit' });
    run('cmake', ['--build', build, '--target', 'transmission-daemon', '--parallel', String(Math.min(os.availableParallelism(), 4))], { stdio: 'inherit' });
    const binary = path.join(build, 'daemon/transmission-daemon');
    fs.mkdirSync(path.join(destination, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(destination, 'licenses'), { recursive: true });
    fs.copyFileSync(binary, path.join(destination, 'transmission-daemon.bin'));
    fs.chmodSync(path.join(destination, 'transmission-daemon.bin'), 0o755);
    run('strip', [path.join(destination, 'transmission-daemon.bin')]);
    const libraries = [];
    const packages = new Set();
    for (const line of run('ldd', [binary]).split('\n')) {
      if (line.includes('not found')) throw new Error('Unresolved engine library: ' + line.trim());
      const match = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)/);
      if (!match) continue;
      const [, name, original] = match;
      // glibc and its loader must come from the host as a matching set.
      if (/^(?:libc|libm|libpthread|libdl|librt|libresolv|libutil)\.so/.test(name)) continue;
      fs.copyFileSync(original, path.join(destination, 'lib', name));
      libraries.push({ name, sha256: createHash('sha256').update(fs.readFileSync(original)).digest('hex') });
      // Debian may report either the pre-usrmerge or canonical location.
      let owner;
      for (const candidate of new Set([original, fs.realpathSync(original), original.replace(/^\/lib\//, '/usr/lib/'), original.replace(/^\/usr\/lib\//, '/lib/')])) {
        const result = spawnSync('dpkg-query', ['-S', candidate], { encoding: 'utf8' });
        if (result.status === 0) { owner = result.stdout.split(': /')[0].trim(); break; }
      }
      if (!owner) throw new Error('Cannot identify license for bundled ' + name + '; use the documented Debian/Ubuntu build environment.');
      packages.add(owner);
    }
    for (const pkg of packages) {
      const name = pkg.split(':')[0];
      fs.copyFileSync('/usr/share/doc/' + name + '/copyright', path.join(destination, 'licenses', name + '.copyright'));
    }
    fs.copyFileSync(path.join(source, 'COPYING'), path.join(destination, 'licenses', 'transmission.COPYING'));
    // Include the exact corresponding upstream source, with its third parties.
    fs.copyFileSync(archive, path.join(destination, 'transmission-source.tar.xz'));
    fs.writeFileSync(path.join(destination, 'transmission-daemon'), '#!/bin/sh\nENGINE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexport LD_LIBRARY_PATH="$ENGINE_DIR/lib"\nexec "$ENGINE_DIR/transmission-daemon.bin" "$@"\n', { mode: 0o755 });
    fs.chmodSync(path.join(destination, 'transmission-daemon'), 0o755);
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ version, source: url, sha256, libraries, packages: [...packages] }, null, 2));
    const check = run(path.join(destination, 'transmission-daemon'), ['-V']);
    if (!check.includes(version)) throw new Error('Bundled daemon version check failed');
    console.log('Prepared Transmission ' + version + ' with ' + libraries.length + ' runtime libraries: ' + destination);
  } finally {
    // Only the unique mkdtemp directory created above is removed.
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
