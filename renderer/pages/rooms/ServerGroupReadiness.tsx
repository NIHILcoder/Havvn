import React, { useEffect, useRef, useState } from 'react';
import { Toggle } from '../../components/Toggle';
import { useTranslation } from '../../utils/i18nContext';
import type { RoomServerInstance, RoomState } from '../../../shared/types';
import { SERVER_PREPARATION_CAPABILITY, localServerPreparation, serverPreparationBasis, serverPreparationRoster, type ServerPreparationInput } from '../../../shared/server-readiness';
import './ServerGroupReadiness.css';

export function ServerGroupReadiness({ instance, room, confirmed }: { instance: RoomServerInstance; room: RoomState | null; confirmed: boolean }) {
  const { t, language } = useTranslation(), [sharing, setSharing] = useState(false), [error, setError] = useState(false), [now, setNow] = useState(Date.now);
  const [fingerprint, setFingerprint] = useState({ canonical: '', hash: '' });
  const canonical = serverPreparationBasis(instance.hostId, instance, room?.files ?? []);
  const basis = fingerprint.canonical === canonical ? fingerprint.hash : '';
  const local = localServerPreparation(instance, room, confirmed);
  const compatible = !!room && (instance.isHost || !!room.members.find(member => member.memberId === instance.hostId && !member.guest)?.capabilities?.includes(SERVER_PREPARATION_CAPABILITY));
  const roomId = room?.roomId;
  const latest = useRef({ basis, local, compatible }); latest.current = { basis, local, compatible };
  useEffect(() => {
    let alive = true;
    void globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then(value => { if (alive) setFingerprint({ canonical, hash: [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('') }); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [canonical]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 3000); return () => clearInterval(timer); }, []);
  useEffect(() => { setSharing(false); setError(false); }, [instance.instanceId, instance.hostId]);
  useEffect(() => {
    if (!sharing || instance.local || !roomId) return;
    let stopped = false, pending = false, sentAt = -Infinity, last: ServerPreparationInput | null = null;
    const withdraw = () => { if (last) void window.api.rooms.servers.preparation(roomId, { ...last, state: 'withdrawn' }).catch(() => {}); };
    const publish = async () => {
      const current = latest.current;
      if (pending || !current.basis || !current.compatible || Date.now() - sentAt < 3000) return;
      pending = true; sentAt = Date.now();
      const input: ServerPreparationInput = { hostId: instance.hostId, instanceId: instance.instanceId, basis: current.basis, ...current.local };
      try { const result = await window.api.rooms.servers.preparation(roomId, input); if (!result.ok) throw Error('Preparation unavailable'); last = input; if (!stopped) setError(false); }
      catch { if (!stopped) setError(true); }
      finally { pending = false; if (stopped) withdraw(); }
    };
    void publish(); const timer = setInterval(() => { void publish(); }, 5000);
    return () => { stopped = true; clearInterval(timer); if (!pending) withdraw(); };
  }, [sharing, instance.instanceId, instance.hostId, instance.local, roomId]);
  if (instance.local || !room) return null;
  const roster = serverPreparationRoster(instance, room, basis, now), members = roster.slice(0, 64);
  const ready = roster.filter(row => row.state === 'ready').length;
  return <section className="server-group-readiness" data-server-group-readiness>
    <h4>{t('rooms.server.group.title')} · {ready}/{room.members.length}</h4>
    <p>{t('rooms.server.group.hint')}</p>
    <label><Toggle checked={sharing} disabled={!compatible || !basis} onChange={setSharing} ariaLabel={t('rooms.server.group.share')} /><span>{t('rooms.server.group.share')}</span></label>
    {!compatible && <p>{t('rooms.server.group.unsupportedHost')}</p>}
    {error && <p role="status">{t('rooms.server.group.failed')}</p>}
    <ul>{members.map(({ member, report, state }) => {
      return <li key={member.memberId} data-preparation-member={member.memberId}><strong>{member.name}</strong><span>{t(`rooms.server.group.state.${state}`)}</span>{report && <small>{report.readyFiles !== null ? `${report.readyFiles}/${report.totalFiles} · ` : ''}{new Date(report.at).toLocaleTimeString(language)}</small>}</li>;
    })}</ul>
    {room.members.length > members.length && <p>{t('rooms.server.group.more').replace('{count}', String(room.members.length - members.length))}</p>}
  </section>;
}
