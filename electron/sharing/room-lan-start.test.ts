/* eslint-disable @typescript-eslint/no-explicit-any -- Execute real engine functions with isolated IPC/helper doubles. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAN_HELPER_SETUP_TIMEOUT_MS, LAN_START_TIMEOUT_MS } from '../../shared/lan-startup';

const source = ts.createSourceFile('room-engine.ts', readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['teardownLan', 'settleLanReady', 'lanHelperReady', 'onLanControl', 'lanStart'];
const runtime = names.map(name => {
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw Error('Missing engine function: ' + name);
  return node.getText(source);
}).join('\n');
const js = ts.transpileModule(runtime + '\n({ lanStart, teardownLan });', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(isHost = true, readyOnConnect = false) {
  const peers = { setRelayEnabled: vi.fn(), startAsHost: vi.fn(), start: vi.fn(), suspend: vi.fn(), sessionId: () => 'session', buildState: vi.fn(() => ({ selfAdmitted: true })) };
  const room: any = { id: 'room', lan: isHost ? undefined : peers };
  const clients: any[] = [];
  const context: any = {
    rooms: new Map([['room', room]]), netSuspended: false, lanRelayEnabled: true,
    LAN_HELPER_SETUP_TIMEOUT_MS, setTimeout, clearTimeout,
    createLanSession: vi.fn(() => peers), log: vi.fn(), pushState: vi.fn(), ipcRenderer: { send: vi.fn() },
    LanPipeClient: class {
      sendControl = vi.fn(); close = vi.fn();
      constructor(public options: any) { clients.push(this); }
      async connect() { if (readyOnConnect) this.options.onControl({ t: 'ready', adapter: 'fixture', vip: 1 }); }
    },
  };
  const engine = vm.runInNewContext(js, context);
  const start = () => engine.lanStart('room', { sessionId: 'session', pipeName: 'fixture', token: 'fixture', isHost, admit: ['peer'] });
  const ready = () => clients[0].options.onControl({ t: 'ready', adapter: 'fixture', vip: 1 });
  return { room, clients, peers, context, engine, start, ready };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('LAN startup waits for the physical adapter', () => {
  it.each([true, false])('does not announce or start routing until ready (host=%s)', async isHost => {
    const f = fixture(isHost);
    const pending = f.start(); await flush();
    expect(f.peers.startAsHost).not.toHaveBeenCalled(); expect(f.peers.start).not.toHaveBeenCalled();
    expect(f.context.pushState).not.toHaveBeenCalled();
    f.ready(); await expect(pending).resolves.toMatchObject({ ok: true });
    expect(isHost ? f.peers.startAsHost : f.peers.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts ready that arrives before connect resolves', async () => {
    const f = fixture(true, true);
    await expect(f.start()).resolves.toMatchObject({ ok: true });
    expect(f.peers.startAsHost).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['vpn', 'room'])('fails immediately if %s changes while the pipe connects', async change => {
    const f = fixture();
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    if (change === 'vpn') f.context.netSuspended = true; else f.context.rooms.clear();
    expect(await result).toMatch(/cancelled/i); expect(f.peers.startAsHost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a timed-out setup instead of reporting a connected LAN', async () => {
    const f = fixture();
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    await flush(); await vi.advanceTimersByTimeAsync(LAN_HELPER_SETUP_TIMEOUT_MS + 1);
    expect(await result).toMatch(/setup timed out/i);
    expect(f.peers.startAsHost).not.toHaveBeenCalled(); expect(f.room.lanPipe).toBeUndefined();
    expect(f.clients[0].close).toHaveBeenCalled(); expect(f.room.lanReadyWaiters).toEqual([]);
  });

  it('cannot start after Stop while the helper is configuring the adapter', async () => {
    const f = fixture();
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    await flush(); f.engine.teardownLan(f.room);
    expect(await result).toMatch(/cancelled/i);
    f.ready(); await flush();
    expect(f.peers.startAsHost).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks VPN suspension after waiting for setup', async () => {
    const f = fixture();
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    await flush(); f.context.netSuspended = true; f.ready();
    expect(await result).toMatch(/cancelled/i); expect(f.peers.startAsHost).not.toHaveBeenCalled();
  });

  it('fails immediately when the helper disconnects during setup', async () => {
    const f = fixture();
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    await flush(); f.clients[0].options.onClose();
    expect(await result).toMatch(/cancelled/i); expect(f.peers.startAsHost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot join if the host revokes admission during setup', async () => {
    const f = fixture(false);
    const result = f.start().then(() => 'incorrect success', (error: Error) => error.message);
    await flush(); f.peers.buildState.mockReturnValue({ selfAdmitted: false }); f.ready();
    expect(await result).toMatch(/not invited/i); expect(f.peers.start).not.toHaveBeenCalled();
    expect(f.clients[0].close).toHaveBeenCalled();
  });

  it('allows a setup slower than the previous 30-second request budget', async () => {
    const f = fixture();
    const pending = f.start(); await flush(); await vi.advanceTimersByTimeAsync(35_000);
    expect(f.peers.startAsHost).not.toHaveBeenCalled(); f.ready();
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(LAN_START_TIMEOUT_MS).toBeGreaterThan(LAN_HELPER_SETUP_TIMEOUT_MS + 20_000);
  });
});
