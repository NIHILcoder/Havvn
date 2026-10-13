/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node script. */
// Medians across repeated fresh-process runs; no forced GC or estimated RAM savings.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = path.resolve(process.argv[2] || 'artifacts/performance');
const quantile = (values, p) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = values => quantile(values, .5);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const runs = Object.fromEntries(['before', 'after'].map(variant => [variant, [1, 2, 3].map(i =>
  JSON.parse(fs.readFileSync(path.join(dir, variant + '-' + i + '.json'), 'utf8')))]));
const reference = runs.before[0];
for (const variant of Object.keys(runs)) for (const run of runs[variant]) {
  assert.equal(run.electron, reference.electron); assert.deepEqual(run.hardware, reference.hardware);
  assert.equal(run.mode, reference.mode); assert.deepEqual(run.rows.map(r => r.scenario), reference.rows.map(r => r.scenario));
  assert.deepEqual(run.sourceHashes, runs[variant][0].sourceHashes, 'Product source must stay fixed during repeat runs');
  for (const row of run.rows) assert.equal(row.memory.length, 16);
}
const rows = reference.rows.map((row, index) => {
  const variants = {};
  for (const variant of Object.keys(runs)) {
    const samples = runs[variant].map(run => run.rows[index]);
    const metrics = {
      rendererPrivateMiB: r => r.memory.map(ms => ms.filter(m => m.role === 'Tab').reduce((s, m) => s + m.privateKiB / 1024, 0)),
      rendererWorkingSetMiB: r => r.memory.map(ms => ms.filter(m => m.role === 'Tab').reduce((s, m) => s + m.workingSetKiB / 1024, 0)),
      allProcessesPrivateMiB: r => r.memory.map(ms => ms.reduce((s, m) => s + m.privateKiB / 1024, 0)),
      rendererHeapMiB: r => r.heap.map(h => h.renderer.usedSize / 1048576),
      cpuPercent: r => r.cpu.map(ms => ms.reduce((s, m) => s + m.percent, 0)),
      reactCommitMs: r => r.ui.commits, statsCallbackMs: r => r.ui.tickMs,
      rendererTimerLagMs: r => r.ui.lag, mainTimerLagMs: r => r.mainLagMs,
    };
    const summary = {};
    for (const [key, values] of Object.entries(metrics)) {
      const sets = samples.map(values);
      const medians = sets.map(median);
      summary[key] = { median: median(medians), p95: median(sets.map(a => quantile(a, .95))),
        peak: median(sets.map(a => Math.max(...a))), mean: median(sets.map(mean)),
        runMedianMin: Math.min(...medians), runMedianMax: Math.max(...medians) };
    }
    const names = ['AppContent', 'DownloadsPage', 'DownloadItem', 'RoomsPage'];
    variants[variant] = { metrics: summary, renders: Object.fromEntries(names.map(name => [name, median(samples.map(s => s.ui.renders[name] || 0))])),
      statsListeners: median(samples.map(s => s.ui.listeners)), visibleDownloadRows: median(samples.map(s => s.ui.rows)) };
  }
  return { scenario: row.scenario, ...variants };
});
const result = { at: new Date().toISOString(), hardware: reference.hardware, electron: reference.electron, mode: reference.mode,
  repetitions: 3, samplesPerScenarioPerRun: 16, periodMs: 750,
  method: 'Nearest-rank median/p95/peak per run, then median of the three run values. CPU is median of per-run means.',
  baseline: 'Only the five renderer files in sourceHashes are taken from HEAD; other working-tree code is common to both variants.',
  limits: 'Synthetic IPC, one changed torrent out of 1000 per tick, no real swarm/room engine/transcoder. Software GPU, hidden window, profiling React. This measures UI cost, not total Havvn RAM under network load.',
  sources: Object.fromEntries(Object.entries(runs).map(([key, values]) => [key, values.map(v => ({ label: v.label, at: v.at, sourceHashes: v.sourceHashes }))])), rows };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 2));
for (const row of rows) console.log(JSON.stringify({ scenario: row.scenario,
  reactP95Ms: [row.before.metrics.reactCommitMs.p95, row.after.metrics.reactCommitMs.p95],
  rendererPrivateMiB: [row.before.metrics.rendererPrivateMiB.median, row.after.metrics.rendererPrivateMiB.median],
  cpuPercent: [row.before.metrics.cpuPercent.mean, row.after.metrics.cpuPercent.mean],
  renders: [row.before.renders, row.after.renders] }));
