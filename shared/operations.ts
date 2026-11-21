/** A view of the owner's state, never a second state machine for the subsystem. */
export type OperationStage = 'queued' | 'metadata' | 'checking' | 'transfer' | 'finished'
  | 'choose-file' | 'prepare-export' | 'write-export'
  | 'server-install' | 'server-start' | 'server-stop' | 'room-connect' | 'room-sync' | 'restore-download';
export type OperationStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export type OperationWait = 'metadata-peers' | 'peers' | 'download-slot' | 'check-slot'
  | 'paused' | 'engine' | 'unknown' | 'save-dialog' | 'server-ready' | 'server-exit'
  | 'participants' | 'network' | 'connection' | 'identity' | 'sync';
export type OperationAction = 'pause' | 'resume' | 'retry' | 'inspect' | 'cancel' | 'cancel-in-dialog' | 'stop';
export interface OperationResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  stage: OperationStage;
}
export interface OperationState {
  stage: OperationStage;
  status: OperationStatus;
  /** Null means unmeasured. Transfer counters are never a substitute for work done. */
  progress: { completed: number; total: number } | null;
  waitingFor: OperationWait | null;
  actions: OperationAction[];
  lastResult: OperationResult | null;
}
export interface OwnedOperation extends OperationState {
  id: number;
  revision: number;
}
export function isOperationActive(operation: Pick<OperationState, 'status'> | null | undefined): boolean {
  return operation?.status === 'running' || operation?.status === 'waiting';
}
export function operationProgress(completed: number, total: number): OperationState['progress'] {
  return Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= 0 && completed <= total
    ? { completed, total } : null;
}
export function operationPercent(operation: OperationState): number | null {
  const progress = operation.progress && operationProgress(operation.progress.completed, operation.progress.total);
  return progress ? progress.completed / progress.total * 100 : null;
}

/** One owner, one in-flight attempt. Stale callbacks cannot change a terminal result or a newer attempt. */
export function createOperationOwner(changed: () => void = () => {}) {
  let current: OwnedOperation | null = null;
  let sequence = 0, revision = 0;
  const snapshot = () => current ? structuredClone(current) : null;
  const notify = () => { try { changed(); } catch { /* A closed observer cannot fail the work. */ } };
  return {
    snapshot,
    start(stage: OperationStage, waitingFor: OperationWait | null = null, actions: OperationAction[] = []): number {
      if (isOperationActive(current)) throw new Error('An operation is already in progress');
      current = { id: ++sequence, revision: ++revision, stage, status: waitingFor ? 'waiting' : 'running',
        progress: null, waitingFor, actions: [...actions], lastResult: current?.lastResult ?? null };
      notify();
      return current.id;
    },
    update(id: number, patch: Pick<OperationState, 'stage' | 'status' | 'waitingFor' | 'progress' | 'actions'>): boolean {
      if (!current || current.id !== id || !isOperationActive(current)) return false;
      // Terminal results must go through finish(), where they become confirmed results.
      if (!isOperationActive(patch)) throw new Error('Use finish to confirm an operation result');
      current = { ...current, ...structuredClone(patch), revision: ++revision };
      notify();
      return true;
    },
    finish(id: number, status: OperationResult['status']): boolean {
      if (!current || current.id !== id || !isOperationActive(current)) return false;
      current = { ...current, status, waitingFor: null, actions: status === 'failed' ? ['retry'] : [],
        lastResult: { status, stage: current.stage }, revision: ++revision };
      notify();
      return true;
    },
  };
}
