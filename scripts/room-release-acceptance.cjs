/* eslint-disable @typescript-eslint/no-require-imports -- Local release evidence and controlled acceptance runner. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), os = require('node:os'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), defaultOutput = path.join(root, 'artifacts/fun01');
const snapshot = () => require('./performance-baseline-metrics.cjs').sourceSnapshot(root);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const productConfigs = ['tsconfig.electron.json', 'tsconfig.guest.json', 'webpack.guest.config.js'];
function guestSnapshot() {
  const files = {};
  const visit = folder => { for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const file = path.posix.join(folder, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && /\.(tsx?|css|json|c?js|mjs)$/.test(file)) files[file] = sha(path.join(root, file));
  } };
  visit('guest'); return files;
}
function productDigest(captured = null) {
  const data = captured ?? snapshot(), files = { ...data.hashes, ...(captured ? captured.guestHashes ?? {} : guestSnapshot()) };
  for (const file of productConfigs) files[file] = captured ? data.supplemental[file] : sha(path.join(root, file));
  return digest(Object.fromEntries(Object.entries(files).filter(([file]) => !file.startsWith('scripts/') && !/\.test\.tsx?$/.test(file)).sort(([a], [b]) => a.localeCompare(b))));
}
const source = () => productDigest();
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const read = file => { if (!fs.existsSync(file)) return null; if (fs.statSync(file).size > 8 * 1024 ** 2) throw Error('Oversized acceptance report'); return JSON.parse(fs.readFileSync(file, 'utf8')); };
const networks = ['lan', 'different-networks', 'strict-nat', 'custom-turn'];
const physicalCases = ['file-change', 'conflict', 'offline-return', 'office-lock', 'documents', 'rights-revocation', 'owner-unavailable', 'ownership-transfer', 'restart-during-write'];
const requiredCases = kind => kind === 'lan' ? physicalCases : ['connection', 'file-change', 'documents'];
const requiredSteps = {
  local: ['compile-electron', 'copy-engine', 'typecheck-renderer', 'policy-tests', 'units', 'build-sync-ui', 'documents', 'editor', 'writers', 'faults'],
  package: ['build-renderer', 'build-guest', 'prepare-private-installers', 'build-private-0', 'build-private-1', 'packaged-smoke'],
  installer: ['isolated-installer'],
};
const harnessFiles = {
  local: ['scripts/copy-room-engine.cjs', 'scripts/room-release-acceptance.test.cjs', 'scripts/room-sync-ui.webpack.cjs', 'scripts/fixtures/room-sync-ui.tsx', 'scripts/smoke-room-file-sync.cjs',
    'renderer/pages/rooms/document-save-status.test.ts', 'electron/sharing/room-documents.test.ts', 'electron/db/room-documents-store.test.ts', 'electron/ipc/room-documents.test.ts', 'electron/sharing/room-sync-editor.test.ts', 'electron/sharing/room-file-sync.test.ts', 'electron/sharing/room-sync-work.test.ts', 'electron/sharing/room-sync-snapshot.test.ts', 'shared/room-file-sync.test.ts', 'electron/ipc/room-file-sync.test.ts'],
  package: ['scripts/prepare-installer-acceptance.cjs', 'scripts/prepare-native-prebuilds.cjs', 'scripts/smoke-packaged.cjs', 'build/installer.nsh', 'build/installer-ui.nsh'],
  installer: ['scripts/smoke-installer.cjs', 'build/installer.nsh', 'build/installer-ui.nsh'],
};
const harness = phase => Object.fromEntries([...harnessFiles[phase]].sort().map(file => [file, sha(path.join(root, file))]));
const historical = [
  ['office', 'Настоящие Word и Excel', 'dist/room-sync-office/office-acceptance-latest.json'],
  ['ide', 'Внешняя IDE — незавершённая интерактивная проверка', 'dist/room-sync-ide/ide-acceptance-latest.json'],
  ['packaged-previous', 'Упакованная сборка 23 октября', 'dist/feature-tour-20261023/packaged-acceptance.json'],
  ['installer-previous', 'Изолированный NSIS 23 октября', 'artifacts/fun01/historical/installer-20261023.json'],
];
function privatePlan(plan) {
  if (!plan || !/^[a-f0-9]{6}$/.test(plan.id) || plan.namespace !== 'HavvnAcceptance' + plan.id || plan.appId !== 'dev.havvn.acceptance.' + plan.id) throw Error('Invalid private installer identity');
  const expected = path.join(root, 'release/installer-acceptance', plan.id);
  if (path.resolve(plan.root) !== expected) throw Error('Invalid private installer root');
  for (const key of ['installDirectory', 'profileBase', 'baselineInstaller', 'updatedInstaller']) if (!path.resolve(plan[key]).startsWith(expected + path.sep)) throw Error('Private installer path escapes its root');
  if (plan.executable !== plan.namespace + '.exe') throw Error('Invalid private executable');
  return plan;
}
function evidence(file) {
  const data = read(file); if (!data) return { path: file, status: 'missing' };
  const checks = Array.isArray(data.checks) ? data.checks : [];
  const passed = (data.passed === true && checks.length > 0 && checks.every(check => check.passed === true || check.status === 'passed')) || data.ok === true;
  return { path: file, sha256: sha(file), status: passed ? 'passed' : 'not-passed', recordedAt: data.finishedAt || data.completedAt || data.checkedAt || null,
    checks: checks.length || null, passedChecks: checks.filter(check => check.passed === true || check.status === 'passed').length,
    physicalMachines: data.physicalMachines ?? null, loopbackOnly: data.loopbackOnly ?? null, limitations: data.limitations ?? [], remaining: data.remainingChecks ?? [],
    appAsarSha256: data.appAsarSha256 ?? null };
}
function manualProblems(protocol, expectedAsar) {
  const problems = [];
  if (!protocol || protocol.kind !== 'FUN-01-external' || protocol.review?.accepted !== true || !protocol.review.operator || !protocol.review.at) return ['physical-device-and-network-protocol-not-reviewed', 'real-older-client-not-reviewed'];
  if (!/^[a-f0-9]{64}$/.test(expectedAsar ?? '') || protocol.candidateAsarSha256 !== expectedAsar) problems.push('external-candidate-does-not-match');
  const devices = protocol.devices ?? [], ids = new Set(devices.map(device => device.id));
  if (devices.length < 2 || ids.size !== devices.length || devices.some(device => !device.id || device.kind !== 'physical' || !device.os || !device.appVersion || device.appAsarSha256 !== expectedAsar)) problems.push('two-distinct-physical-devices-required');
  for (const kind of networks) {
    const run = protocol.runs?.find(run => run.network === kind);
    if (!run || run.status !== 'passed' || run.loopbackOnly !== false || new Set(run.deviceIds).size < 2 || run.deviceIds.some(id => !ids.has(id)) || !run.evidence?.length
      || requiredCases(kind).some(id => !run.cases?.some(item => item.id === id && item.status === 'passed'))) { problems.push(kind + '-not-accepted'); continue; }
    if (kind === 'strict-nat' && !run.natEvidence) problems.push('strict-nat-not-observed');
    if (kind === 'custom-turn' && (run.transportPath !== 'turn-relay' || run.userTurn !== true)) problems.push('room-relay-is-not-turn-proof');
  }
  const compatibility = protocol.compatibility;
  if (compatibility?.status !== 'passed' || compatibility.sameCodeVersionLabels !== false || !compatibility.evidence?.length
    || !compatibility.binaries?.some(binary => binary.realReleasedBuild === true)
    || new Set(compatibility?.binaries?.map(binary => binary.sha256)).size < 2 || new Set(compatibility?.binaries?.map(binary => binary.version)).size < 2) problems.push('real-older-client-not-reviewed');
  return problems;
}
function intact(proof) {
  return !!proof?.path && /^[a-f0-9]{64}$/.test(proof.sha256 ?? '') && fs.existsSync(proof.path) && sha(proof.path) === proof.sha256;
}
function currentReceipt(phase, receipt, current) {
  if (receipt?.status !== 'passed' || receipt.sourceKind !== 'product-v2' || receipt.sourceSha256 !== current || digest(receipt.harnessHashes) !== digest(harness(phase)) || !receipt.finishedAt || !receipt.steps?.length
    || receipt.steps.some(step => step.status !== 'passed' || step.exitCode !== 0 || !intact({ path: step.log, sha256: step.logSha256 }))
    || requiredSteps[phase].some(name => !receipt.steps.some(step => step.name === name))) return false;
  const data = receipt.metadata ?? {};
  if (phase === 'local') return intact(data.unitReport) && read(data.unitReport.path).success === true
    && ['documents', 'faults'].every(kind => intact(data[kind]) && evidence(data[kind].path).status === 'passed');
  if (phase === 'package') return intact(data.packaged) && evidence(data.packaged.path).status === 'passed'
    && intact({ path: data.archivePath, sha256: data.asarSha256 }) && evidence(data.packaged.path).appAsarSha256 === data.asarSha256;
  return intact(data.installer) && evidence(data.installer.path).status === 'passed';
}
function overview(output = defaultOutput, external = null, current = source(), includeHistorical = true) {
  const phases = Object.fromEntries(['local', 'package', 'installer'].map(phase => {
    const file = path.join(output, phase + '-run.json'), receipt = read(file);
    const valid = currentReceipt(phase, receipt, current);
    return [phase, { status: valid ? 'passed-current' : receipt ? receipt.sourceSha256 !== current ? 'stale' : receipt.status === 'passed' ? 'evidence-invalid' : receipt.status : 'not-run', receipt: file, sha256: receipt ? sha(file) : null, details: receipt }];
  }));
  const expectedAsar = phases.package.status === 'passed-current' ? phases.package.details.metadata?.asarSha256 : null;
  if (phases.installer.status === 'passed-current' && (!expectedAsar || read(phases.installer.details.metadata.installer.path).updatedAsar !== expectedAsar)) phases.installer.status = 'evidence-invalid';
  const unavailable = manualProblems(external, expectedAsar);
  const ready = Object.values(phases).every(phase => phase.status === 'passed-current') && unavailable.length === 0;
  return { version: 2, task: 'FUN-01', generatedAt: new Date().toISOString(), collectorSha256: sha(__filename), appVersion: require('../package.json').version, sourceKind: 'product-v2', sourceSha256: current,
    executionScope: { physicalMachines: 1, loopbackOnly: true, realInternetNatOrTurnMeasured: false }, phases,
    historical: includeHistorical ? historical.map(([id, title, file]) => ({ id, title, freshness: 'historical', ...evidence(path.join(root, file)) })) : [],
    external: { status: unavailable.length ? 'pending' : 'manually-reviewed', unresolved: unavailable, requirements: networks.map(kind => ({ network: kind, cases: requiredCases(kind) })) },
    releaseGate: { ready, experimentalFlag: 'HAVVN_FILE_SYNC', flagRemoved: false, sameCodeInstallerVersionsProveOldClientCompatibility: false,
      limitations: ['Local E2E and application relay are not physical-device or Internet TURN acceptance', 'Private NSIS versions contain the same current code', 'Historical Office/IDE reports do not certify this candidate'] } };
}
function externalTemplate(expectedAsar) {
  return { version: 1, kind: 'FUN-01-external', candidateAsarSha256: expectedAsar ?? null, review: { accepted: false, operator: null, at: null }, devices: [],
    runs: networks.map(network => ({ network, status: 'pending', loopbackOnly: null, deviceIds: [], evidence: [], cases: requiredCases(network).map(id => ({ id, status: 'pending' })) })),
    compatibility: { status: 'pending', sameCodeVersionLabels: null, binaries: [], evidence: [] } };
}
async function runPhase(phase, output = defaultOutput) {
  if (!['local', 'package', 'installer'].includes(phase)) throw Error('Unknown acceptance phase');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + phase, directory = path.join(output, 'runs', id);
  fs.mkdirSync(directory, { recursive: true });
  const receipt = { version: 2, phase, startedAt: new Date().toISOString(), status: 'running', assessmentSha256: sha(__filename), sourceKind: 'product-v2', sourceSha256: source(), harnessHashes: harness(phase), physicalMachines: 1, loopbackOnly: true,
    environment: { os: os.release(), platform: process.platform, arch: process.arch, node: process.versions.node, electron: require('electron/package.json').version }, steps: [], metadata: {} };
  const save = () => { write(path.join(directory, 'receipt.json'), receipt); write(path.join(output, phase + '-run.json'), receipt); };
  const step = async (name, args) => {
    const file = path.join(directory, name + '.log'), startedAt = new Date().toISOString(); const handle = fs.openSync(file, 'w');
    console.log('FUN-01:', phase, name);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const code = await new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', handle, handle] }); child.once('error', reject); child.once('exit', resolve); }).finally(() => fs.closeSync(handle));
    receipt.steps.push({ name, args, status: code === 0 ? 'passed' : 'failed', exitCode: code, startedAt, finishedAt: new Date().toISOString(), log: file, logSha256: sha(file) }); save();
    if (code !== 0) throw Error(name + ' failed; inspect ' + file);
    return file;
  };
  const copyReport = (file, name) => { const data = read(file); if (!data) throw Error('Expected evidence report missing: ' + file); const target = path.join(directory, name + '.json'); write(target, data); return evidence(target); };
  save();
  try {
    if (phase === 'local') {
      await step('compile-electron', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json']);
      await step('copy-engine', ['scripts/copy-room-engine.cjs']);
      await step('typecheck-renderer', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.renderer.json', '--noEmit']);
      await step('policy-tests', ['--test', 'scripts/room-release-acceptance.test.cjs']);
      const unitFile = path.join(directory, 'unit.json');
      await step('units', ['node_modules/vitest/vitest.mjs', 'run', 'renderer/pages/rooms/document-save-status.test.ts', 'electron/sharing/room-documents.test.ts', 'electron/db/room-documents-store.test.ts', 'electron/ipc/room-documents.test.ts', 'electron/sharing/room-sync-editor.test.ts', 'electron/sharing/room-file-sync.test.ts', 'electron/sharing/room-sync-work.test.ts', 'electron/sharing/room-sync-snapshot.test.ts', 'shared/room-file-sync.test.ts', 'electron/ipc/room-file-sync.test.ts', '--maxWorkers=2', '--reporter=default', '--reporter=json', '--outputFile=' + unitFile]);
      const units = read(unitFile); if (!units?.success || units.numFailedTests !== 0) throw Error('Incomplete unit evidence'); receipt.metadata.unitTests = units.numPassedTests; receipt.metadata.unitReport = { path: unitFile, sha256: sha(unitFile) }; save();
      await step('build-sync-ui', ['node_modules/webpack-cli/bin/cli.js', '--config', 'scripts/room-sync-ui.webpack.cjs']);
      await step('documents', ['scripts/smoke-room-file-sync.cjs', '--ui', '--documents']);
      receipt.metadata.documents = copyReport(path.join(root, 'dist/room-sync-ui/evidence/documents-acceptance.json'), 'documents');
      await step('editor', ['scripts/smoke-room-file-sync.cjs', '--ui', '--editor']);
      await step('writers', ['scripts/smoke-room-file-sync.cjs', '--ui', '--writers']);
      await step('faults', ['scripts/smoke-room-file-sync.cjs', '--faults']);
      receipt.metadata.faults = copyReport(path.join(root, 'dist/room-sync-acceptance/windows-faults.json'), 'faults');
      if (receipt.metadata.documents.status !== 'passed' || receipt.metadata.faults.status !== 'passed') throw Error('Native evidence not passed');
    } else if (phase === 'package') {
      const local = read(path.join(output, 'local-run.json')); if (!currentReceipt('local', local, receipt.sourceSha256)) throw Error('Run current local acceptance first');
      await step('build-renderer', ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.renderer.config.js', '--mode', 'production']);
      await step('build-guest', ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.guest.config.js', '--mode', 'production']);
      const prepareLog = await step('prepare-private-installers', ['scripts/prepare-installer-acceptance.cjs']);
      const plan = privatePlan(JSON.parse(fs.readFileSync(prepareLog, 'utf8'))); receipt.metadata.planPath = path.join(plan.root, 'plan.json'); save();
      for (let index = 0; index < plan.configs.length; index++) await step('build-private-' + index, ['node_modules/electron-builder/cli.js', '--config', plan.configs[index], '--win', '--x64', '--publish', 'never']);
      await step('packaged-smoke', ['scripts/smoke-packaged.cjs', path.join(plan.root, 'updated/win-unpacked'), '--executable=' + plan.executable, '--expected-version=3.2.1']);
      receipt.metadata.packaged = copyReport(path.join(root, 'node_modules/.cache/packaged-smoke.json'), 'packaged');
      receipt.metadata.asarSha256 = sha(path.join(plan.root, 'updated/win-unpacked/resources/app.asar'));
      receipt.metadata.archivePath = path.join(plan.root, 'updated/win-unpacked/resources/app.asar');
      if (receipt.metadata.packaged.status !== 'passed' || receipt.metadata.packaged.appAsarSha256 !== receipt.metadata.asarSha256) throw Error('Packaged archive does not match tested evidence');
      receipt.metadata.sameCodeVersions = true;
    } else {
      const packaged = read(path.join(output, 'package-run.json')); if (!currentReceipt('package', packaged, receipt.sourceSha256)) throw Error('Run current package acceptance first');
      const plan = privatePlan(read(packaged.metadata.planPath));
      await step('isolated-installer', ['scripts/smoke-installer.cjs', packaged.metadata.planPath]);
      receipt.metadata.installer = copyReport(path.join(plan.root, 'installer-acceptance.json'), 'installer');
      if (receipt.metadata.installer.status !== 'passed') throw Error('Installer acceptance did not pass');
      if (read(receipt.metadata.installer.path).updatedAsar !== packaged.metadata.asarSha256) throw Error('Installed archive differs from the tested package');
      receipt.metadata.planPath = packaged.metadata.planPath;
    }
    if (source() !== receipt.sourceSha256 || digest(harness(phase)) !== digest(receipt.harnessHashes)) throw Error('Product or relevant test sources changed during this phase; evidence is not current');
    receipt.status = 'passed';
  } catch (error) { receipt.status = 'failed'; receipt.error = String(error); throw error; }
  finally { receipt.finishedAt = new Date().toISOString(); save(); }
  return receipt;
}
async function reconcile(captureFile, output = defaultOutput) {
  const captured = read(captureFile);
  if (!captured || digest(captured.hashes) !== captured.sha256 || productDigest(captured) !== source()) throw Error('Captured execution source does not match the unchanged product');
  for (const phase of ['local', 'package']) {
    const previousPath = path.join(output, phase + '-run.json'), previous = read(previousPath);
    if (!previous || previous.sourceKind || previous.sourceSha256 !== captured.sha256 || requiredSteps[phase].some(name => !previous.steps.some(step => step.name === name))
      || previous.steps.some(step => step.status !== 'passed' || step.exitCode !== 0 || !intact({ path: step.log, sha256: step.logSha256 }))) throw Error('Cannot reuse missing or failed commands');
    if (phase === 'local' && previous.status !== 'passed' || phase === 'package' && previous.error !== 'Error: Packaged archive does not match tested evidence') throw Error('Not a supported report-contract correction');
    const changed = phase === 'local' ? 'scripts/room-release-acceptance.test.cjs' : 'scripts/smoke-packaged.cjs';
    for (const [file, hash] of Object.entries(harness(phase))) if (file !== changed && hash !== (captured.hashes[file] ?? captured.supplemental[file])) throw Error('Relevant execution code changed: ' + file);
    const directory = path.join(output, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-reconciled-' + phase); fs.mkdirSync(directory, { recursive: true });
    write(path.join(directory, 'previous-receipt.json'), previous);
    const replacedStep = phase === 'local' ? 'policy-tests' : 'packaged-smoke';
    const receipt = { ...previous, version: 2, assessmentSha256: sha(__filename), sourceKind: 'product-v2', sourceSha256: source(), harnessHashes: harness(phase), status: 'running', error: undefined,
      reconciledFrom: { path: path.join(directory, 'previous-receipt.json'), sourceSha256: previous.sourceSha256, capture: captureFile, reason: 'Unchanged product; original successful execution preserved. Only changed verification/report code is rerun.' },
      steps: previous.steps.filter(step => step.name !== replacedStep) };
    const save = () => { write(path.join(directory, 'receipt.json'), receipt); write(previousPath, receipt); }; save();
    try {
      let args;
      if (phase === 'local') args = ['--test', 'scripts/room-release-acceptance.test.cjs'];
      else {
        const plan = privatePlan(read(previous.metadata.planPath));
        if (!intact({ path: previous.metadata.archivePath, sha256: previous.metadata.asarSha256 })) throw Error('Previously tested archive changed');
        args = ['scripts/smoke-packaged.cjs', path.join(plan.root, 'updated/win-unpacked'), '--executable=' + plan.executable, '--expected-version=3.2.1'];
      }
      const log = path.join(directory, replacedStep + '.log'), handle = fs.openSync(log, 'w'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const exitCode = await new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', handle, handle] }); child.once('error', reject); child.once('exit', resolve); }).finally(() => fs.closeSync(handle));
      receipt.steps.push({ name: replacedStep, args, status: exitCode === 0 ? 'passed' : 'failed', exitCode, log, logSha256: sha(log), finishedAt: new Date().toISOString() });
      if (exitCode !== 0) throw Error('Changed verification failed: ' + log);
      if (phase === 'package') {
        const file = path.join(directory, 'packaged.json'); write(file, read(path.join(root, 'node_modules/.cache/packaged-smoke.json')));
        receipt.metadata.packaged = evidence(file); receipt.metadata.sameCodeVersions = true;
        if (receipt.metadata.packaged.status !== 'passed' || receipt.metadata.packaged.appAsarSha256 !== receipt.metadata.asarSha256) throw Error('Rechecked package does not match');
      }
      receipt.status = 'passed'; receipt.finishedAt = new Date().toISOString();
      if (!currentReceipt(phase, receipt, source())) throw Error('Reconciled evidence is incomplete');
    } catch (error) { receipt.status = 'failed'; receipt.error = String(error); throw error; }
    finally { save(); }
  }
}
module.exports = { privatePlan, evidence, manualProblems, overview, externalTemplate, runPhase, currentReceipt, requiredSteps, productDigest, harness };
if (require.main === module) void (async () => {
  const args = process.argv.slice(2), command = args[0], option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const output = path.resolve(option('--output', defaultOutput));
  if (command === 'run') { const result = await runPhase(option('--phase', 'local'), output); console.log(JSON.stringify({ phase: result.phase, status: result.status, output })); }
  else if (command === 'reconcile') { await reconcile(path.resolve(option('--from', '')), output); console.log('Reconciled unchanged product; original reports preserved'); }
  else if (command === 'report' || command === 'gate') {
    const externalPath = option('--external', null), result = overview(output, externalPath ? read(path.resolve(externalPath)) : null);
    write(path.join(output, 'overview.json'), result); console.log(JSON.stringify({ phases: Object.fromEntries(Object.entries(result.phases).map(([key, value]) => [key, value.status])), releaseReady: result.releaseGate.ready, unresolved: result.external.unresolved }));
    if (command === 'gate' && !result.releaseGate.ready) process.exitCode = 2;
  } else if (command === 'template') {
    const result = overview(output), file = path.resolve(option('--file', path.join(output, 'physical-protocol.template.json')));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(externalTemplate(result.phases.package.details?.metadata?.asarSha256), null, 2), { flag: 'wx' }); console.log(file);
  } else throw Error('Usage: room-release-acceptance.cjs run --phase local|package|installer | report | gate | template [--output DIRECTORY] [--external PROTOCOL]');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
