/**
 * RoomLanPanel — the Virtual-LAN rail widget (Phase 1 UI).
 *
 * Anatomy mirrors RoomVoicePanel (RoomsPage.tsx): a compact header (title +
 * BETA pill + settings gear), a Start/Stop action row, and a wrapped grid of
 * per-peer tiles. Each tile carries a connection-status dot (the .room-lan-quality
 * lineage of .room-voice-quality), the peer's monospace virtual IP, and a copy-IP
 * button. Host-only affordances (invite more players, evict a peer) surface only
 * when `lan.isHost`.
 *
 * Extracted as a standalone component (RoomsPage.tsx is already 3800+ lines and
 * every phase that touches it collides). The Integration phase mounts it in the
 * room rail between the voice panel and the people list, and wires the callback
 * props to window.api.rooms.lan.*.
 *
 * Styling uses ONLY theme tokens (no hardcoded radius; --radius-full is reserved
 * for the status dots). The peer picker portals its fixed overlay to <body>.
 */
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Avatar, Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import type { RoomMember } from '../../../shared/types';
import type { RoomLanState, RoomLanParticipant, LanPeerStatus } from '../../../shared/lan-types';
import { LanPeerPicker } from './LanPeerPicker';
import './RoomLanPanel.css';

export interface RoomLanPanelProps {
  /** The room's LAN session as this install sees it (RoomState.lan). */
  lan: RoomLanState;
  /** Full room roster — the picker selects admit targets from here. */
  members: RoomMember[];
  /** This install's memberId (to split self from peers). */
  selfId?: string;
  /** Host path: start a session and admit the picked members (one UAC). */
  onStart: (memberIds: string[]) => void | Promise<void>;
  /** Stop / leave the session. */
  onStop: () => void | Promise<void>;
  /** Non-host: join a session we've been admitted to. */
  onAccept?: () => void | Promise<void>;
  /** Host: admit one more member into a live session. */
  onInvite?: (memberIds: string[]) => void | Promise<void>;
  /** Host: evict a member from the session. */
  onEvict?: (memberId: string) => void | Promise<void>;
  /** Open a LAN settings surface (optional; no-op until a settings modal exists). */
  onOpenSettings?: () => void;
}

/** Map the LanPeer connection state to the shared quality-dot class vocabulary. */
const STATUS_CLASS: Record<LanPeerStatus, string> = {
  connected: 'q-good',
  connecting: 'q-fair',
  reconnecting: 'q-poor reconnecting',
  failed: 'q-poor',
};

