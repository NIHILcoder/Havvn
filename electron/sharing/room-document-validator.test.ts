import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentValidation, MaterializedDocument } from './room-document-model';

interface TestWorker {
  emit(event: string, value?: unknown): boolean;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  ref: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  options: unknown;
}
const fixture = vi.hoisted(() => ({ workers: [] as TestWorker[], failConstruction: false }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn(); terminate = vi.fn(async () => 0); ref = vi.fn(); unref = vi.fn();
    constructor(_filename: string, readonly options: unknown) {
      super(); if (fixture.failConstruction) throw new Error('Thread unavailable'); fixture.workers.push(this);
    }
  } };
});
const input: DocumentValidation = { updates: [], replace: 'Fixture' };
const value: MaterializedDocument = { state: 'fixture', text: 'Fixture', changed: false };
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); fixture.workers.length = 0; fixture.failConstruction = false; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('bounded document validation worker', () => {
  it('waits for loaded dependencies before starting the execution deadline', async () => {
    const { validateDocumentInWorker } = await import('./room-document-validator');
    const pending = validateDocumentInWorker(input), worker = fixture.workers[0];
    expect(worker.options).toEqual({ resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    await vi.advanceTimersByTimeAsync(2500);
    expect(worker.postMessage).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
    worker.emit('message', { ready: true }); expect(worker.postMessage).toHaveBeenCalledWith(input);
    await vi.advanceTimersByTimeAsync(1999);
    worker.emit('message', { ok: true, value }); expect(await pending).toEqual(value);
    await vi.advanceTimersByTimeAsync(20_000); expect(worker.terminate).not.toHaveBeenCalled(); expect(worker.unref).toHaveBeenCalled();
  });
  it('keeps the two-second work limit, replaces stuck workers and ignores late replies', async () => {
    const { validateDocumentInWorker, DocumentValidationUnavailableError } = await import('./room-document-validator');
    const first = validateDocumentInWorker(input).catch(error => error as Error), old = fixture.workers[0];
    old.emit('message', { ready: true });
    const second = validateDocumentInWorker(input);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await first; expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(DocumentValidationUnavailableError);
    expect(String(error)).toContain('timed out'); expect(old.terminate).toHaveBeenCalledOnce();
    const next = fixture.workers[1]; old.emit('message', { ok: true, value }); expect(next.postMessage).not.toHaveBeenCalled();
    next.emit('message', { ready: true }); next.emit('message', { ok: true, value }); expect(await second).toEqual(value);
  });
  it('recovers after a bounded startup timeout without accepting an old worker', async () => {
    const { validateDocumentInWorker, DocumentValidationUnavailableError } = await import('./room-document-validator');
    const pending = validateDocumentInWorker(input).catch(error => error as Error), old = fixture.workers[0];
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toBeInstanceOf(DocumentValidationUnavailableError); expect(old.terminate).toHaveBeenCalledOnce();
    const retry = validateDocumentInWorker(input), next = fixture.workers[1];
    old.emit('message', { ready: true }); old.emit('exit', 0); expect(next.postMessage).not.toHaveBeenCalled();
    next.emit('message', { ready: true }); next.emit('message', { ok: true, value }); expect(await retry).toEqual(value);
  });
  it('does not strand the queue when thread construction throws', async () => {
    const { validateDocumentInWorker, DocumentValidationUnavailableError } = await import('./room-document-validator');
    fixture.failConstruction = true;
    await expect(validateDocumentInWorker(input)).rejects.toBeInstanceOf(DocumentValidationUnavailableError);
    fixture.failConstruction = false;
    const retry = validateDocumentInWorker(input), worker = fixture.workers[0];
    worker.emit('message', { ready: true }); worker.emit('message', { ok: true, value }); expect(await retry).toEqual(value);
  });
  it.each(['error', 'exit'])('only treats %s before readiness as a temporary startup failure', async event => {
    const { validateDocumentInWorker, DocumentValidationUnavailableError } = await import('./room-document-validator');
    const cold = validateDocumentInWorker(input).catch(error => error as Error);
    fixture.workers[0].emit(event, new Error('Worker failed'));
    expect(await cold).toBeInstanceOf(DocumentValidationUnavailableError);
    const warm = validateDocumentInWorker(input).catch(error => error as Error), worker = fixture.workers[1];
    worker.emit('message', { ready: true }); worker.emit(event, new Error('Worker failed'));
    expect(await warm).toBeInstanceOf(Error); expect(await warm).not.toBeInstanceOf(DocumentValidationUnavailableError);
  });
  it('bounds queued work and reuses a ready worker without reloading dependencies', async () => {
    const { validateDocumentInWorker, DocumentValidationUnavailableError } = await import('./room-document-validator');
    const pending = Array.from({ length: 17 }, () => validateDocumentInWorker(input));
    await expect(validateDocumentInWorker(input)).rejects.toBeInstanceOf(DocumentValidationUnavailableError);
    const worker = fixture.workers[0]; worker.emit('message', { ready: true });
    for (let i = 0; i < pending.length; i++) {
      worker.emit('message', { ok: true, value }); expect(await pending[i]).toEqual(value);
    }
    expect(fixture.workers).toHaveLength(1); expect(worker.postMessage).toHaveBeenCalledTimes(17);
    expect(vi.getTimerCount()).toBe(0);
  });
});
