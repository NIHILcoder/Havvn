/* eslint-disable @typescript-eslint/no-require-imports -- Offline profiling summaries. */
const watched = ['RoomsPage.tsx', 'RoomDocumentsEditor.tsx', 'StreamPlayerModal.tsx', 'ThemeEditor.tsx', 'GallerySamples.tsx'];
/** Site publishing and other independent CLI jobs are not inputs to this UI run. */
function measurementInputs(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.hashes).filter(([file]) => !file.startsWith('scripts/')
    || file.startsWith('scripts/performance-') || ['scripts/measure-sync-work.cjs', 'scripts/smoke-ui-fonts.cjs'].includes(file)).sort(([a], [b]) => a.localeCompare(b)));
}
function chunks(graph) {
  const initial = graph.chunks.filter(chunk => chunk.initial), files = new Set(initial.flatMap(chunk => chunk.files));
  const initialBytes = graph.assets.filter(asset => files.has(asset.name)).reduce((sum, asset) => sum + asset.size, 0);
  const modules = Object.fromEntries(watched.map(name => [name, { initial: false, bytes: 0 }]));
  const visit = (module, eager) => {
    for (const name of watched) if (module.name?.replace(/\\/g, '/').endsWith('/' + name)) { modules[name].initial ||= eager; modules[name].bytes = Math.max(modules[name].bytes, module.size || 0); }
    module.modules?.forEach(child => visit(child, eager));
  };
  graph.chunks.forEach(chunk => chunk.modules?.forEach(module => visit(module, !!chunk.initial)));
  return { initialBytes, modules };
}
function retention(row) {
  const values = row.cycles.map(cycle => cycle.heap.usedSize / 1048576), n = values.length, center = (n - 1) / 2, mean = values.reduce((a,b) => a+b,0) / n;
  const denominator = values.reduce((sum, _value, index) => sum + (index - center) ** 2, 0);
  // Blink may retain a detached tree for one or two GC tasks. Compare the
  // lower envelopes of equal windows, rather than arbitrary final snapshots.
  const floorDrift = read => { const samples = row.cycles.map(read), half = Math.floor(n / 2); return Math.min(...samples.slice(-half)) - Math.min(...samples.slice(0, half)); };
  return { usedMiB: values, growthMiB: values.at(-1) - values[0], slopeMiBPerCycle: denominator ? values.reduce((sum, value, index) => sum + (index - center) * (value - mean), 0) / denominator : 0,
    domNodes: row.cycles.map(cycle => cycle.dom.nodes), liveDomNodes: row.cycles.map(cycle => cycle.ui?.domNodes ?? null), listeners: row.cycles.map(cycle => cycle.dom.jsEventListeners), nodeFloorDrift: floorDrift(cycle => cycle.dom.nodes), listenerFloorDrift: floorDrift(cycle => cycle.dom.jsEventListeners) };
}
function compare(reference, candidate) {
  if (JSON.stringify(reference.harness) !== JSON.stringify(candidate.harness)) throw Error('Profiling harness changed');
  const conditions = JSON.stringify(reference.runs[0].conditions);
  if ([...reference.runs, ...candidate.runs].some(run => JSON.stringify(run.conditions) !== conditions)) throw Error('Measurement conditions changed');
  const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
  const rows = reference.runs[0].rows.map(({ section }, index) => {
    const left = reference.runs.map(run => run.rows[index]), right = candidate.runs.map(run => run.rows[index]);
    if ([...left, ...right].some(row => row?.section !== section)) throw Error('Scenario order changed');
    const latency = (a, key) => median(a.map(row => row[key]));
    return { section, coldOpenMs: { before: latency(left, 'coldOpenMs'), after: latency(right, 'coldOpenMs') },
      warmOpenMs: { before: median(left.flatMap(row => row.cycles.map(c => c.openMs))), after: median(right.flatMap(row => row.cycles.map(c => c.openMs))) },
      retainedGrowthMiB: right.map(row => row.retention.growthMiB), retainedSlopeMiB: right.map(row => row.retention.slopeMiBPerCycle) };
  });
  return { initialBytes: { before: reference.product.initialBytes, after: candidate.product.initialBytes, saved: reference.product.initialBytes - candidate.product.initialBytes }, rows };
}
module.exports = { chunks, retention, compare, measurementInputs };
