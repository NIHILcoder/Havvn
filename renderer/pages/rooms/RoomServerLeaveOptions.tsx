import React from 'react';
import { Select } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import type { RoomServerInstance } from '../../../shared/gameserver-types';

export const RoomServerLeaveOptions: React.FC<{
  instances: RoomServerInstance[] | null;
  mode: 'stop' | 'local';
  busy: boolean;
  onMode: (mode: 'stop' | 'local') => void;
}> = ({ instances, mode, busy, onMode }) => {
  const { t } = useTranslation();
  return <div className="rooms-leave-servers">
    <p>{t('rooms.server.leave.summary')}</p>
    {instances && instances.length > 0 && <ul>{instances.map(instance => <li key={instance.instanceId}>
      {instance.name} — {t(`rooms.server.status.${instance.status}` as never)}
      {instance.scheduleEnabled ? ` · ${t('rooms.server.leave.schedule')}` : ''}
    </li>)}</ul>}
    <Select ariaLabel={t('rooms.server.leave.summary')} value={mode} onChange={value => onMode(value === 'local' ? 'local' : 'stop')} options={[
      { value: 'stop', label: t('rooms.server.leave.stop') },
      ...(instances?.length ? [{ value: 'local', label: t('rooms.server.leave.local') }] : []),
    ]} disabled={busy} />
    <p className="rooms-modal-desc">{t(mode === 'local' ? 'rooms.server.leave.localHint' : 'rooms.server.leave.stopHint')}</p>
  </div>;
};
