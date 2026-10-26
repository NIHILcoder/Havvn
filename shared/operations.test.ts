import { describe, expect, it, vi } from 'vitest';
import { createOperationOwner, isOperationActive, operationProgress } from './operations';
import { downloadOperation } from './download-operation';
import { roomConnectionOperation, serverOperation } from './connection-operation';
import { buildRoomDiagnosticReport } from './room-diagnostics';

describe('operation ownership', () => {
  it.each(['failed', 'cancelled'] as const)('ignores a late success after %s and a callback from an older attempt', status => {
    const owner = createOperationOwner();
    const first = owner.start('choose-file', 'save-dialog');
    expect(() => owner.start('write-export')).toThrow('already in progress');
    owner.finish(first, status);
    expect(owner.finish(first, 'succeeded')).toBe(false);
    const second = owner.start('write-export');
    expect(owner.snapshot()?.lastResult).toEqual({ stage: 'choose-file', status });
    expect(owner.update(first, { stage: 'write-export', status: 'running', progress: null, waitingFor: null, actions: [] })).toBe(false);
    expect(owner.finish(first, 'succeeded')).toBe(false);
    expect(isOperationActive(owner.snapshot())).toBe(true);
    owner.finish(second, 'succeeded');
    expect(owner.snapshot()).toMatchObject({ id: second, status: 'succeeded', lastResult: { stage: 'write-export', status: 'succeeded' } });
  });
  it('returns isolated snapshots and tolerates observers closing', () => {
    const listener = vi.fn(() => { throw new Error('window closed'); });
    const owner = createOperationOwner(listener), id = owner.start('metadata', 'metadata-peers', ['inspect']);
    owner.snapshot()!.actions.length = 0;
    expect(owner.snapshot()?.actions).toEqual(['inspect']);
    expect(owner.finish(id, 'failed')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it.each([[NaN, 1], [1, Infinity], [1, 0], [-1, 1], [2, 1]])('rejects unmeasured work %s/%s', (done, total) => {
    expect(operationProgress(done, total)).toBeNull();
  });
});

const download = { status: 'downloading' as const, progress: .9, totalSize: 1000 };
describe('download operation projection', () => {
  it('does not substitute file completion or network traffic for verification progress', () => {
    expect(downloadOperation(download, { stage: 'checking' })).toMatchObject({ stage: 'checking', status: 'running', progress: null });
    expect(downloadOperation(download, { stage: 'checking', fraction: .2 }).progress).toEqual({ completed: .2, total: 1 });
    expect(downloadOperation({ ...download, status: 'completed' }, { stage: 'checking', fraction: .3 })).toMatchObject({ stage: 'checking', status: 'running' });
  });
  it('distinguishes queued verification from a pause and preserves a real verification on a paused record', () => {
    expect(downloadOperation({ ...download, status: 'paused' }, { stage: 'checking', checkQueued: true, fraction: .9 }))
      .toMatchObject({ status: 'waiting', waitingFor: 'check-slot', progress: null, actions: ['inspect'] });
    expect(downloadOperation({ ...download, status: 'paused' })).toMatchObject({ waitingFor: 'paused', actions: ['resume'] });
  });
  it('keeps metadata with no known denominator indeterminate', () => {
    expect(downloadOperation({ ...download, totalSize: 0 })).toMatchObject({ waitingFor: 'engine', progress: null });
    expect(downloadOperation({ ...download, totalSize: 0 }, { stage: 'metadata' })).toMatchObject({ waitingFor: 'metadata-peers', progress: null });
    expect(downloadOperation(download, { stage: 'metadata', fraction: .25 }).progress).toEqual({ completed: .25, total: 1 });
  });
  it('never invents the cause of a stall with connected peers', () => {
    expect(downloadOperation(download, { peers: 2, downSpeedBps: 0 })).toMatchObject({ waitingFor: 'unknown' });
    expect(downloadOperation(download, { peers: 0, downSpeedBps: 0 })).toMatchObject({ waitingFor: 'peers' });
    expect(downloadOperation(download)).toMatchObject({ waitingFor: 'engine' });
    expect(downloadOperation(download, { peers: 2, downSpeedBps: 100 })).toMatchObject({ status: 'running', waitingFor: null });
  });
  it('gives failure/removal priority over late activity, without calling a pause cancellation', () => {
    expect(downloadOperation({ ...download, status: 'error' }, { stage: 'checking', fraction: 1 })).toMatchObject({ status: 'failed', actions: ['retry', 'inspect'] });
    expect(downloadOperation({ ...download, status: 'removed' }, { stage: 'transfer' })).toMatchObject({ status: 'cancelled' });
    expect(downloadOperation({ ...download, status: 'paused' })).toMatchObject({ status: 'waiting', waitingFor: 'paused' });
  });
});

describe('connection and server projections', () => {
  it('does not treat starting/stopping requests as confirmed readiness/exit or estimate installation work', () => {
    expect(serverOperation({ status: 'starting' })).toMatchObject({ status: 'waiting', waitingFor: 'server-ready', progress: null });
    expect(serverOperation({ status: 'stopping' })).toMatchObject({ status: 'waiting', waitingFor: 'server-exit' });
    expect(serverOperation({ status: 'running' })).toMatchObject({ status: 'succeeded', lastResult: { stage: 'server-start' } });
    expect(serverOperation({ status: 'stopped', failReason: 'stop-timeout' })).toMatchObject({ status: 'failed' });
    expect(serverOperation({ status: 'installing' })?.progress).toBeNull();
    expect(serverOperation({ status: 'starting', role: 'viewer' })?.actions).not.toContain('stop');
    expect(serverOperation({ status: 'starting', role: 'host' })?.actions).toContain('stop');
  });
  it('projects observed room phases without treating silence as an error or readiness as file completion', () => {
    const report = buildRoomDiagnosticReport(undefined, { state: 'ready' }, false, 'test', undefined, 1000);
    report.connection.phase = 'waiting';
    expect(roomConnectionOperation(report)).toMatchObject({ status: 'waiting', waitingFor: 'participants', progress: null, lastResult: null });
    report.connection.phase = 'ready';
    expect(roomConnectionOperation(report)).toMatchObject({ status: 'succeeded', stage: 'room-connect', progress: null });
    report.connection.phase = 'suspended';
    expect(roomConnectionOperation(report)).toMatchObject({ status: 'waiting', waitingFor: 'network', actions: ['inspect'] });
    report.connection.phase = 'removed';
    expect(roomConnectionOperation(report)).toMatchObject({ status: 'cancelled', actions: [] });
  });
});
