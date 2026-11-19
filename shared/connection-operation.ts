import type { RoomDiagnosticReport } from './room-diagnostics';
import type { RoomServerInstance } from './gameserver-types';
import type { OperationState } from './operations';

/** Connection readiness describes the control channel, never all room files or transports. */
export function roomConnectionOperation(report: RoomDiagnosticReport): OperationState {
  const phase = report.connection.phase;
  const base: OperationState = { stage: phase === 'syncing' ? 'room-sync' : 'room-connect', status: 'waiting', progress: null,
    waitingFor: null, actions: ['inspect'], lastResult: report.connection.lastConnectedAt
      ? { status: 'succeeded', stage: 'room-connect' } : null };
  if (phase === 'removed') return { ...base, status: 'cancelled', actions: [], lastResult: { status: 'cancelled', stage: base.stage } };
  if (phase === 'engine-failed') return { ...base, status: 'failed', actions: ['retry', 'inspect'], lastResult: { status: 'failed', stage: base.stage } };
  if (phase === 'ready') return { ...base, status: 'succeeded', lastResult: { status: 'succeeded', stage: 'room-connect' } };
  if (phase === 'offline' || phase === 'suspended') return { ...base, waitingFor: 'network', actions: phase === 'suspended' ? ['inspect'] : ['retry', 'inspect'] };
  if (phase === 'syncing') return { ...base, waitingFor: 'sync' };
  if (phase === 'authenticating') return { ...base, waitingFor: 'identity' };
  return { ...base, waitingFor: phase === 'connecting' ? 'connection' : 'participants', actions: ['retry', 'inspect'] };
}

/** Adapts the supervisor's confirmed lifecycle; submitting start/stop is not completion. */
export function serverOperation(instance: Pick<RoomServerInstance, 'status' | 'failReason'> & Partial<Pick<RoomServerInstance, 'role' | 'isHost'>>): OperationState | null {
  const { status, failReason } = instance;
  const canOperate = instance.role === 'host' || instance.role === 'operator';
  const stage = status === 'installing' || failReason === 'install-failed' ? 'server-install'
    : status === 'stopping' || status === 'stopped' || failReason === 'stop-timeout' ? 'server-stop' : 'server-start';
  const base: OperationState = { stage, status: 'running', progress: null, waitingFor: null, actions: ['inspect'], lastResult: null };
  if (status === 'crashed' || failReason) return { ...base, status: 'failed', actions: ['inspect'], lastResult: { status: 'failed', stage } };
  if (status === 'idle') return null;
  if (status === 'running' || status === 'stopped') return { ...base, status: 'succeeded', lastResult: { status: 'succeeded', stage } };
  // Installation's weighted steps are not a measured total of bytes/work. Keep
  // the stage and real cancel control; do not present its estimate as a percentage.
  if (status === 'installing') return { ...base, actions: instance.isHost ? ['cancel', 'inspect'] : ['inspect'] };
  return { ...base, status: 'waiting', waitingFor: status === 'stopping' ? 'server-exit' : 'server-ready',
    actions: status === 'starting' && canOperate ? ['stop', 'inspect'] : ['inspect'] };
}
