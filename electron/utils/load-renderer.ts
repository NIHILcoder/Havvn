import type { WebContents } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';

type RendererContents = Pick<WebContents, 'loadURL' | 'isDestroyed'>;
const TRANSIENT_LOAD_ERRORS = new Set(['ERR_FAILED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED', 'ERR_EMPTY_RESPONSE', 'ERR_INCOMPLETE_CHUNKED_ENCODING']);

/** Retry only the fixed, local development URL; security denials are never retried. */
export async function loadDevelopmentRenderer(contents: RendererContents, onRetry: (error: unknown, attempt: number) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await contents.loadURL('http://127.0.0.1:3000/'); return; }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (contents.isDestroyed() || attempt >= 3 || typeof code !== 'string' || !TRANSIENT_LOAD_ERRORS.has(code)) throw error;
      onRetry(error, attempt + 1);
      await delay(400 * attempt);
      if (contents.isDestroyed()) throw error;
    }
  }
}
