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
 * The elevation confirm follows the picker. submit() goes through useConfirm,
 * whose provider renders at the app root in the MAIN window — which used to mean
 * the question popped in the main window while the click happened in the child.
 * That is fixed at the provider (renderer/components/ConfirmDialog.tsx): useConfirm
 * captures the REQUESTING realm at call time from useHostWindow(), and the head of
 * the queue is portalled into that window's <body> wrapped in HostWindowProvider.
 * So this file needs nothing for it — but it does mean the picker must keep its own
 * realm honest: this component's position in the React tree is what decides where
 * its confirm appears, exactly as it decides where the picker itself is portalled.
 *
 * Only admitted players receive a vIP, so the selection is deliberate. The mesh
 * cap (MAX_LAN_PEERS, self included) bounds how many can be admitted at once.
 */
import React, { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal, Button, Icon, Avatar, useConfirm } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import type { RoomMember } from '../../../shared/types';
import { MAX_LAN_PEERS } from '../../../shared/lan-types';
import { preselectPicks } from '../../../shared/lan-prefs';
import './RoomLanPanel.css';
import { checkRoomCapability, type RoomActionCheck } from '../../../shared/room-preflight';
import { RoomActionHint } from './RoomActionHint';

export interface LanPeerPickerProps {
  /** Full room roster — self and already-admitted members are filtered out. */
  members: RoomMember[];
  /** This install's memberId (never an admit target). */
  selfId?: string;
  /** Members already in the session (hidden when inviting into a live session). */
  excludeIds?: string[];
  /**
   * Players this room remembers from the last session, in remembered order — the
   * tiles open already ticked so a regular group is one click, not a re-pick.
   *
   * A CONVENIENCE, never an authority: the intersection with the tiles actually on
   * screen is what gets ticked (preselectPicks), because a selection the host
   * cannot see or untick would still travel into a signed admit. Everything here
   * is confirmed by the same elevation dialog as a hand-made selection.
   */
  preselectIds?: string[];
  /** Header title (Start vs Invite wording is chosen by the opener). */
  title?: string;
  onClose: () => void;
  /** Fired with the selected memberIds after the elevation confirm. */
  onPick: (memberIds: string[]) => void;
}

export const LanPeerPicker: React.FC<LanPeerPickerProps> = ({
  members, selfId, excludeIds = [], preselectIds, title, onClose, onPick,
}) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const host = useHostWindow();

  const excluded = useMemo(() => new Set([selfId, ...excludeIds].filter(Boolean) as string[]), [selfId, excludeIds]);
  const candidates = useMemo(() => members.filter((m) => !excluded.has(m.memberId)), [members, excluded]);
  const latest = useRef(candidates); latest.current = candidates;
  const available = (m: RoomMember) => m.online && checkRoomCapability(m, 'lan').canAttempt;
  const [refusal, setRefusal] = useState<RoomActionCheck | null>(null);

  // Self occupies one mesh slot, so at most MAX_LAN_PEERS-1 admits.
  const cap = Math.max(0, MAX_LAN_PEERS - 1);

  // Seeded ONCE, at mount: the picker is mounted fresh each time it opens, and the
  // remembered list is resolved by the opener before that. Recomputing it as a
  // prop-derived value would fight the user — a member they untick would come
  // straight back on the next render.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectPicks(preselectIds ?? [], candidates.filter(available).map((m) => m.memberId), cap)),
  );

  const atCap = selected.size >= cap;
  const invalidSelection = [...selected].some(id => !candidates.some(m => m.memberId === id && available(m)));

  const toggle = (id: string) => {
    setRefusal(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < cap) next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const picked = [...selected];
    const current = () => {
      for (const id of picked) {
        const member = latest.current.find(m => m.memberId === id);
        const check: RoomActionCheck = !member?.online ? { status: 'unavailable', reason: 'peer-unavailable', next: 'reconnect', canAttempt: false } : checkRoomCapability(member, 'lan');
        if (!check.canAttempt) { setRefusal(check); return false; }
      }
      return true;
    };
    if (!current()) return;
    const ok = await confirm({
      title: t('rooms.lan.confirm'),
      message: t('rooms.lan.elevationNotice'),
      confirmLabel: t('rooms.lan.confirm'),
      icon: 'shield',
    });
    if (ok && current()) onPick(picked);
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
          <Button variant="primary" onClick={submit} disabled={invalidSelection}>{t('rooms.lan.confirm')}</Button>
        </div>
      }
    >
      <p className="lpp-desc">{t('rooms.lan.pickPeersDesc')}</p>
      {refusal && <RoomActionHint check={refusal} />}
      {candidates.length === 0 ? (
        <div className="lpp-empty">{t('rooms.lan.noPeers')}</div>
      ) : (
        <div className="lpp-grid">
          {candidates.map((m) => {
            const on = selected.has(m.memberId);
            const supported = available(m);
            const disabled = !supported && !on || !on && atCap;
            const reason = !m.online ? 'peer-unavailable' : checkRoomCapability(m, 'lan').reason;
            return (
              <button
                key={m.memberId}
                className={`lpp-tile${on ? ' selected' : ''}`}
                onClick={() => toggle(m.memberId)}
                disabled={disabled}
                title={!supported ? t(`rooms.preflight.reason.${reason}`) : disabled ? t('rooms.lan.busyElsewhere') : m.name}
                type="button"
                aria-pressed={on}
              >
                <span className="lpp-avatar">
                  <Avatar seed={m.avatarSeed || m.memberId} img={m.avatarImg} size={36} />
                  {on && <span className="lpp-selection" aria-hidden="true" />}
                </span>
                <span className="lpp-name" style={m.color ? { color: m.color } : undefined}>{m.name}</span>
                {!supported && <span className="lpp-capability">{t(`rooms.preflight.reason.${reason}`)}</span>}
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
