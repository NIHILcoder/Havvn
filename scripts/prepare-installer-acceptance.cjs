/* eslint-disable @typescript-eslint/no-require-imports -- Local NSIS acceptance build. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const repository = path.resolve(__dirname, '..');
const inputs = process.argv.slice(2);
if (inputs.length && (inputs.length !== 3 || inputs[0] !== '--packages')) {
  throw new Error('Usage: node scripts/prepare-installer-acceptance.cjs [--packages previous/win-unpacked candidate/win-unpacked]');
}
const id = crypto.randomBytes(3).toString('hex');
const namespace = `HavvnAcceptance${id}`;
const root = path.join(repository, 'release/installer-acceptance', id);
fs.mkdirSync(root, { recursive: true });
// Exercise the real NSIS scripts with an isolated identity and private file/URI
// types. No generated installer can uninstall or register the user's real Havvn.
const privateScript = file => fs.readFileSync(path.join(repository, 'build', file), 'utf8')
  .replaceAll('Havvn', namespace).replaceAll('TorrentHunt', `${namespace}Legacy`)
  .replaceAll('.torrent', `.havvn-acceptance-${id}`)
  .replace(/\bmagnet\b/g, `havvn-acceptance-magnet-${id}`);
const ui = path.join(root, 'installer-ui.nsh');
fs.writeFileSync(ui, privateScript('installer-ui.nsh'));
const include = path.join(root, 'installer.nsh');
fs.writeFileSync(include, privateScript('installer.nsh').replace('!include "installer-ui.nsh"', `!include "${ui}"`));
const base = require('../package.json').build;
const configs = [];
const packages = {};
for (const [index, stage] of ['baseline', 'updated'].entries()) {
  let version = index === 0 ? '3.2.0' : '3.2.1';
  if (inputs.length) {
    const source = path.resolve(inputs[index + 1]);
    const archive = path.join(source, 'resources', 'app.asar');
    const metadata = JSON.parse(require('@electron/asar').extractFile(archive, 'package.json'));
    if (metadata.name !== 'havvn' || !/^\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$/.test(metadata.version)) throw new Error('Expected a packaged Havvn version');
    version = metadata.version;
    const directory = path.join(root, stage + '-payload');
    fs.cpSync(source, directory, { recursive: true, errorOnExist: true, force: false });
    fs.renameSync(path.join(directory, 'Havvn.exe'), path.join(directory, namespace + '.exe'));
    packages[stage] = { directory, version, asarSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
  }
  const config = { ...base, appId: `dev.havvn.acceptance.${id}`, productName: namespace,
    directories: { ...base.directories, output: path.join(root, stage) },
    extraMetadata: { name: `havvn-acceptance-${id}`, version },
    protocols: [{ name: 'Havvn local acceptance', schemes: [`havvn-acceptance-room-${id}`] }],
    npmRebuild: false, publish: null,
    win: { ...base.win, target: [{ target: 'nsis', arch: ['x64'] }], signExecutable: false },
    nsis: { ...base.nsis, include, perMachine: false, allowElevation: false, runAfterFinish: false,
      shortcutName: `Havvn Acceptance ${id}`, artifactName: `Havvn-Acceptance-${version}.exe` },
  };
  const file = path.join(root, `${stage}.json`); fs.writeFileSync(file, JSON.stringify(config, null, 2)); configs.push(file);
}
const plan = { id, root, namespace, appId: `dev.havvn.acceptance.${id}`, executable: `${namespace}.exe`,
  shortcutName: `Havvn Acceptance ${id}`, installDirectory: path.join(root, 'installed'),
  profileBase: path.join(root, 'profile'), instance: `installer-${id}`, configs,
  packages,
  baselineInstaller: path.join(root, 'baseline', `Havvn-Acceptance-${packages.baseline?.version || '3.2.0'}.exe`),
  updatedInstaller: path.join(root, 'updated', `Havvn-Acceptance-${packages.updated?.version || '3.2.1'}.exe`),
  limitations: ['Isolated appId, registry namespace, shortcuts and file/URI types; production installation is untouched',
    inputs.length ? 'Private NSIS wrappers around archived and candidate Windows payloads, with original application archives' :
      'Both versions contain the current code; this checks NSIS replacement and state retention, not migrations from every historical release',
    'Unsigned local test installers; no online auto-update feed or signature acceptance'] };
fs.writeFileSync(path.join(root, 'plan.json'), JSON.stringify(plan, null, 2));
console.log(JSON.stringify(plan, null, 2));