export const RoomLanPanel: React.FC<RoomLanPanelProps> = ({
  lan, members, selfId, onStart, onStop, onAccept, onInvite, onEvict, onOpenSettings,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [pickerMode, setPickerMode] = useState<null | 'start' | 'invite'>(null);

  const memberOf = (id: string) => members.find((m) => m.memberId === id);
  const nameOf = (id: string) => (id === selfId ? t('rooms.you') : (memberOf(id)?.name || '?'));
  const seedOf = (id: string) => memberOf(id)?.avatarSeed || id;
  const fail = (e: unknown) => toast.error(String(e instanceof Error ? e.message : e));
  const wrap = (fn: () => void | Promise<unknown>) => async () => {
    setBusy(true);
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const copyIp = (vip: string) => {
    if (!vip) return;
    navigator.clipboard?.writeText(vip)
      .then(() => toast.success(t('rooms.lan.copied')))
      .catch(() => { /* clipboard blocked — silent, the IP is still shown */ });
  };

  // Peers are every admitted participant except ourselves; self reads off selfVip.
  const peers = lan.participants.filter((p) => p.memberId !== selfId);
  const admittedIds = lan.participants.map((p) => p.memberId);

  // Start is offerable only when the driver is present, no other room holds the
  // single beta session, and the kill-switch isn't down.
  const startBlockedReason = !lan.available
    ? t('rooms.lan.unavailable')
    : lan.suspended
      ? t('rooms.lan.suspended')
      : lan.blocked
        ? t('rooms.lan.busyElsewhere')
        : null;
  const canStart = !startBlockedReason && !busy;

  return (
    <div className="room-lan">
      <div className="room-lan-head">
        <span className="room-lan-title">
          <Icon name="network" size={13} /> {t('rooms.lan.title')}
          <span className="stg-pill stg-pill-accent room-lan-beta">{t('rooms.lan.beta')}</span>
        </span>
        {onOpenSettings && (
          <button className="room-lan-gear" onClick={onOpenSettings} title={t('rooms.lan.settings')} type="button">
            <Icon name="settings" size={14} />
          </button>
        )}
      </div>

      {lan.active ? (
        <>
          <div className="room-lan-self">
            <span className="room-lan-self-label">{t('rooms.lan.yourIp')}</span>
            <button
              className="room-lan-ip"
              onClick={() => copyIp(lan.selfVip || '')}
              title={t('rooms.lan.copyIp')}
              type="button"
              disabled={!lan.selfVip}
            >
              <span className="room-lan-ip-text">{lan.selfVip || t('rooms.lan.connecting')}</span>
              <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="room-lan-ctl">
            {lan.isHost && onInvite && (
              <button
                className="room-lan-btn"
                onClick={() => setPickerMode('invite')}
                disabled={busy}
                title={t('rooms.lan.pickPeers')}
                type="button"
              >
                <Icon name="plus" size={15} />
              </button>
            )}
            <button
              className="room-lan-btn stop"
              onClick={wrap(onStop)}
              disabled={busy}
              title={t('rooms.lan.stop')}
              type="button"
            >
              <Icon name="power" size={15} /> {t('rooms.lan.stop')}
            </button>
          </div>
        </>
      ) : (
        <>
          {startBlockedReason && <div className="room-lan-notice">{startBlockedReason}</div>}
          {lan.selfAdmitted && lan.sessionId && onAccept ? (
            // The host has ADMITTED us to a session we haven't joined → Accept it
            // (joiner path). Decided by session STATE, not by the callback's presence
            // — the panel always receives onAccept, so keying off it made this button
            // always call lanAccept and the Start path was unreachable.
            <button className="room-lan-join" onClick={wrap(onAccept)} disabled={busy} type="button">
              <Icon name="network" size={14} /> {t('rooms.lan.accept')}
            </button>
          ) : (
            // No incoming invite → Start our OWN session (host path opens the picker
            // → onStart → lanStart, which broadcasts genesis + admits).
            <button
              className="room-lan-join"
              onClick={() => setPickerMode('start')}
              disabled={!canStart}
              title={startBlockedReason || undefined}
              type="button"
            >
              <Icon name="network" size={14} /> {t('rooms.lan.start')}
            </button>
          )}
        </>
      )}

      {peers.length > 0 && (
        <div className="room-lan-people">
          {peers.map((p: RoomLanParticipant) => (
            <div key={p.memberId} className="room-lan-person" title={nameOf(p.memberId)}>
              <span className="room-lan-ring">
                <Avatar seed={seedOf(p.memberId)} img={memberOf(p.memberId)?.avatarImg} size={30} />
                <span
                  className={`room-lan-quality ${STATUS_CLASS[p.status] || 'q-fair'}`}
                  title={
                    p.status === 'connected' ? t('rooms.lan.statusConnected')
                      : p.status === 'connecting' ? t('rooms.lan.statusConnecting')
                        : p.status === 'reconnecting' ? t('rooms.lan.statusReconnecting')
                          : t('rooms.lan.statusFailed')
                  }
                />
                {lan.isHost && onEvict && (
                  <button
                    className="room-lan-evict"
                    onClick={wrap(() => onEvict(p.memberId))}
                    disabled={busy}
                    title={t('rooms.lan.evict')}
                    type="button"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </span>
              <span
                className="room-lan-pname"
                style={memberOf(p.memberId)?.color ? { color: memberOf(p.memberId)?.color } : undefined}
              >
                {nameOf(p.memberId)}
              </span>
              <button
                className="room-lan-pip"
                onClick={() => copyIp(p.vip)}
                title={t('rooms.lan.copyIp')}
                type="button"
                disabled={!p.vip}
              >
                {p.vip || '···'}
              </button>
            </div>
          ))}
        </div>
      )}

      {pickerMode && (
        <LanPeerPicker
          members={members}
          selfId={selfId}
          excludeIds={pickerMode === 'invite' ? admittedIds : []}
          title={pickerMode === 'invite' ? t('rooms.lan.pickPeers') : t('rooms.lan.confirm')}
          onClose={() => setPickerMode(null)}
          onPick={(ids) => {
            const mode = pickerMode;
            setPickerMode(null);
            void wrap(() => (mode === 'invite' && onInvite ? onInvite(ids) : onStart(ids)))();
          }}
        />
      )}
    </div>
  );
};

export default RoomLanPanel;
