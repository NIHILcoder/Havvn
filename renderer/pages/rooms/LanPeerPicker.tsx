/**
 * LanPeerPicker — choose which room members get a virtual IP.
 *
 * Mirrors ScreenSourcePicker (renderer/components/ScreenShare.tsx): a Modal (size
 * lg) portaled to the OWNING document's <body> so the room's container-query
 * subtree containment can't trap the fixed backdrop. Members are selectable tiles;
 * the footer carries an elevation notice (Windows will prompt for admin to create
 * the adapter) and the confirm action, which re-confirms through useConfirm before
 * firing onPick.
 *
 * REALM: the picker opens from the LAN panel, which lives in the dock and can be
 * torn off into a child window. `document.body` would then be the MAIN window's
 * body and the picker would appear in the window the user is not looking at, so
 * the target comes from useHostWindow() — it defaults to the real globals, so
 * a docked panel behaves exactly as before. There is no element to read an
 * ownerDocument off (the portal container is needed before anything mounts), which
 * is precisely the case the context exists for.
 *
 * KNOWN GAP (not fixable here): submit() goes through useConfirm, whose provider
 * renders at the app root in the MAIN window. From a torn-off panel the elevation
 * confirm therefore pops in the main window while the click happened in the child.
 * Fixing that means teaching ConfirmProvider to portal into the requesting realm
 * (renderer/components/ConfirmDialog.tsx), which is a separate change.
 *
 * Only admitted players receive a vIP, so the selection is deliberate. The mesh
 * cap (MAX_LAN_PEERS, self included) bounds how many can be admitted at once.
 */
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Button, Icon, Avatar, useConfirm } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import type { RoomMember } from '../../../shared/types';
import { MAX_LAN_PEERS } from '../../../shared/lan-types';
import './RoomLanPanel.css';

export interface LanPeerPickerProps {
  /** Full room roster — self and already-admitted members are filtered out. */
  members: RoomMember[];
  /** This install's memberId (never an admit target). */
  selfId?: string;
  /** Members already in the session (hidden when inviting into a live session). */
  excludeIds?: string[];
  /** Header title (Start vs Invite wording is chosen by the opener). */
  title?: string;
  onClose: () => void;
  /** Fired with the selected memberIds after the elevation confirm. */
  onPick: (memberIds: string[]) => void;
}

export const LanPeerPicker: React.FC<LanPeerPickerProps> = ({
  members, selfId, excludeIds = [], title, onClose, onPick,
}) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const host = useHostWindow();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const excluded = useMemo(() => new Set([selfId, ...excludeIds].filter(Boolean) as string[]), [selfId, excludeIds]);
  const candidates = useMemo(() => members.filter((m) => !excluded.has(m.memberId)), [members, excluded]);

  // Self occupies one mesh slot, so at most MAX_LAN_PEERS-1 admits.
  const cap = Math.max(0, MAX_LAN_PEERS - 1);
  const atCap = selected.size >= cap;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < cap) next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const ok = await confirm({
      title: t('rooms.lan.confirm'),
      message: t('rooms.lan.elevationNotice'),
      confirmLabel: t('rooms.lan.confirm'),
      icon: 'shield',
    });
    if (ok) onPick([...selected]);
  };

  return createPortal(
    <Modal
      onClose={onClose}
      title={title || t('rooms.lan.pickPeers')}
      icon="network"
      size="lg"
      bodyClassName="lpp-body"
      footer={
        <div className="lpp-footer">
          <span className="lpp-notice">
            <Icon name="shield" size={13} /> {t('rooms.lan.elevationNotice')}
          </span>
          <Button variant="primary" onClick={submit}>{t('rooms.lan.confirm')}</Button>
        </div>
      }
    >
      <p className="lpp-desc">{t('rooms.lan.pickPeersDesc')}</p>
      {candidates.length === 0 ? (
        <div className="lpp-empty">{t('rooms.lan.noPeers')}</div>
      ) : (
        <div className="lpp-grid">
          {candidates.map((m) => {
            const on = selected.has(m.memberId);
            const disabled = !on && atCap;
            return (
              <button
                key={m.memberId}
                className={`lpp-tile${on ? ' selected' : ''}`}
                onClick={() => toggle(m.memberId)}
                disabled={disabled}
                title={disabled ? t('rooms.lan.busyElsewhere') : m.name}
                type="button"
                aria-pressed={on}
              >
                <span className="lpp-avatar">
                  <Avatar seed={m.avatarSeed || m.memberId} img={m.avatarImg} size={36} />
                  {on && <span className="lpp-check"><Icon name="check" size={12} /></span>}
                </span>
                <span className="lpp-name" style={m.color ? { color: m.color } : undefined}>{m.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>,
    host.document.body,
  );
};

export default LanPeerPicker;
