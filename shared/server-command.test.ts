import { afterEach, expect, it, vi } from 'vitest';
import { PendingServerCommands, ServerCommandLedger, SERVER_COMMAND_TIMEOUT, commandCanonical, commandReplyCanonical, validCommandRequest, type ServerCommandRequest } from './server-command';
const request = (over: Partial<ServerCommandRequest> = {}): ServerCommandRequest => ({
  commandId: 'command-0000000001', hostId: 'host', by: 'operator', instanceId: 'server', command: 'stop', at: Date.now(), expiresAt: Date.now() + 30000, ...over,
});
afterEach(() => vi.useRealTimers());
it('deduplicates across process restarts; conflicting IDs and expired retries never execute', () => {
  let now = 1000; const ledger = new ServerCommandLedger(2, () => now); const run = vi.fn(() => ({ ok: true as const }));
  const r = request({ at: now, expiresAt: 31000 });
  expect(ledger.execute('room', r, run).ok).toBe(true);
  expect(ledger.execute('room', { ...r, at: 1001 }, run).ok).toBe(true); expect(run).toHaveBeenCalledOnce();
  expect(ledger.execute('room', { ...r, command: 'op attacker' }, run)).toMatchObject({ reason: 'command-conflict' });
  now = 31000; expect(ledger.execute('room', r, run)).toMatchObject({ reason: 'command-expired' }); expect(run).toHaveBeenCalledOnce();
});
it('refuses capacity overflow instead of evicting dedup evidence and remembers stdin exceptions', () => {
  const ledger = new ServerCommandLedger(1); const r = request(); const run = vi.fn(() => { throw new Error('possibly written'); });
  expect(ledger.execute('room', r, run)).toMatchObject({ reason: 'command-unknown' });
  expect(ledger.execute('room', r, run)).toMatchObject({ reason: 'command-unknown' }); expect(run).toHaveBeenCalledOnce();
  expect(ledger.execute('room', request({ commandId: 'command-0000000002' }), run)).toMatchObject({ reason: 'command-busy' });
});
it('binds signatures to room, target, command and expiry', () => {
  const r = request(); expect(commandCanonical('a', r)).not.toBe(commandCanonical('b', r));
  for (const change of [{ hostId: 'other' }, { expiresAt: r.expiresAt + 1 }, { commandId: 'command-0000000002' }, { command: 'list' }])
    expect(commandCanonical('a', r)).not.toBe(commandCanonical('a', { ...r, ...change }));
  const reply = { commandId: r.commandId, hostId: 'host', to: r.by, instanceId: r.instanceId, ok: true, at: r.at };
  expect(commandReplyCanonical('a', reply)).not.toBe(commandReplyCanonical('a', { ...reply, ok: false }));
});
it('does not allow newline injection or an extended/future expiry', () => {
  expect(validCommandRequest(request({ command: 'list\nstop' }))).toBe(false);
  expect(validCommandRequest(request({ expiresAt: Date.now() + 60000 }))).toBe(false);
  expect(validCommandRequest(request({ at: Date.now() + 6000 }))).toBe(false);
});
it('ignores wrong host/recipient/server replies and acknowledges only the correlated request', async () => {
  const pending = new PendingServerCommands(); const r = request(); const result = pending.wait(r);
  const reply = { commandId: r.commandId, hostId: r.hostId, to: r.by, instanceId: r.instanceId, ok: true, at: Date.now() };
  for (const change of [{ hostId: 'wrong' }, { to: 'wrong' }, { instanceId: 'wrong' }, { commandId: 'wrong' }]) expect(pending.accept({ ...reply, ...change })).toBe(false);
  expect(pending.accept(reply)).toBe(true); await expect(result).resolves.toEqual({ ok: true }); expect(pending.accept(reply)).toBe(false);
});
it('timeouts and shutdown settle as unknown outcome without resubmitting or leaving timers', async () => {
  vi.useFakeTimers(); const pending = new PendingServerCommands(); const first = pending.wait(request());
  vi.advanceTimersByTime(SERVER_COMMAND_TIMEOUT); await expect(first).resolves.toMatchObject({ reason: 'command-unknown' });
  const second = pending.wait(request()); pending.cancel(); await expect(second).resolves.toMatchObject({ reason: 'command-unknown' }); expect(vi.getTimerCount()).toBe(0);
});
