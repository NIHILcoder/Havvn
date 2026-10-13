import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';

/** Explicitly armed by the playback leader; changing viewers restarts the countdown. */
export function WatchReadyGate({ fileId, enabled, participants, onStart }: {
  fileId: string; enabled: boolean; participants: Array<{ memberId: string; ready: boolean }>; onStart: () => Promise<void>;
}) {
  const { t } = useTranslation(), toast = useHostToast();
  const [armed, setArmed] = useState(false), [count, setCount] = useState(0);
  const ready = participants.filter(p => p.ready).length;
  const group = participants.map(p => p.memberId).sort().join(',');
  const eligible = enabled && participants.length > 1 && ready === participants.length;
  const latest = useRef({ eligible, fileId, onStart, toast }); latest.current = { eligible, fileId, onStart, toast };
  useEffect(() => { setArmed(false); setCount(0); }, [fileId, enabled]);
  useEffect(() => {
    setCount(0);
    if (!armed || !eligible) return;
    setCount(3);
    const tick = setInterval(() => setCount(c => Math.max(0, c - 1)), 1000);
    const timer = setTimeout(() => {
      clearInterval(tick); setArmed(false); setCount(0);
      if (latest.current.eligible && latest.current.fileId === fileId)
        void latest.current.onStart().catch(e => latest.current.toast.error(String(e instanceof Error ? e.message : e)));
    }, 3000);
    return () => { clearInterval(tick); clearTimeout(timer); };
  }, [armed, eligible, group, fileId]);
  return <div className="room-watch-ready-gate">
    <span role="status"><Icon name="users" size={13} />{t('rooms.watchReady.count').replace('{ready}', String(ready)).replace('{total}', String(participants.length))}
      {armed && <span>{count ? t('rooms.watchReady.countdown').replace('{n}', String(count)) : t('rooms.watchReady.waiting')}</span>}</span>
    <Button variant="ghost" size="sm" disabled={!enabled || participants.length < 2} onClick={() => setArmed(v => !v)}>{t(armed ? 'rooms.watchReady.cancel' : 'rooms.watchReady.start')}</Button>
  </div>;
}
