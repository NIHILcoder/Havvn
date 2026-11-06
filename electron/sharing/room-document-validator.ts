import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DocumentValidation, MaterializedDocument } from './room-document-model';

interface Job { input: DocumentValidation; resolve(value: MaterializedDocument): void; reject(error: Error): void }
export class DocumentValidationUnavailableError extends Error {
  readonly code = 'DOCUMENT_VALIDATION_UNAVAILABLE';
}
const queue: Job[] = [];
let active: Job | undefined, worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, ready = false;
function finish(error?: Error, value?: MaterializedDocument, reset = false): void {
  const job = active; active = undefined; clearTimeout(timer);
  if (reset) { const previous = worker; worker = undefined; ready = false; void previous?.terminate().catch(() => {}); }
  if (job) { if (error) job.reject(error); else job.resolve(value!); }
  if (!queue.length) worker?.unref();
  pump();
}
function dispatch(): void {
  if (!worker || !ready || !active) return;
  clearTimeout(timer);
  // Loading Yjs and starting a Windows thread are not part of a document's
  // execution allowance. Untrusted work still has the same two-second limit.
  timer = setTimeout(() => finish(new Error('Document validation timed out'), undefined, true), 2000); timer.unref?.();
  try { worker.postMessage(active.input); } catch { finish(new Error('Invalid document validation request'), undefined, true); }
}
function pump(): void {
  if (active || !queue.length) return;
  active = queue.shift()!;
  if (!worker) {
    let current: Worker;
    try { current = new Worker(path.join(__dirname, 'room-document-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } }); }
    catch { finish(new DocumentValidationUnavailableError('Document checking could not start. Try again shortly.'), undefined, true); return; }
    worker = current;
    current.on('message', (result: { ready?: boolean; ok?: boolean; value?: MaterializedDocument; error?: string }) => {
      if (worker !== current) return;
      if (result?.ready === true) { if (!ready) { ready = true; dispatch(); } return; }
      if (!ready || !active) return;
      finish(result?.ok ? undefined : new Error(result?.error || 'Invalid document update'), result?.value);
    });
    current.on('error', error => { if (worker === current) finish(ready ? error : new DocumentValidationUnavailableError('Document checking could not start. Try again shortly.'), undefined, true); });
    current.on('exit', () => { if (worker === current) finish(ready ? new Error('Document validation stopped') : new DocumentValidationUnavailableError('Document checking stopped while starting. Try again shortly.'), undefined, true); });
  }
  worker.ref();
  if (ready) dispatch();
  else { timer = setTimeout(() => finish(new DocumentValidationUnavailableError('Document checking is taking too long to start. Try again shortly.'), undefined, true), 15000); timer.unref?.(); }
}
/** A shared worker keeps typing responsive and bounds malformed CRDT CPU, stack, heap and queue. */
export function validateDocumentInWorker(input: DocumentValidation): Promise<MaterializedDocument> {
  if (queue.length >= 16) return Promise.reject(new DocumentValidationUnavailableError('Document checking is busy. Try again shortly.'));
  return new Promise((resolve, reject) => { queue.push({ input, resolve, reject }); pump(); });
}
