/* eslint-disable @typescript-eslint/no-explicit-any -- Run real startup with no elevation, driver or OS network changes. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = ts.createSourceFile('helper-main.ts', readFileSync(new URL('./helper-main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'runLanHelper');
if (!node) throw Error('Missing runLanHelper');
const js = ts.transpileModule(node.getText(source).replace(/^export /, '') + '\nrunLanHelper;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(stage: 'listen' | 'sweep' | 'config' | 'ready') {
  const listen = deferred<void>(), sweep = deferred<string[]>(), config = deferred<unknown>();
  const controls: any[] = [], pipes: any[] = [];
  const req = { adapterName: 'Havvn LAN-fixture', vip: 1, prefix: 16, subnetBase: 0 };
  const context = {
    hlog: vi.fn(), logPath: undefined, startedAt: 0,
    process: { pid: 1, argv: [], on: vi.fn(), exit: vi.fn() }, assertElevated: vi.fn(),
    parseHelperArgs: () => ({ parentPid: 2, handshakePath: 'fixture', appPath: 'fixture' }),
    readHandshake: () => ({ pipeName: 'fixture', token: 'fixture', setup: req }),
    startParentWatchdog: () => vi.fn(), LAN_NAME_PREFIX: 'Havvn LAN-',
    held: { wintun: { readWaitEvent: vi.fn(() => 0) }, session: {}, req },
    LanPipeServer: class {
      sendControl = (m: unknown) => { controls.push(m); }; close = vi.fn();
      constructor(public options: any) { pipes.push(this); }
      listen = () => stage === 'listen' ? listen.promise : Promise.resolve();
    },
    orphanSweep: vi.fn(() => stage === 'sweep' ? sweep.promise : Promise.resolve([])),
    resolveDll: () => undefined, loadWintun: vi.fn(() => ({})),
    applyNetConfig: vi.fn(() => stage === 'config' ? config.promise : Promise.resolve({})),
    revertNetConfig: vi.fn(async () => {}), vipToString: () => '100.88.0.1', setImmediate: vi.fn(),
  };
  const run: () => Promise<void> = vm.runInNewContext(js, context);
  return { context, controls, pipes, listen, sweep, config, run };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('helper setup cancellation', () => {
  it.each(['listen', 'sweep', 'config'] as const)('cannot announce ready or start its pump after disconnect during %s', async stage => {
    const f = fixture(stage); const pending = f.run(); await flush();
    f.pipes[0].options.onClose(); await flush();
    if (stage === 'listen') f.listen.resolve();
    if (stage === 'sweep') f.sweep.resolve([]);
    if (stage === 'config') f.config.resolve({});
    await pending;
    expect(f.controls.some(m => m.t === 'ready')).toBe(false);
    expect(f.context.setImmediate).not.toHaveBeenCalled();
    if (stage !== 'config') expect(f.context.applyNetConfig).not.toHaveBeenCalled();
    expect(f.context.revertNetConfig).toHaveBeenCalledOnce();
    expect(f.context.process.exit).toHaveBeenCalledWith(0);
  });

  it('announces readiness and starts one pump after successful setup', async () => {
    const f = fixture('ready'); await f.run();
    expect(f.controls.filter(m => m.t === 'ready')).toHaveLength(1);
    expect(f.context.applyNetConfig).toHaveBeenCalledOnce(); expect(f.context.setImmediate).toHaveBeenCalledOnce();
  });
});
