// Reproducible local acceptance. Serial workloads avoid CPU-induced timeout failures.
// Native tests use synthetic profiles/media; hardware/network changes are explicitly excluded.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-rooms-acceptance-'));
const nativeOnly = process.argv.includes('--native-only');
const report = { startedAt: new Date().toISOString(), scope: 'local-automatic-only', checks: [],
  unavailable: ['second physical computer', 'real symmetric NAT/TURN', 'physical sleep/network switch',
    'NekoBox proxy/TUN and VPN interruption packet capture', 'physical audio hotplug and system sound',
    'real captured-window close', 'installed old-version interoperability'] };
const checks = [
  ...(!nativeOnly ? [
    ['typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.electron.json', '--noEmit']],
    ['typecheck-renderer', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.renderer.json', '--noEmit']],
    ['typecheck-guest', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.guest.json', '--noEmit']],
    ['tests', ['--npm-test']],
  ] : []),
  ...['lifecycle', 'peers', 'voice', 'playback', 'controls', 'data-ui', 'diagnostics', 'secrets', 'storage', 'network-lifecycle']
    .map(name => ['native-' + name, ['scripts/smoke-room-' + name + '.cjs']]),
];

async function run(name, args) {
  const logPath = path.join(output, name + '.log'), log = fs.openSync(logPath, 'w');
  const started = Date.now(); console.log('Acceptance starting:', name);
  const env = { ...process.env, VITEST_MAX_WORKERS: '2' }; delete env.ELECTRON_RUN_AS_NODE;
  const npmTest = args[0] === '--npm-test';
  const executable = npmTest ? (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm') : process.execPath;
  const commandArgs = npmTest ? (process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test']) : args;
  const child = spawn(executable, commandArgs, { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  // Individual native harnesses have their own deadlines and destroy only their fixtures.
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('exit', code => resolve({ code }));
  });
  const entry = { name, status: result.code === 0 ? 'passed' : 'failed', exitCode: result.code,
    durationMs: Date.now() - started, logPath, ...(result.error ? { error: result.error } : {}) };
  report.checks.push(entry); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Acceptance result:', name, entry.status, Math.round(entry.durationMs / 1000) + 's');
  if (entry.status === 'failed') console.error(fs.readFileSync(logPath, 'utf8').slice(-5000));
}

(async () => {
  console.log('Acceptance evidence:', output);
  for (const [name, args] of checks) await run(name, args);
  report.completedAt = new Date().toISOString(); report.passed = report.checks.every(check => check.status === 'passed');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Local acceptance ' + (report.passed ? 'passed' : 'failed') + '. Report:', path.join(output, 'report.json'));
  process.exitCode = report.passed ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
