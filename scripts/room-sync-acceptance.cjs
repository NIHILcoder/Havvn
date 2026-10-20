/* eslint-disable @typescript-eslint/no-require-imports -- Standalone local acceptance CLI. */
// No network, app profiles or room secrets. All writes are exclusive, to explicit new paths.
const fs = require('node:fs'), path = require('node:path');
function runtime() {
  const built = path.resolve(__dirname, '../dist/electron');
  if (!fs.existsSync(path.join(built, 'electron/sharing/room-sync-watcher.js'))) throw new Error('Run npm run build:electron first');
  return { ...require(path.join(built, 'electron/sharing/room-sync-watcher.js')),
    ...require(path.join(built, 'electron/sharing/room-sync-snapshot.js')), ...require(path.join(built, 'shared/room-file-sync.js')) };
}
function writeNew(file, contents, api) {
  api.assertSyncPlainPath(file); fs.mkdirSync(path.dirname(file), { recursive: true }); api.assertSyncPlainPath(file);
  fs.writeFileSync(file, contents, { flag: 'wx', mode: 0o600 });
}
function prepare(destination, api = runtime()) {
  const root = path.resolve(destination); api.assertSyncPlainPath(root);
  fs.mkdirSync(root); // Refuse an existing directory, even an empty one; never merge into user files.
  const publisher = path.join(root, 'publisher'), receiver = path.join(root, 'receiver'), reports = path.join(root, 'reports');
  for (const folder of [publisher, receiver, reports]) fs.mkdirSync(folder);
  const files = {
    'config.ini': '[pilot]\nrevision=1\nmessage=Initial configuration\n',
    'notes.md': '# Shared notes\n\n- [ ] First save\n- [ ] Offline save\n- [ ] Conflict and restore\n',
    'Project/Program.cs': 'Console.WriteLine("Havvn sync pilot version 1");\n',
    'Project/Pilot.csproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n',
    'Project/Pilot.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Pilot", "Pilot.csproj", "{23195704-53F9-4EE8-9E0A-5F0A9B8B69E7}"\nEndProject\nGlobal\nEndGlobal\n',
    'empty.txt': '',
    'Папка с пробелами/заметка.txt': 'Havvn — проверка имён и UTF-8\n',
    '.env': 'SYNTHETIC_EXCLUDED_FIXTURE=not-a-secret\n',
    'Project/obj/ignored.txt': 'Synthetic build output: must stay local\n',
    '~$office-lock.docx': 'Synthetic Office lock name: must stay local\n',
  };
  for (const [name, body] of Object.entries(files)) writeNew(path.join(publisher, ...name.split('/')), body, api);
  writeNew(path.join(root, 'pilot.json'), JSON.stringify({ v: 1, purpose: 'havvn-file-sync-acceptance', createdAt: new Date().toISOString() }, null, 2), api);
  return { publisher, receiver, reports, includedFiles: 7, excludedFixtures: 3 };
}
async function manifest(folder, destination, api = runtime()) {
  folder = path.resolve(folder); destination = path.resolve(destination);
  const relative = path.relative(folder, destination);
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw new Error('Save the report outside the synced folder');
  const first = await api.scanSyncFolder(folder), files = [];
  for (const file of first.files) files.push({ path: file.path, size: file.size, sha256: await api.syncFileDigest(path.join(folder, ...file.path.split('/'))) });
  if ((await api.scanSyncFolder(folder)).fingerprint !== first.fingerprint) throw new Error('Files changed while hashing; close the editor and retry');
  const result = { v: 1, kind: 'havvn-sync-content', skipped: first.skipped, files };
  writeNew(destination, JSON.stringify(result, null, 2), api); return result;
}
function readManifest(file, api) {
  api.assertSyncPlainPath(file); const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 4 * 1024 ** 2) throw new Error('Invalid manifest size');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.v !== 1 || value.kind !== 'havvn-sync-content' || !Array.isArray(value.files) || value.files.length > 2000) throw new Error('Invalid manifest');
  const keys = new Set();
  for (const item of value.files) {
    if (!item || typeof item.path !== 'string' || !api.validSyncRelativePath(item.path) || api.excludedSyncPath(item.path)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 256 * 1024 ** 2 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid manifest item');
    const key = item.path.normalize('NFC').toLowerCase(); if (keys.has(key)) throw new Error('Duplicate manifest path'); keys.add(key);
  }
  return value.files;
}
function compare(left, right, api = runtime()) {
  const a = new Map(readManifest(left, api).map(f => [f.path, f])), b = new Map(readManifest(right, api).map(f => [f.path, f]));
  const differences = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const one = a.get(name), two = b.get(name);
    if (!one || !two) differences.push({ path: name, reason: one ? 'missing-right' : 'missing-left' });
    else if (one.sha256 !== two.sha256 || one.size !== two.size) differences.push({ path: name, reason: 'content' });
  }
  return { equal: differences.length === 0, leftFiles: a.size, rightFiles: b.size, differences };
}
module.exports = { prepare, manifest, compare };
if (require.main === module) void (async () => {
  const [command, ...args] = process.argv.slice(2); let result;
  if (command === 'prepare' && args.length === 1) result = prepare(args[0]);
  else if (command === 'manifest' && args.length === 2) result = await manifest(args[0], args[1]);
  else if (command === 'compare' && args.length === 2) { result = compare(args[0], args[1]); if (!result.equal) process.exitCode = 1; }
  else throw new Error('Usage: room-sync-acceptance.cjs prepare NEW_DIRECTORY | manifest WORKING_FOLDER NEW_REPORT.json | compare REPORT_A.json REPORT_B.json');
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
