/**
 * Compact list of running game servers — shown in the LAN panel when a session is up.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import type { RoomServerInstance, RoomServerState } from '../../../shared/types';
import './RoomLanPanel.css';

interface RoomLanServerWidgetProps {
  roomId: string;
  lanActive: boolean;
}

export const RoomLanServerWidget: React.FC<RoomLanServerWidgetProps> = ({ roomId, lanActive }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const host = useHostWindow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [instances, setInstances] = useState<RoomServerInstance[]>([]);

  useEffect(() => {
    if (!lanActive) {
      setInstances([]);
      return;
    }
    let alive = true;
    void window.api.rooms.servers.state(roomId).then((s: RoomServerState) => {
      if (alive) setInstances(s.instances.filter((i) => i.status === 'running' && i.address));
    }).catch(() => { /* ignore */ });
    const off = window.api.rooms.servers.onUpdate((payload) => {
      if (payload.roomId !== roomId) return;
      setInstances(payload.state.instances.filter((i) => i.status === 'running' && i.address));
    });
    return () => { alive = false; off(); };
  }, [roomId, lanActive]);

  if (!lanActive || instances.length === 0) return null;

  const copyAddress = (address: string) => {
    const win = resolveHostWindow(rootRef.current, host).window;
    win.navigator.clipboard?.writeText(address)
      .then(() => toast.success(t('rooms.lan.copied')))
      .catch(() => { /* clipboard blocked */ });
  };

  return (
    <div className="room-lan-servers" ref={rootRef}>
      <div className="room-lan-servers-head">
        <Icon name="server" size={12} />
        <span>{t('rooms.lan.servers')}</span>
      </div>
      <ul className="room-lan-servers-list">
        {instances.map((inst) => (
          <li key={inst.instanceId} className="room-lan-servers-item">
            <span className="room-lan-servers-name">{inst.name}</span>
            <code className="room-lan-servers-addr">{inst.address}</code>
            {inst.players && (
              <span className="room-lan-servers-players">
                {inst.players.online}/{inst.players.max}
              </span>
            )}
            <button
              type="button"
              className="room-lan-copy"
              title={t('rooms.lan.copyIp')}
              onClick={() => copyAddress(inst.address!)}
            >
              <Icon name="copy" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
