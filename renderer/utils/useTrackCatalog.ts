import { useCallback, useEffect, useRef, useState } from 'react';

interface Catalog<T> { key: string | null; status: 'idle' | 'loading' | 'ready' | 'error'; tracks: T[] }

/** Empty and unavailable are different. Responses belong to one media file. */
export function useTrackCatalog<T>(key: string | null, load: () => Promise<T[]>) {
  const [state, setState] = useState<Catalog<T>>({ key: null, status: 'idle', tracks: [] });
  const [revision, setRevision] = useState(0);
  const current = useRef({ key, load }); current.current = { key, load };
  const pending = useRef<{ key: string; active: boolean }>();
  const metadata = useRef<string | null>(null), autoRetried = useRef<string | null>(null);
  const schedule = useCallback(() => {
    if (!key || pending.current?.key === key && pending.current.active) return;
    setRevision(value => value + 1);
  }, [key]);
  useEffect(() => {
    if (!key) { setState({ key, status: 'idle', tracks: [] }); return; }
    const request = { key, active: true }; pending.current = request;
    const loader = current.current.load;
    setState({ key, status: 'loading', tracks: [] });
    void Promise.resolve().then(loader).then(tracks => {
      if (request.active && current.current.key === key) { request.active = false; setState({ key, status: 'ready', tracks }); }
    }).catch(() => {
      if (request.active && current.current.key === key) { request.active = false; setState({ key, status: 'error', tracks: [] }); }
    }).finally(() => { request.active = false; });
    return () => { request.active = false; };
  }, [key, revision]);
  // A probe before the file becomes readable can legitimately return no tracks.
  // Retry that empty answer once after metadata, without looping on empty files.
  const [metadataRevision, setMetadataRevision] = useState(0);
  const afterMetadata = useCallback(() => { metadata.current = key; setMetadataRevision(value => value + 1); }, [key]);
  useEffect(() => {
    if (key && state.key === key && state.status === 'ready' && !state.tracks.length
      && metadata.current === key && autoRetried.current !== key) {
      autoRetried.current = key; schedule();
    }
  }, [key, state, metadataRevision, schedule]);
  const retry = useCallback(() => { autoRetried.current = key; schedule(); }, [key, schedule]);
  const visible: Catalog<T> = state.key === key ? state : { key, status: key ? 'loading' : 'idle', tracks: [] };
  return { ...visible, retry, afterMetadata };
}
