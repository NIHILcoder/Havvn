/* eslint-disable @typescript-eslint/no-require-imports -- Reproducible paired renderer verification. */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'artifacts/resource-mode-performance');
const read = mode => JSON.parse(fs.readFileSync(path.join(output, mode, 'summary.json'), 'utf8'));
if (!process.argv.includes('--summarize-only')) {
  for (const mode of ['normal', 'economy']) cp.execFileSync(process.execPath, [path.join(__dirname, 'performance-baseline.cjs'),
    '--runs', '3', '--sample-ms', '6000', '--stats-tick-ms', '100', '--resource-mode', mode, '--output', path.join(output, mode)],
  { cwd: root, stdio: 'inherit', windowsHide: true });
}
const normal = read('normal'), economy = read('economy');
assert.equal(normal.runs, 3); assert.equal(economy.runs, 3);
assert.equal(normal.source.sha256, economy.source.sha256, 'Different source snapshots');
assert.equal(normal.source.bundleSha256, economy.source.bundleSha256, 'Different profiling bundles');
assert.equal(normal.conditions.resourceMode, 'normal'); assert.equal(economy.conditions.resourceMode, 'economy');
const conditions = summary => { const value = structuredClone(summary.conditions); delete value.resourceMode; return value; };
assert.deepEqual(conditions(normal), conditions(economy), 'Different hardware, power, durations or fixture conditions');
assert.deepEqual(normal.rows.map(row => [row.id, row.dataset]), economy.rows.map(row => [row.id, row.dataset]), 'Different scenarios');
const metrics = ['reactCommitCount', 'componentRenderCount', 'cpuPercent', 'privateMiB', 'interactionP95Ms'];
const rows = normal.rows.map((row, index) => ({ id: row.id, metrics: Object.fromEntries(metrics.map(key => {
  const a = row.metrics[key], b = economy.rows[index].metrics[key];
  return [key, { normal: a, economy: b, changePercent: a.median > 0 && Number.isFinite(b.median) ? 100 * (b.median / a.median - 1) : null }];
})) }));
const result = { version: 1, source: normal.source, conditions: conditions(normal), startedAt: normal.startedAt, endedAt: economy.endedAt,
  order: 'three normal runs, then three economy runs; same source and fixture', rows };
fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(result, null, 2));
for (const row of rows) console.log(JSON.stringify({ id: row.id, commits: row.metrics.reactCommitCount, cpu: row.metrics.cpuPercent }));
