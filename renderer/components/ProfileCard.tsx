/**
 * ProfileCard — the member popover: avatar, colored name, status line, role,
 * presence and share count, plus the mute/kick actions where they apply.
 *
 * Portals to the ANCHOR's document body, not this realm's: chat rows can live
 * in the detached chat window, and `.room-detail-inner` is a container-query
 * subtree that traps position:fixed descendants (the ContextMenu precedent).
 * All dismiss listeners bind to that same document.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomMember } from '../../shared/types';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import './ProfileCard.css';

interface ProfileCardProps {
  member: RoomMember;
  totalFiles: number;
  anchor: HTMLElement;
  canManage: boolean;
  onClose: () => void;
  onMuteToggle?: () => void;
  onKick?: () => void;
  onTransfer?: () => void;
}

const CARD_W = 240;

export const ProfileCard: React.FC<ProfileCardProps> = ({ member, totalFiles, anchor, canManage, onClose, onMuteToggle, onKick, onTransfer }) => {
  const { t } = useTranslation();
  const doc = anchor.ownerDocument;
  const win = doc.defaultView ?? window;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Place beside the anchor, clamped to the anchor window's viewport.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 180;
    const x = Math.max(8, Math.min(r.right + 8, win.innerWidth - CARD_W - 8));
    const y = Math.max(8, Math.min(r.top, win.innerHeight - h - 8));
    setPos({ x, y });
  }, [anchor, win]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    return () => { doc.removeEventListener('mousedown', onDown); doc.removeEventListener('keydown', onKey); };
  }, [doc, anchor, onClose]);

  const name = member.isSelf && (!member.name || member.name === 'You') ? t('rooms.you') : member.name;
  return createPortal(
    <div
      ref={ref}
      className="profile-card"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, width: CARD_W, visibility: pos ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label={name}
    >
      <div className="profile-card-head">
        <Avatar seed={member.avatarSeed} img={member.avatarImg} size={44} online={member.online} ring={member.isSelf} />
        <div className="profile-card-id">
          <span className="profile-card-name" style={member.color ? { color: member.color } : undefined}>
            {member.role === 'owner' && <Icon name="star" size={11} className="profile-card-owner" />}
            {name}
          </span>
          <span className="profile-card-presence">
            {member.guest
              ? t('rooms.guest')
              : member.online ? (member.relayed ? t('rooms.relayed') : t('rooms.direct')) : t('rooms.offline')}
          </span>
        </div>
      </div>
      {member.status ? <div className="profile-card-status">{member.status}</div> : null}
      <div className="profile-card-meta">
        <span title={t('rooms.memberHaveHint').replace('{n}', String(member.have.length)).replace('{total}', String(totalFiles))}>
          <Icon name="download" size={11} /> {member.have.length}/{totalFiles}
        </span>
        {member.guest && <span className="profile-card-guesttag" title={t('rooms.guestHint')}>{t('rooms.guest')}</span>}
        {member.muted && <span className="profile-card-mutedtag">{t('rooms.muted')}</span>}
      </div>
      {!member.isSelf && (onMuteToggle || onKick || onTransfer) && (
        <div className="profile-card-acts">
          {onMuteToggle && (
            <button type="button" className="profile-card-act" onClick={() => { onMuteToggle(); onClose(); }}>
              <Icon name={member.muted ? 'eye' : 'eye-off'} size={12} /> {member.muted ? t('rooms.unmute') : t('rooms.mute')}
            </button>
          )}
          {onTransfer && canManage && member.role !== 'owner' && member.online && (
            <button type="button" className="profile-card-act danger" onClick={() => { onTransfer(); onClose(); }}>
              <Icon name="star" size={12} /> {t('rooms.transferOwner')}
            </button>
          )}
          {onKick && canManage && member.role !== 'owner' && (
            <button type="button" className="profile-card-act danger" onClick={() => { onKick(); onClose(); }}>
              <Icon name="x-circle" size={12} /> {t('rooms.kick')}
            </button>
          )}
        </div>
      )}
    </div>,
    doc.body,
  );
};

export default ProfileCard;
