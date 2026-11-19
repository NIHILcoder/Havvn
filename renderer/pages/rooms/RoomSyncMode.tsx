import React, { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Select } from '../../components/Select';
import { useTranslation } from '../../utils/i18nContext';
import { syncMode, type SyncMode, type SyncRootView } from '../../../shared/room-file-sync-ui';
import './RoomWorkspace.css';

export function SyncModePicker({ value, onChange, writer, disabled }: { value: SyncMode; onChange(value: SyncMode): void; writer: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const modes: SyncMode[] = writer ? ['sync', 'receive', 'send', 'manual'] : ['receive', 'manual'];
  return <div className="room-sync-mode-picker">
    <Select className="room-sync-mode-select" ariaLabel={t('rooms.workspace.mode')} value={value} disabled={disabled} onChange={value => onChange(value as SyncMode)}
      options={modes.map(value => ({ value, label: t(`rooms.workspace.mode.${value}`) }))} />
    <p>{t(`rooms.workspace.modeHint.${value}`)}</p>
  </div>;
}

export function RoomSyncMode({ root, disabled, onApply }: { root: SyncRootView; disabled?: boolean; onApply(mode: SyncMode): Promise<void> }) {
  const { t } = useTranslation(), active = syncMode(root);
  const [selected, setSelected] = useState<SyncMode>(active);
  useEffect(() => { setSelected(active); }, [active, root.publisher, root.rootId]);
  const apply = (mode: SyncMode) => {
    if (!disabled) void onApply(mode);
  };
  return <div className="room-sync-mode-control" data-sync-mode-control data-sync-mode={active} data-sync-writer={root.publisher}>
    <label>{t('rooms.workspace.mode')}</label>
    <div className="room-sync-mode-control-row"><SyncModePicker value={selected} onChange={setSelected} writer={root.publisher} disabled={disabled} />
      <Button variant="primary" size="sm" data-sync-mode-apply disabled={disabled || selected === active || !root.path || root.paused}
        onClick={() => apply(selected)}>{t('rooms.workspace.apply')}</Button></div>
    {root.notice && <div className="room-sync-resume-actions"><Button size="sm" variant="secondary" data-sync-mode-resume disabled={disabled} title={t(`rooms.workspace.modeHint.${root.publisher ? 'sync' : 'receive'}`)} onClick={() => apply(root.publisher ? 'sync' : 'receive')}>
      {t(root.publisher ? 'rooms.workspace.resumeExchange' : 'rooms.workspace.resumeReceive')}</Button></div>}
  </div>;
}
