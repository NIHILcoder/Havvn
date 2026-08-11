/**
 * Grant or revoke operator console access for room members.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import type { RoomMember, RoomState } from '../../../shared/types';
import { useServerError } from './serverErrors';
import './RoomServerPanel.css';

interface ServerAccessPanelProps {
  roomId: string;
  instanceId: string;
}

export const ServerAccessPanel: React.FC<ServerAccessPanelProps> = ({ roomId, instanceId }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  const [operators, setOperators] = useState<string[]>([]);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [access, room] = await Promise.all([
      api.access(instanceId),
      window.api.rooms.get(roomId),
    ]);
    setOperators(access.operators);
    setMembers((room as RoomState | null)?.members?.filter((m) => !m.isSelf) ?? []);
  }, [api, instanceId, roomId]);

  useEffect(() => {
    void reload().catch(() => { /* ignore */ });
    const offRoom = window.api.onRoomUpdate((state) => {
      if (state.roomId === roomId) setMembers(state.members.filter((m) => !m.isSelf));
    });
    const offSrv = api.onUpdate((payload) => {
      if (payload.state.instances.some((i) => i.instanceId === instanceId)) {
        void reload().catch(() => { /* ignore */ });
      }
    });
    return () => { offRoom(); offSrv(); };
  }, [api, instanceId, reload, roomId]);

  const setOperator = async (memberId: string, on: boolean) => {
    setBusy(memberId);
    try {
      if (on) await api.grantOperator(instanceId, memberId);
      else await api.revokeOperator(instanceId, memberId);
      await reload();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="room-server-access">
      <p className="room-server-access-intro">{t('rooms.server.access.intro')}</p>
      <p className="room-server-access-note">{t('rooms.server.access.note')}</p>

      {members.length === 0 ? (
        <p className="room-server-muted">{t('rooms.server.access.noMembers')}</p>
      ) : (
        <ul className="room-server-access-list">
          {members.map((m) => {
            const isOp = operators.includes(m.memberId);
            return (
              <li key={m.memberId} className="room-server-access-row">
                <span className="room-server-access-name">
                  <span className={`room-server-access-dot${m.online ? ' is-online' : ''}`} />
                  {m.name}
                  {!m.online && <span className="room-server-access-offline">{t('rooms.server.access.offline')}</span>}
                </span>
                <span className="room-server-access-role">
                  {isOp ? t('rooms.server.access.roleOperator') : t('rooms.server.access.roleViewer')}
                </span>
                <Toggle
                  checked={isOp}
                  disabled={busy === m.memberId}
                  ariaLabel={t('rooms.server.access.toggle').replace('{name}', m.name)}
                  onChange={(v) => void setOperator(m.memberId, v)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <div className="room-server-access-foot">
        <Icon name="info" size={12} />
        <span>{t('rooms.server.access.foot')}</span>
      </div>
    </div>
  );
};
