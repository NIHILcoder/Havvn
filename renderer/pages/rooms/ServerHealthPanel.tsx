import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useServerError } from './serverErrors';
import { formatBytes } from '../../utils/format-helpers';
import type { RoomServerInstance } from '../../../shared/types';
import type { ServerHealthSample, ServerHealthState } from '../../../shared/server-health';

function trend(history: ServerHealthSample[], key: 'cpuPercent' | 'rssBytes'): string {
  const max = key === 'cpuPercent' ? 100 : Math.max(1, ...history.map(p => p[key] ?? 0));
  let connected = false;
  return history.map((p, i) => {
    const value = p[key]; if (value === undefined) { connected = false; return ''; }
    const command = connected ? 'L' : 'M'; connected = true;
    return command + (i / Math.max(1, history.length - 1) * 280).toFixed(1) + ',' + (54 - value / max * 50).toFixed(1);
  }).join(' ');
}
export const ServerHealthPanel: React.FC<{ instance: RoomServerInstance; roomId: string }> = ({ instance, roomId }) => {
  const { t } = useTranslation(), toast = useHostToast(), errorText = useServerError();
  const [state, setState] = useState<ServerHealthState | null>(null);
  const [error, setError] = useState('');
  const [querying, setQuerying] = useState(false);
  const [tickMissing, setTickMissing] = useState(false);
  const generation = useRef(0);
  const queryPending = useRef(false);
  const invalidate = useCallback(() => { generation.current++; queryPending.current = false; }, []);
  const reload = useCallback(async () => {
    const epoch = generation.current;
    try {
      const next = await window.api.rooms.servers.health(instance.instanceId, roomId);
      if (epoch !== generation.current) return;
      setState(previous => {
        const merged = next.remote && previous?.remote && next.current && previous.current?.at !== next.current.at
          ? [...previous.history, next.current].slice(-60) : next.remote && previous?.remote ? previous.history : next.history;
        return { ...next, history: merged };
      });
      setError('');
    } catch (e) { if (epoch === generation.current) setError(errorText(e)); }
  }, [instance.instanceId, roomId, errorText]);
  useEffect(() => {
    invalidate(); setState(null); setError(''); setQuerying(false); setTickMissing(false);
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => { invalidate(); clearInterval(timer); };
  }, [reload, invalidate]);
  const query = async () => {
    if (queryPending.current) return;
    queryPending.current = true;
    const epoch = generation.current;
    setQuerying(true);
    try {
      const result = await window.api.rooms.servers.queryTicks(instance.instanceId);
      if (epoch !== generation.current) return;
      setTickMissing(!result.available); await reload();
    } catch (e) { if (epoch === generation.current) toast.error(errorText(e)); }
    finally { if (epoch === generation.current) { queryPending.current = false; setQuerying(false); } }
  };
  const current = state?.current;
  return <section className="server-health">
    <div className="server-health-head"><strong><Icon name="activity" size={14} /> {t('rooms.server.health.title')}</strong>
      {current && <span>{new Date(current.at).toLocaleTimeString()}</span>}</div>
    {error && <p role="status">{t('rooms.server.health.unavailable')} <Button size="sm" variant="ghost" onClick={() => void reload()}>{t('common.retry')}</Button></p>}
    {!instance.remote && instance.status !== 'running' && <p>{t('rooms.server.health.stopped')}</p>}
    <div className="server-health-grid">{(['cpuPercent', 'rssBytes'] as const).map(key => <div key={key} className="server-health-metric">
      <span>{t(('rooms.server.health.' + key) as never)}</span>
      <strong>{current?.[key] === undefined ? '—' : key === 'cpuPercent' ? current[key]!.toFixed(1) + '%' : formatBytes(current[key]!)}</strong>
      <svg viewBox="0 0 280 60" role="img" aria-label={t(('rooms.server.health.trend.' + key) as never)}><path d={trend(state?.history ?? [], key)} fill="none" stroke="currentColor" strokeWidth="2" /></svg>
    </div>)}</div>
    <p>{t('rooms.server.health.cpuHint')}</p>
    <div className="server-health-disk"><span>{t('rooms.server.health.disk')}</span><strong>{current?.freeDiskBytes === undefined ? '—' : formatBytes(current.freeDiskBytes)}</strong></div>
    <div className="server-health-ticks"><span>TPS: <b>{current?.tps?.toFixed(2) ?? '—'}</b></span><span>MSPT: <b>{current?.mspt?.toFixed(2) ?? '—'}</b></span></div>
    {current?.tickAt && <p>{t(current.tickSource === 'spark' ? 'rooms.server.health.sparkWindow' : 'rooms.server.health.paperWindow')} · {new Date(current.tickAt).toLocaleTimeString()}</p>}
    {!instance.remote && instance.moduleId === 'minecraft' && <Button size="sm" variant="ghost" disabled={instance.status !== 'running' || querying} loading={querying} onClick={() => void query()}>{t('rooms.server.health.queryTicks')}</Button>}
    {tickMissing && <p role="status">{t('rooms.server.health.noTicks')}</p>}
  </section>;
};
