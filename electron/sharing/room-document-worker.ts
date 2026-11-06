import { parentPort } from 'node:worker_threads';
import { materializeDocument, type DocumentValidation } from './room-document-model';
parentPort?.on('message', (input: DocumentValidation) => {
  try { parentPort!.postMessage({ ok: true, value: materializeDocument(input) }); }
  catch (error) { parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Invalid document update' }); }
});
// Signal after the model and its dependencies are loaded and the handler is installed.
parentPort?.postMessage({ ready: true });
