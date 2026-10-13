import React, { useState } from 'react';
import { Button, DropdownMenu, Icon, Modal } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { BUILTIN_WORKSPACES, MAX_WORKSPACES, builtinWorkspace, captureWorkspace, loadServerView, loadWorkspaces, saveWorkspaces, type RoomWorkspace } from './roomWorkspace';
import type { DockLayout } from './dock/dockModel';
import type { RoomLayout } from '../../utils/roomLayout';

export const RoomWorkspaceMenu: React.FC<{ roomId: string; dock: DockLayout; widths: RoomLayout; onApply: (workspace: RoomWorkspace) => void }> = ({ roomId, dock, widths, onApply }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const [items, setItems] = useState(loadWorkspaces);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const persist = (next: RoomWorkspace[]) => {
    if (!saveWorkspaces(next)) { toast.error(t('rooms.workspace.saveFailed')); return false; }
    setItems(next); return true;
  };
  const save = () => {
    if (!name.trim() || items.length >= MAX_WORKSPACES) return;
    const item = captureWorkspace(`custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, dock, widths, loadServerView(roomId));
    if (persist([...items, item])) { setName(''); toast.success(t('rooms.workspace.saved')); }
  };
  return <>
    <DropdownMenu portal renderTrigger={({ toggle, open }) => <Button variant="ghost" size="sm" onClick={toggle} aria-expanded={open} icon={<Icon name="layout-template" size={14} />}>{t('rooms.workspace.title')}</Button>}
      items={[
        ...BUILTIN_WORKSPACES.map(id => ({ key: id, label: t(`rooms.workspace.${id}`), onSelect: () => onApply(builtinWorkspace(id)) })),
        ...items.map(item => ({ key: item.id, label: item.name, onSelect: () => onApply(item) })),
        { key: 'manage', label: t('rooms.workspace.manage'), icon: <Icon name="settings" size={13} />, onSelect: () => { setItems(loadWorkspaces()); setEditing(true); } },
      ]} />
    {editing && <Modal title={t('rooms.workspace.manage')} onClose={() => setEditing(false)} size="sm">
      <p className="rooms-modal-desc">{t('rooms.workspace.hint')}</p>
      <form className="room-workspace-save" onSubmit={e => { e.preventDefault(); save(); }}>
        <input className="room-workspace-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} aria-label={t('rooms.workspace.name')} placeholder={t('rooms.workspace.name')} />
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || items.length >= MAX_WORKSPACES}>{t('rooms.workspace.save')}</Button>
      </form>
      {items.length >= MAX_WORKSPACES && <p className="rooms-modal-desc">{t('rooms.workspace.limit')}</p>}
      <div className="room-workspace-list">{items.map(item => <div className="room-workspace-entry" key={item.id}>
        <span>{item.name}</span>
        <Button size="sm" variant="ghost" onClick={() => { onApply(item); setEditing(false); }}>{t('rooms.workspace.apply')}</Button>
        <Button size="sm" variant="ghost" iconOnly aria-label={`${t('rooms.workspace.delete')} ${item.name}`} icon={<Icon name="trash" size={13} />} onClick={() => persist(items.filter(p => p.id !== item.id))} />
      </div>)}</div>
    </Modal>}
  </>;
};
