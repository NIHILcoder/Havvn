import type { ExternalPlayerApi } from '../../shared/external-player';
import { applyExternalWatch } from './watchHistory';
/** Mounted once in App, so leaving the history page or closing a modal loses no samples. */
export function receiveExternalWatch(api: ExternalPlayerApi): () => void {
  let disposed = false, running = false;
  const refresh = async () => {
    if (disposed || running) return; running = true;
    try {
      const updates = await api.watchUpdates(); if (disposed) return;
      const consumed = updates.filter(applyExternalWatch).map(u => u.id);
      if (consumed.length) await api.acknowledgeWatch(consumed);
    } catch { /* Retry after renderer reload or temporary storage/IPC failure. */ }
    finally { running = false; }
  };
  void refresh(); const timer = setInterval(() => void refresh(), 1000);
  return () => { disposed = true; clearInterval(timer); };
}
