/* eslint-disable @typescript-eslint/no-require-imports -- Native Node smoke harness. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), ts = require('typescript');
const file = path.join(__dirname, '../electron/gameserver/process-health.ts');
const mod = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
new Function('require', 'module', 'exports', source)(require, mod, mod.exports);
(async () => {
  if (!['win32', 'linux'].includes(process.platform)) { console.log('Native process metrics unavailable on this platform'); return; }
  const first = await mod.exports.readProcessHealth(process.pid);
  assert.ok(first && first.rssBytes > 0 && first.cpuMs >= 0, 'native process reading must be available');
  const history = new mod.exports.ServerHealthHistory(), at = Date.now();
  history.sample(at, process.pid, first, null);
  // Measurable work in THIS test process, never in a user's game.
  const until = Date.now() + 150; let work = 0;
  while (Date.now() < until) work = Math.sin(work + 0.5);
  const second = await mod.exports.readProcessHealth(process.pid);
  assert.ok(second && second.identity === first.identity && second.cpuMs > first.cpuMs);
  const sample = history.sample(Date.now(), process.pid, second, null);
  assert.ok(sample.cpuPercent > 0 && sample.cpuPercent <= 100);
  assert.equal(await mod.exports.readProcessHealth(2147483647), null);
  console.log(JSON.stringify({ ok: true, platform: process.platform, rssBytes: sample.rssBytes, cpuPercent: sample.cpuPercent, work }));
})().catch(error => { console.error(error); process.exitCode = 1; });
