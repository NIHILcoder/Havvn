/* eslint-disable @typescript-eslint/no-require-imports -- Node's CommonJS acceptance-policy tests. */
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const kit = require('./room-release-acceptance.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-release-proof-'));
  t.after(() => { const target = path.resolve(root); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('havvn-release-proof-')) throw Error('Unexpected fixture'); fs.rmSync(target, { recursive: true, force: true }); });
  return root;
}
function write(root, name, value) { const file = path.join(root, name), data = JSON.stringify(value); fs.writeFileSync(file, data); return { path: file, sha256: hash(data) }; }
function localReceipt(root) {
  const log = path.join(root, 'test.log'); fs.writeFileSync(log, 'fixture only');
  return { status: 'passed', sourceKind: 'product-v2', sourceSha256: 'a'.repeat(64), harnessHashes: kit.harness('local'), finishedAt: new Date().toISOString(), steps: kit.requiredSteps.local.map(name => ({ name, status: 'passed', exitCode: 0, log, logSha256: hash('fixture only') })), metadata: {
    unitReport: write(root, 'unit.json', { success: true, numFailedTests: 0 }),
    documents: write(root, 'documents.json', { passed: true, checks: [{ id: 'fixture', passed: true }] }),
    faults: write(root, 'faults.json', { passed: true, checks: [{ id: 'fixture', passed: true }] }),
  } };
}
test('accepts only complete current local receipts and detects changed evidence or logs', t => {
  const root = fixture(t), receipt = localReceipt(root), source = 'a'.repeat(64);
  assert.equal(kit.currentReceipt('local', receipt, source), true);
  assert.equal(kit.currentReceipt('local', receipt, 'b'.repeat(64)), false);
  assert.equal(kit.currentReceipt('local', { ...receipt, steps: receipt.steps.slice(1) }, source), false);
  assert.equal(kit.currentReceipt('local', { ...receipt, harnessHashes: {} }, source), false);
  fs.writeFileSync(receipt.metadata.documents.path, 'changed'); assert.equal(kit.currentReceipt('local', receipt, source), false);
  const fresh = localReceipt(root); fs.appendFileSync(fresh.steps[0].log, 'changed'); assert.equal(kit.currentReceipt('local', fresh, source), false);
});
test('a historical success boolean with no actual checks is not evidence', t => {
  const root = fixture(t), proof = write(root, 'empty.json', { passed: true, checks: [] });
  assert.equal(kit.evidence(proof.path).status, 'not-passed');
  assert.equal(kit.evidence(path.join(root, 'missing.json')).status, 'missing');
});
test('reporting scripts do not change the product fingerprint; product code still does', () => {
  const captured = { hashes: { 'renderer/app.ts': 'a'.repeat(64), 'scripts/check.cjs': 'b'.repeat(64) }, supplemental: Object.fromEntries(['tsconfig.electron.json', 'tsconfig.guest.json', 'webpack.guest.config.js'].map(file => [file, 'c'.repeat(64)])) };
  const before = kit.productDigest(captured);
  captured.hashes['scripts/check.cjs'] = 'd'.repeat(64); assert.equal(kit.productDigest(captured), before);
  captured.hashes['renderer/app.ts'] = 'd'.repeat(64); assert.notEqual(kit.productDigest(captured), before);
});
test('browser guest changes invalidate product evidence independently of reporting scripts', () => {
  const captured = { hashes: { 'electron/main.ts': 'a'.repeat(64) }, guestHashes: { 'guest/mesh.ts': 'b'.repeat(64) },
    supplemental: Object.fromEntries(['tsconfig.electron.json', 'tsconfig.guest.json', 'webpack.guest.config.js'].map(file => [file, 'c'.repeat(64)])) };
  const before = kit.productDigest(captured);
  captured.guestHashes['guest/mesh.ts'] = 'd'.repeat(64);
  assert.notEqual(kit.productDigest(captured), before);
});
test('local receipts never close the physical/network release gate', t => {
  const root = fixture(t), report = kit.overview(root, null, 'a'.repeat(64), false);
  assert.equal(report.releaseGate.ready, false); assert.equal(report.releaseGate.flagRemoved, false);
  assert.equal(report.external.status, 'pending'); assert.equal(report.executionScope.physicalMachines, 1);
});
function reviewed() {
  const report = kit.externalTemplate('c'.repeat(64)); report.review = { accepted: true, operator: 'test-fixture', at: '2026-10-25T00:00:00Z' };
  report.devices = ['a', 'b'].map(id => ({ id, kind: 'physical', os: 'fixture', appVersion: '3.2.1', appAsarSha256: 'c'.repeat(64) }));
  for (const run of report.runs) Object.assign(run, { status: 'passed', loopbackOnly: false, deviceIds: ['a', 'b'], evidence: ['fixture proof'], natEvidence: 'operator-observed fixture', transportPath: 'turn-relay', userTurn: true, cases: run.cases.map(item => ({ ...item, status: 'passed' })) });
  report.compatibility = { status: 'passed', sameCodeVersionLabels: false, evidence: ['fixture proof'], binaries: [{ sha256: 'd'.repeat(64), version: 'old', realReleasedBuild: true }, { sha256: 'c'.repeat(64), version: 'new' }] }; return report;
}
test('physical protocol requires explicit review, two devices and the tested candidate', () => {
  assert(kit.manualProblems(kit.externalTemplate('c'.repeat(64)), 'c'.repeat(64)).length);
  const proof = reviewed(); assert.deepEqual(kit.manualProblems(proof, 'c'.repeat(64)), []);
  proof.devices = proof.devices.slice(0, 1); assert(kit.manualProblems(proof, 'c'.repeat(64)).includes('two-distinct-physical-devices-required'));
  assert(kit.manualProblems(reviewed(), 'e'.repeat(64)).includes('external-candidate-does-not-match'));
});
test('loopback, application relay and artificial version labels cannot certify external acceptance', () => {
  const proof = reviewed(); proof.runs[0].loopbackOnly = true; proof.runs[3].transportPath = 'room-relay'; proof.compatibility.sameCodeVersionLabels = true;
  const problems = kit.manualProblems(proof, 'c'.repeat(64));
  for (const reason of ['lan-not-accepted', 'room-relay-is-not-turn-proof', 'real-older-client-not-reviewed']) assert(problems.includes(reason));
});
test('private installer plans cannot target the production application or escape their root', () => {
  const id = 'abcdef', root = path.resolve(__dirname, '../release/installer-acceptance', id), plan = { id, root, namespace: 'HavvnAcceptance' + id, appId: 'dev.havvn.acceptance.' + id, executable: 'HavvnAcceptance' + id + '.exe', installDirectory: path.join(root, 'installed'), profileBase: path.join(root, 'profile'), baselineInstaller: path.join(root, 'baseline/test.exe'), updatedInstaller: path.join(root, 'updated/test.exe') };
  assert.equal(kit.privatePlan(plan), plan);
  assert.throws(() => kit.privatePlan({ ...plan, installDirectory: path.dirname(root) }), /escapes/);
  assert.throws(() => kit.privatePlan({ ...plan, namespace: 'Havvn' }), /identity/);
});
