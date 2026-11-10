/**
 * Compact list of running game servers — shown in the LAN panel when a session is up.
 */
import { Button } from '../../components/Button';
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { useHostWindow, resolveHostWindow } from '../../utils/hostWindow';
import { writeClipboardText } from '../../utils/clipboard';
import type { RoomServerInstance, RoomServerState } from '../../../shared/types';
import './RoomLanPanel.css';

interface RoomLanServerWidgetProps {
  roomId: string;
  lanActive: boolean;
  nameOf: (memberId: string) => string;
}

export const RoomLanServerWidget: React.FC<RoomLanServerWidgetProps> = ({ roomId, lanActive, nameOf }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const host = useHostWindow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<{ roomId: string; instances: RoomServerInstance[] }>({ roomId, instances: [] });

  useEffect(() => {
    if (!lanActive) {
      setSnapshot({ roomId, instances: [] });
      return;
    }
    let alive = true;
    let receivedUpdate = false;
    const apply = (state: RoomServerState) => {
      setSnapshot({ roomId, instances: state.instances.filter((i) => i.status === 'running' && i.address) });
    };
    // Subscribe before reading. A newer push must win over an older in-flight
    // snapshot, especially when a server stops or its LAN address changes.
    const off = window.api.rooms.servers.onUpdate((payload) => {
      if (!alive || payload.roomId !== roomId) return;
      receivedUpdate = true;
      apply(payload.state);
    });
    void window.api.rooms.servers.state(roomId).then((state: RoomServerState) => {
      if (alive && !receivedUpdate) apply(state);
    }).catch(() => {
      if (alive && !receivedUpdate) setSnapshot({ roomId, instances: [] });
    });
    return () => { alive = false; off(); };
  }, [roomId, lanActive]);

  // Do not expose the previous room's addresses while this room loads.
  const instances = snapshot.roomId === roomId ? snapshot.instances : [];
  if (!lanActive || instances.length === 0) return null;

  const copyAddress = (address: string) => {
    const win = resolveHostWindow(rootRef.current, host).window;
    void writeClipboardText(address, win)
      .then(() => toast.success(t('rooms.lan.copied')))
      .catch(() => toast.error(t('common.copyFailed')));
  };

  return (
    <div className="room-lan-servers" ref={rootRef}>
      <div className="room-lan-servers-head">
        <Icon name="server" size={12} />
        <span>{t('rooms.lan.servers')}</span>
      </div>
      <p className="room-lan-address-hint">{t('rooms.lan.serverAddressHint')}</p>
      <ul className="room-lan-servers-list">
        {instances.map((inst) => (
          <li key={inst.instanceId} className="room-lan-servers-item">
            <div className="room-lan-servers-info">
              <span className="room-lan-servers-name" title={inst.name}>{inst.name}</span>
              <span className="room-lan-peer-role">{t('rooms.lan.serverHostedBy').replace('{name}', nameOf(inst.hostId))}</span>
            </div>
            {inst.players && (
              <span className="room-lan-servers-players">
                {inst.players.online}/{inst.players.max}
              </span>
            )}
            <Button size="sm"
              type="button"
              className="room-lan-server-address"
              title={`${t('rooms.server.copyAddress')} · ${inst.name}`}
              aria-label={`${t('rooms.server.copyAddress')} · ${inst.name}`}
              onClick={() => copyAddress(inst.address!)}
            >
              <code className="room-lan-servers-addr">{inst.address}</code>
              <Icon name="copy" size={12} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
};
