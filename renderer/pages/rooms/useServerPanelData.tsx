/** Visible load failures and retry, with stale replies isolated per instance. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useTranslation } from '../../utils/i18nContext';
import { useServerError } from './serverErrors';

export function useServerPanelData<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const currentLoad = useRef(load);
  currentLoad.current = load;
  const reload = useCallback(async () => {
    // An operation on the previous instance may finish after selection changed.
    // It must not invalidate a newer instance's request or paint its reply here.
    if (currentLoad.current !== load) return null;
    const ticket = ++generation.current;
    setLoading(true);
    try {
      const next = await load();
      if (ticket === generation.current && currentLoad.current === load) { setData(next); setError(null); }
      return next;
    } catch (err) {
      if (ticket === generation.current) setError(err);
      throw err;
    } finally {
      if (ticket === generation.current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    setData(null); setError(null);
    void reload().catch(() => { /* displayed by ServerPanelStatus */ });
    // This counter is intentionally read at cleanup time to invalidate EVERY
    // pending request, including refreshes started after this effect mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++generation.current; };
  }, [reload]);
  return { data, setData, reload, loading, error, ready: data !== null && error === null };
}

export function ServerPanelStatus({ loading, error, reload }: {
  loading: boolean; error: unknown; reload: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const errorText = useServerError();
  if (error !== null) return <div className="room-panel-status is-error" role="alert">
    <span>{errorText(error)}</span>
    <Button size="sm" loading={loading} onClick={() => void reload().catch(() => {})}>{t('common.retry')}</Button>
  </div>;
  return <div className="room-panel-status" role="status" aria-busy={loading}>{loading ? t('common.loading') : null}</div>;
}
