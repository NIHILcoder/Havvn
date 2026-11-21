const { test } = require('node:test'), assert = require('node:assert/strict'), { chunks, retention, compare } = require('./performance-heavy-metrics.cjs');
test('measurement integrity includes application, configuration and profiling inputs while ignoring independent site jobs', () => {
  const { measurementInputs } = require('./performance-heavy-metrics.cjs');
  const original = { hashes: { 'renderer/App.tsx': 'ui', 'shared/types.ts': 'types', 'electron/main.ts': 'main', 'webpack.renderer.config.js': 'config', 'package-lock.json': 'deps', 'scripts/performance-heavy.cjs': 'runner', 'scripts/performance-heavy-loader.cjs': 'loader', 'scripts/measure-sync-work.cjs': 'worker', 'scripts/stamp-site-assets.cjs': 'site' } };
  const baseline = measurementInputs(original);
  const changed = (file, value = 'changed') => ({ hashes: { ...original.hashes, [file]: value } });
  assert.deepEqual(measurementInputs(changed('scripts/stamp-site-assets.cjs')), baseline);
  assert.deepEqual(measurementInputs(changed('scripts/smoke-site.cjs')), baseline);
  for (const file of Object.keys(baseline)) {
    assert.notDeepEqual(measurementInputs(changed(file)), baseline, file);
    const hashes = { ...original.hashes }; delete hashes[file];
    assert.notDeepEqual(measurementInputs({ hashes }), baseline, 'deleted ' + file);
  }
  assert.notDeepEqual(measurementInputs(changed('renderer/NewPanel.tsx')), baseline);
  assert.notDeepEqual(measurementInputs(changed('scripts/performance-new-loader.cjs')), baseline);
});
test('measures nested eager modules and counts initial assets once', () => {
  const graph = { assets: [{ name: 'boot.js', size: 100 }, { name: 'other.js', size: 20 }], chunks: [
    { initial: true, files: ['boot.js'], modules: [{ modules: [{ name: './renderer/components/ThemeEditor.tsx', size: 40 }] }] },
    { initial: true, files: ['boot.js'], modules: [] }, { initial: false, files: ['other.js'], modules: [{ name: './renderer/components/StreamPlayerModal.tsx', size: 20 }] }] };
  const result = chunks(graph); assert.equal(result.initialBytes, 100); assert.equal(result.modules['ThemeEditor.tsx'].initial, true); assert.equal(result.modules['StreamPlayerModal.tsx'].initial, false);
});
test('refuses comparisons when the harness or conditions changed', () => {
  const report = { harness: 'same', product: { initialBytes: 100 }, runs: [{ conditions: { cycles: 8 }, rows: [] }] };
  assert.throws(() => compare(report, { ...report, harness: 'other' }), /harness/);
  assert.throws(() => compare(report, { ...report, runs: [{ conditions: { cycles: 3 }, rows: [] }] }), /conditions/);
  assert.equal(compare(report, { ...report, product: { initialBytes: 80 } }).initialBytes.saved, 20);
});
test('retention regression identifies growth and preserves raw cycle samples', () => {
  const row = values => ({ cycles: values.map(used => ({ heap: { usedSize: used * 1048576 }, dom: { nodes: 10, jsEventListeners: 2 } })) });
  assert.equal(retention(row([10, 11, 12, 13])).slopeMiBPerCycle, 1); assert.equal(retention(row([10, 10, 10])).growthMiB, 0);
  assert.deepEqual(retention(row([10, 9, 8])).usedMiB, [10, 9, 8]);
});
test('distinguishes recycled detached trees from accumulating DOM and listeners', () => {
  const row = values => ({ cycles: values.map(nodes => ({ heap: { usedSize: 1048576 }, dom: { nodes, jsEventListeners: nodes } })) });
  assert.equal(retention(row([100, 200, 100, 200, 200, 100, 200, 100])).nodeFloorDrift, 0);
  assert.equal(retention(row([100, 200, 300, 400, 500, 600, 700, 800])).listenerFloorDrift, 400);
});
test('before-source reconstruction requires the original hash, including line endings', () => {
  const crypto = require('node:crypto'), path = require('node:path'), loader = require('./performance-heavy-before-loader.cjs');
  const file = 'renderer/components/index.ts', original = "export { StreamPlayerModal } from './StreamPlayerModal';\r\nexport { ThemeEditor } from './ThemeEditor';\r\nexport { Onboarding } from './Onboarding';\r\n";
  const current = "export { StreamPlayerModal } from './LazyStreamPlayer';\nexport { Onboarding } from './Onboarding';\n";
  const context = { resourcePath: path.resolve(__dirname, '..', file), getOptions: () => ({ before: true, hashes: { [file]: crypto.createHash('sha256').update(original).digest('hex') } }) };
  assert.equal(loader.call(context, current), original);
  assert.throws(() => loader.call(context, current + 'changed'), /no longer matches/);
});
