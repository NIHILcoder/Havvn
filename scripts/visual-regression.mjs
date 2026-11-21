import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const screenshots = ['controls-dark.png', 'controls-light-narrow.png', 'room-file-conflict.png'];
const artifactRoot = join(import.meta.dirname, '..', 'artifacts', 'visual-regression', `${process.platform}-${process.arch}`);
const referenceFile = join(artifactRoot, 'reference.txt');
const [mode, ...extraArgs] = process.argv.slice(2);

if (extraArgs.length || (mode !== undefined && mode !== '--update')) {
  throw new Error('Usage: npm run test:visual [-- --update]');
}

function readReference() {
  let name;
  try {
    name = readFileSync(referenceFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Visual reference missing. Run npm run test:visual -- --update on the version you want to keep.');
  }
  if (!/^run-[a-zA-Z0-9]+$/.test(name)) throw new Error('Invalid visual reference directory');
  return join(artifactRoot, name);
}

const reference = mode === '--update' ? null : readReference();
mkdirSync(artifactRoot, { recursive: true });
const runDir = mkdtempSync(join(artifactRoot, 'run-'));
const result = spawnSync(process.execPath, [join(import.meta.dirname, 'smoke-accessibility.cjs')], {
  env: { ...process.env, HAVVN_A11Y_OUTPUT: runDir },
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const actualScreenshots = screenshots.map(name => ({ name, actual: PNG.sync.read(readFileSync(join(runDir, name))) }));
if (!reference) {
  const stagedReference = join(runDir, 'reference.txt');
  writeFileSync(stagedReference, basename(runDir) + '\n');
  renameSync(stagedReference, referenceFile);
  console.log(`Visual reference saved in ${runDir}`);
} else {
  for (const { name, actual } of actualScreenshots) {
    const expected = PNG.sync.read(readFileSync(join(reference, name)));
    if (actual.width !== expected.width || actual.height !== expected.height) {
      console.error(`${name}: expected ${expected.width}×${expected.height}, got ${actual.width}×${actual.height}`);
      process.exitCode = 1;
      continue;
    }

    const diff = new PNG({ width: actual.width, height: actual.height });
    const changed = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height);
    if (changed > 0) {
      const diffPath = join(runDir, name.replace(/\.png$/, '.diff.png'));
      writeFileSync(diffPath, PNG.sync.write(diff));
      console.error(`${name}: ${changed} changed pixels, diff at ${diffPath}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS ${name}`);
    }
  }
}
