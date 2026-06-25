/**
 * Rooms page — "friend swarms" / private rooms (Phase 3).
 *
 * A room is a serverless private group: create one to get a speakable invite
 * code, share it, and everyone's chosen files auto-distribute P2P into a shared
 * folder. Each member is shown with a deterministic identicon avatar, with a
 * live "who has what" view of the shared manifest.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Hls from 'hls.js';
import toast from 'react-hot-toast';
import { RoomState, RoomSummary, RoomProfile, RoomFile } from '../../shared/types';
import { Button, Icon, EmptyState, Identicon, QRCode } from '../components';
import { avatarCandidates } from '../components/Identicon';
import { classifyMediaKind } from '../../shared/media';
import { formatBytes, formatSpeed } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import './RoomsPage.css';

const isPlayable = (name: string): boolean => classifyMediaKind(name) !== 'other';

function membersWithFile(room: RoomState, fileId: string): number {
  return room.members.filter((m) => m.have.includes(fileId)).length;
}

type RoomsTFn = (key: keyof typeof import('../i18n/en.json')) => string;

/** Human text for one activity-log event (actor name is rendered separately). */
function eventText(t: RoomsTFn, ev: import('../../shared/types').RoomEvent): string {
  switch (ev.type) {
    case 'created': return t('rooms.ev.created');
    case 'joined': return t('rooms.ev.joined');
    case 'left': return t('rooms.ev.left');
    case 'file-added': return `${t('rooms.ev.fileAdded')} ${ev.fileName || ''}`.trim();
    case 'file-removed': return `${t('rooms.ev.fileRemoved')} ${ev.fileName || ''}`.trim();
    case 'kicked': return `${t('rooms.ev.kicked')} ${ev.targetName || ''}`.trim();
    case 'rekeyed': return t('rooms.ev.rekeyed');
    default: return ev.type;
  }
}

function shortTime(at: number): string {
  try { return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

const RoomsPage: React.FC = () => {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<RoomProfile | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // In-app room player (watch a downloaded shared file, optionally in sync)
  const [watch, setWatch] = useState<{ file: RoomFile } | null>(null);

  // Lightweight inline dialogs
  const [dialog, setDialog] = useState<null | 'create' | 'join' | 'profile' | 'invite'>(null);
  const [createName, setCreateName] = useState('');
  const [createE2E, setCreateE2E] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileSeed, setProfileSeed] = useState('');
  const [avatarPool, setAvatarPool] = useState<string[]>([]);

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    try { setRooms(await window.api.rooms.list()); } catch (e) { console.error(e); }
  }, []);

  // Initial load
  useEffect(() => {
    (async () => {
      try {
        const [p, list] = await Promise.all([window.api.rooms.getProfile(), window.api.rooms.list()]);
        setProfile(p);
        setProfileName(p.name);
        setRooms(list);
        if (list.length) setSelectedId(list[0].roomId);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  // Live updates pushed from the engine
  useEffect(() => {
    const off = window.api.onRoomUpdate((state) => {
      setRooms((prev) => prev.map((r) => r.roomId === state.roomId
        ? { ...r, name: state.name, memberCount: state.members.length, onlineCount: state.members.filter((m) => m.online).length, fileCount: state.files.length }
        : r));
      if (state.roomId === selectedRef.current) setRoom(state);
    });
    return off;
  }, []);

  // Load detail when selection changes
  useEffect(() => {
    if (!selectedId) { setRoom(null); return; }
    let alive = true;
    window.api.rooms.get(selectedId).then((s) => { if (alive) setRoom(s); }).catch(() => {});
    return () => { alive = false; };
  }, [selectedId]);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const state = await window.api.rooms.create(createName.trim() || 'My Room', createE2E);
      await refreshList();
      setSelectedId(state.roomId);
      setRoom(state);
      setDialog('invite');
      setCreateName('');
      setCreateE2E(false);
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setBusy(true);
    try {
      const state = await window.api.rooms.join(joinCode.trim());
      await refreshList();
      setSelectedId(state.roomId);
      setRoom(state);
      setDialog(null);
      setJoinCode('');
      toast.success(t('rooms.joined'));
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  const handleLeave = async (roomId: string) => {
    if (!window.confirm(t('rooms.leaveConfirm'))) return;
    setBusy(true);
    try {
      await window.api.rooms.leave(roomId);
      await refreshList();
      setSelectedId((prev) => (prev === roomId ? null : prev));
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  const handleAddFiles = async (roomId: string) => {
    setBusy(true);
    try {
      const state = await window.api.rooms.pickAndAddFiles(roomId);
      if (state) { setRoom(state); await refreshList(); }
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  const openProfile = () => {
    if (!profile) return;
    setProfileName(profile.name);
    setProfileSeed(profile.avatarSeed);
    setAvatarPool(avatarCandidates(3, profile.avatarSeed));
    setDialog('profile');
  };

  const handleSaveProfile = async () => {
    setBusy(true);
    try {
      const p = await window.api.rooms.setProfile({ name: profileName.trim(), avatarSeed: profileSeed });
      setProfile(p);
      setDialog(null);
      toast.success(t('rooms.profileSaved'));
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  const copy = (text: string, msg: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(msg)).catch(() => {});
  };

  if (loading) {
    return <div className="rooms-page"><div className="page-loading">{t('common.loading')}</div></div>;
  }

  return (
    <div className="rooms-page">
      {/* Header */}
      <div className="rooms-header">
        <h1 className="page-title">
          <Icon name="users" size={20} />
          {t('rooms.title')}
        </h1>
        <div className="rooms-header-actions">
          {profile && (
            <button className="rooms-profile-chip" onClick={openProfile} title={t('rooms.editProfile')}>
              <Identicon seed={profile.avatarSeed} size={28} ring />
              <span>{profile.name || t('rooms.you')}</span>
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDialog('join')} icon={<Icon name="link" size={14} />}>
            {t('rooms.join')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setCreateName(''); setDialog('create'); }} icon={<Icon name="plus" size={14} />}>
            {t('rooms.create')}
          </Button>
        </div>
      </div>

      {rooms.length === 0 ? (
        <EmptyState
          icon="users"
          title={t('rooms.emptyTitle')}
          description={t('rooms.emptyDesc')}
          action={{ label: t('rooms.create'), onClick: () => { setCreateName(''); setDialog('create'); } }}
        />
      ) : (
        <div className="rooms-body">
          {/* Room list */}
          <aside className="rooms-list">
            {rooms.map((r) => (
              <button
                key={r.roomId}
                className={`room-list-item ${selectedId === r.roomId ? 'active' : ''}`}
                onClick={() => setSelectedId(r.roomId)}
              >
                <span className="room-list-icon"><Icon name="users" size={16} /></span>
                <span className="room-list-text">
                  <span className="room-list-name">{r.name}</span>
                  <span className="room-list-meta">
                    <Icon name="user" size={11} /> {r.memberCount}
                    <span className="room-list-dot">·</span>
                    <Icon name="folder" size={11} /> {r.fileCount}
                  </span>
                </span>
                <span className={`room-list-presence ${r.onlineCount > 1 ? 'live' : ''}`}>{r.onlineCount}</span>
              </button>
            ))}
          </aside>

          {/* Room detail */}
          <section className="room-detail">
            {!room ? (
              <div className="page-loading">{t('common.loading')}</div>
            ) : (
              <RoomDetail
                room={room}
                onAddFiles={() => handleAddFiles(room.roomId)}
                onOpenFolder={() => window.api.rooms.openFolder(room.roomId)}
                onInvite={() => setDialog('invite')}
                onLeave={() => handleLeave(room.roomId)}
                onCopyCode={() => copy(room.code, t('rooms.codeCopied'))}
                onWatch={(file) => setWatch({ file })}
                busy={busy}
              />
            )}
          </section>
        </div>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      {dialog && (
        <div className="rooms-modal-backdrop" onClick={() => !busy && setDialog(null)}>
          <div className="rooms-modal" onClick={(e) => e.stopPropagation()}>
            {dialog === 'create' && (
              <>
                <h3>{t('rooms.createTitle')}</h3>
                <p className="rooms-modal-desc">{t('rooms.createDesc')}</p>
                <input
                  className="rooms-input"
                  autoFocus
                  placeholder={t('rooms.namePlaceholder')}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <button
                  type="button"
                  className={`rooms-e2e-toggle ${createE2E ? 'on' : ''}`}
                  onClick={() => setCreateE2E((v) => !v)}
                >
                  <span className="rooms-e2e-check">{createE2E && <Icon name="check" size={12} />}</span>
                  <span className="rooms-e2e-text">
                    <span className="rooms-e2e-label"><Icon name="lock" size={12} /> {t('rooms.e2e')} <em>{t('rooms.e2eExperimental')}</em></span>
                    <span className="rooms-e2e-hint">{t('rooms.e2eHint')}</span>
                  </span>
                </button>
                <div className="rooms-modal-actions">
                  <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
                  <Button variant="primary" onClick={handleCreate} loading={busy}>{t('rooms.create')}</Button>
                </div>
              </>
            )}

            {dialog === 'join' && (
              <>
                <h3>{t('rooms.joinTitle')}</h3>
                <p className="rooms-modal-desc">{t('rooms.joinDesc')}</p>
                <input
                  className="rooms-input rooms-input-code"
                  autoFocus
                  placeholder="swift-amber-otter-comet-4821"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <div className="rooms-modal-actions">
                  <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
                  <Button variant="primary" onClick={handleJoin} loading={busy} disabled={!joinCode.trim()}>{t('rooms.join')}</Button>
                </div>
              </>
            )}

            {dialog === 'profile' && profile && (
              <>
                <h3>{t('rooms.profileTitle')}</h3>
                <div className="rooms-profile-edit">
                  <Identicon seed={profileSeed} size={64} ring />
                  <input
                    className="rooms-input"
                    autoFocus
                    placeholder={t('rooms.namePlaceholder')}
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
                  />
                </div>

                <div className="rooms-avatar-pick-head">
                  <span className="rooms-avatar-pick-label">{t('rooms.avatarPick')}</span>
                  <button
                    type="button"
                    className="rooms-avatar-shuffle"
                    onClick={() => setAvatarPool(avatarCandidates(3, profileSeed))}
                    title={t('rooms.avatarShuffle')}
                  >
                    <Icon name="refresh" size={13} /> {t('rooms.avatarShuffle')}
                  </button>
                </div>
                <div className="rooms-avatar-grid">
                  {avatarPool.map((seed) => (
                    <button
                      key={seed}
                      type="button"
                      className={`rooms-avatar-option ${seed === profileSeed ? 'active' : ''}`}
                      onClick={() => setProfileSeed(seed)}
                      aria-pressed={seed === profileSeed}
                    >
                      <Identicon seed={seed} size={44} />
                    </button>
                  ))}
                </div>

                <p className="rooms-modal-desc">{t('rooms.profileDesc')}</p>
                <div className="rooms-modal-actions">
                  <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
                  <Button variant="primary" onClick={handleSaveProfile} loading={busy}>{t('common.save')}</Button>
                </div>
              </>
            )}

            {dialog === 'invite' && room && (
              <>
                <h3>{t('rooms.inviteTitle')}</h3>
                <p className="rooms-modal-desc">{t('rooms.inviteDesc')}</p>
                <div className="rooms-invite-code" onClick={() => copy(room.code, t('rooms.codeCopied'))} title={t('rooms.copyCode')}>
                  <span>{room.code}</span>
                  <Icon name="copy" size={16} />
                </div>
                <div className="rooms-invite-qr">
                  <QRCode data={room.code} size={168} />
                </div>
                <div className="rooms-modal-actions">
                  <Button variant="primary" onClick={() => setDialog(null)}>{t('common.done')}</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* In-app player (watch a downloaded shared file, optionally in sync) */}
      {watch && room && (
        <RoomPlayer
          roomId={room.roomId}
          file={watch.file}
          self={room.members.find((m) => m.isSelf) || { memberId: 'self', name: 'You', avatarSeed: 'self' }}
          onClose={() => setWatch(null)}
        />
      )}
    </div>
  );
};

// ── Room detail panel ─────────────────────────────────────────────────────
interface DetailProps {
  room: RoomState;
  onAddFiles: () => void;
  onOpenFolder: () => void;
  onInvite: () => void;
  onLeave: () => void;
  onCopyCode: () => void;
  onWatch: (file: RoomFile) => void;
  busy: boolean;
}

const RoomDetail: React.FC<DetailProps> = ({ room, onAddFiles, onOpenFolder, onInvite, onLeave, onCopyCode, onWatch, busy }) => {
  const { t } = useTranslation();
  const totalMembers = room.members.length;
  // Connection indicator: removed → connecting → online (peers) → alone (no peers).
  const connState = room.kicked ? 'removed' : !room.connected ? 'connecting' : room.peerCount > 0 ? 'online' : 'alone';
  const connLabel = room.kicked
    ? t('rooms.removed')
    : !room.connected
      ? t('rooms.connecting')
      : room.peerCount > 0
        ? `${t('rooms.connected')} · ${room.peerCount}`
        : t('rooms.alone');
  return (
    <div className="room-detail-inner">
      {/* Title bar */}
      <div className="room-detail-head">
        <div className="room-detail-title">
          <h2>{room.name}</h2>
          {room.e2e && (
            <span className="room-e2e-badge" title={t('rooms.e2eHint')}>
              <Icon name="lock" size={12} /> {t('rooms.encrypted')}
            </span>
          )}
          <span className={`room-conn ${connState}`}>
            <span className="dot" />
            {connLabel}
          </span>
        </div>
        <div className="room-detail-actions">
          <Button variant="ghost" size="sm" onClick={onCopyCode} icon={<Icon name="copy" size={14} />}>{t('rooms.code')}</Button>
          <Button variant="ghost" size="sm" onClick={onInvite} icon={<Icon name="share-2" size={14} />}>{t('rooms.invite')}</Button>
          <Button variant="ghost" size="sm" onClick={onOpenFolder} icon={<Icon name="folder-open" size={14} />}>{t('rooms.folder')}</Button>
          <Button variant="danger" size="sm" onClick={onLeave} disabled={busy} icon={<Icon name="x" size={14} />}>{t('rooms.leave')}</Button>
        </div>
      </div>

      {/* Removed-from-room banner */}
      {room.kicked && (
        <div className="room-kicked-banner">
          <Icon name="alert-triangle" size={16} />
          <span>{room.kickedBy ? `${t('rooms.kickedBanner')} (${room.kickedBy})` : t('rooms.kickedBanner')}</span>
          <Button variant="danger" size="sm" onClick={onLeave} disabled={busy} icon={<Icon name="x" size={14} />}>{t('rooms.leave')}</Button>
        </div>
      )}

      {/* Members */}
      <div className="room-section">
        <div className="room-section-title">{t('rooms.members')} · {totalMembers}</div>
        <div className="room-members">
          {room.members.map((m) => (
            <div key={m.memberId} className={`room-member ${m.online ? '' : 'offline'} ${m.muted ? 'muted' : ''}`} title={m.online ? t('rooms.online') : t('rooms.offline')}>
              <Identicon seed={m.avatarSeed} size={46} online={m.online} ring={m.isSelf} />
              <span className="room-member-name">
                {m.role === 'owner' && <Icon name="star" size={11} className="room-member-owner" />}
                {m.isSelf ? (m.name && m.name !== 'You' ? m.name : t('rooms.you')) : m.name}
              </span>
              <span className="room-member-have">
                {m.muted ? t('rooms.muted') : `${m.have.length}/${room.files.length}`}
              </span>
              {!m.isSelf && (
                <button
                  className="room-member-mute"
                  title={m.muted ? t('rooms.unmute') : t('rooms.mute')}
                  onClick={() => {
                    if (m.muted) {
                      window.api.rooms.setMuted(room.roomId, m.memberId, false).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                    } else if (window.confirm(t('rooms.muteConfirm'))) {
                      window.api.rooms.setMuted(room.roomId, m.memberId, true).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                    }
                  }}
                >
                  <Icon name={m.muted ? 'eye' : 'eye-off'} size={13} />
                </button>
              )}
              {room.canManage && !m.isSelf && m.role !== 'owner' && (
                <button
                  className="room-member-kick"
                  title={t('rooms.kick')}
                  onClick={() => {
                    if (window.confirm(t('rooms.kickConfirm'))) {
                      window.api.rooms.kick(room.roomId, m.memberId)
                        .then(() => toast.success(t('rooms.kicked')))
                        .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                    }
                  }}
                >
                  <Icon name="x-circle" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Files */}
      <div className="room-section">
        <div className="room-section-title-row">
          <div className="room-section-title">{t('rooms.sharedFiles')} · {room.files.length}</div>
          <Button variant="primary" size="sm" onClick={onAddFiles} loading={busy} icon={<Icon name="file-plus" size={14} />}>
            {t('rooms.addFiles')}
          </Button>
        </div>

        {room.files.length === 0 ? (
          <div className="room-files-empty">{t('rooms.noFiles')}</div>
        ) : (
          <div className="room-files">
            {room.files.map((f) => (
              <RoomFileRow key={f.fileId} file={f} room={room} onWatch={onWatch} />
            ))}
          </div>
        )}
      </div>

      {/* Activity */}
      <div className="room-section">
        <div className="room-section-title">{t('rooms.history')}</div>
        {room.history.length === 0 ? (
          <div className="room-files-empty">{t('rooms.historyEmpty')}</div>
        ) : (
          <div className="room-history">
            {room.history.slice().reverse().slice(0, 30).map((ev) => (
              <div key={ev.id} className="room-history-item">
                <span className="room-history-actor">{ev.actorName}</span>
                <span className="room-history-text">{eventText(t, ev)}</span>
                <span className="room-history-time">{shortTime(ev.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const RoomFileRow: React.FC<{ file: RoomFile; room: RoomState; onWatch: (file: RoomFile) => void }> = ({ file, room, onWatch }) => {
  const { t } = useTranslation();
  const tr = room.transfers[file.fileId];
  const owner = room.members.find((m) => m.memberId === file.addedBy);
  const haveCount = membersWithFile(room, file.fileId);
  const downloading = tr && tr.status === 'downloading';
  const haveLocally = tr?.haveLocally;
  const canWatch = haveLocally && isPlayable(file.name);

  return (
    <div className="room-file">
      <div className="room-file-owner" title={`${t('rooms.addedBy')}: ${owner?.name || file.addedByName}`}>
        <Identicon seed={owner?.avatarSeed || file.addedBy} size={30} />
      </div>
      <div className="room-file-main">
        <div className="room-file-name" title={file.name}>{file.name}</div>
        <div className="room-file-sub">
          <span>{formatBytes(file.size)}</span>
          <span className="room-file-dot">·</span>
          <span className="room-file-have">
            <Icon name="users" size={12} /> {haveCount}/{room.members.length}
          </span>
          {downloading && (
            <>
              <span className="room-file-dot">·</span>
              <span className="room-file-speed">{formatSpeed(tr.downSpeed)}</span>
            </>
          )}
        </div>
        {downloading && (
          <div className="room-file-progress">
            <div className="room-file-progress-bar" style={{ width: `${Math.round((tr.progress || 0) * 100)}%` }} />
          </div>
        )}
      </div>
      {canWatch && (
        <button
          className="room-file-open room-file-watch"
          onClick={() => onWatch(file)}
          title={t('rooms.watchHint')}
        >
          <Icon name="play" size={14} /> {t('rooms.watch')}
        </button>
      )}
      {haveLocally && (
        <button
          className="room-file-open"
          onClick={() => window.api.rooms.openFile(room.roomId, file.fileId)}
          title={t('rooms.openFileHint')}
        >
          <Icon name="external-link" size={14} /> {t('rooms.openFile')}
        </button>
      )}
      <button
        className="room-file-del"
        onClick={() => {
          if (window.confirm(t('rooms.deleteConfirm')))
            window.api.rooms.removeFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
        }}
        title={t('rooms.deleteHint')}
      >
        <Icon name="trash" size={14} />
      </button>
      <div className="room-file-status">
        {haveLocally ? (
          <span className="room-status seeding" title={t('rooms.haveLocal')}><Icon name="check-circle" size={16} /></span>
        ) : downloading ? (
          <span className="room-status downloading">{Math.round((tr.progress || 0) * 100)}%</span>
        ) : (
          <span className="room-status queued" title={t('rooms.queued')}><Icon name="download" size={16} /></span>
        )}
      </div>
    </div>
  );
};

// In-app player for a downloaded room file. Direct-playable files stream from
// the cast server's /direct (seekable); others go through hls.js against the
// on-the-fly HLS transcode. "Watch together" keeps playback in sync across the
// room by broadcasting play/pause/seek over the encrypted gossip channel.
interface Watcher { memberId: string; name: string; avatarSeed: string; playing: boolean; lastSeen: number; }

const RoomPlayer: React.FC<{ roomId: string; file: RoomFile; self: { memberId: string; name: string; avatarSeed: string }; onClose: () => void }> = ({ roomId, file, self, onClose }) => {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const applyingRemote = useRef(false); // suppress echo while applying a remote action
  const togetherRef = useRef(false);
  const [together, setTogether] = useState(false);
  const [controller, setController] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [watchers, setWatchers] = useState<Record<string, Watcher>>({});
  togetherRef.current = together;

  // ── Cinema presence: announce we're watching, heartbeat, and leave ────────
  const presence = useCallback((action: 'join' | 'leave' | 'beat') => {
    const v = videoRef.current;
    window.api.rooms.broadcastSync(roomId, {
      fileId: file.fileId, action,
      position: v ? v.currentTime : 0,
      playing: v ? !v.paused : false,
    }).catch(() => {});
  }, [roomId, file.fileId]);

  useEffect(() => {
    // Seed self into the watcher list right away.
    setWatchers({ [self.memberId]: { memberId: self.memberId, name: self.name || 'You', avatarSeed: self.avatarSeed, playing: false, lastSeen: Date.now() } });
    presence('join');
    const beat = setInterval(() => presence('beat'), 5000);
    // Self heartbeat so our own card stays fresh and reflects play state.
    const selfTick = setInterval(() => {
      const v = videoRef.current;
      setWatchers((w) => ({ ...w, [self.memberId]: { ...(w[self.memberId] || { memberId: self.memberId, name: self.name || 'You', avatarSeed: self.avatarSeed }), playing: v ? !v.paused : false, lastSeen: Date.now() } as Watcher }));
    }, 2000);
    // Prune members we haven't heard from for a while.
    const prune = setInterval(() => {
      setWatchers((w) => {
        const now = Date.now(); const next: Record<string, Watcher> = {};
        for (const k of Object.keys(w)) if (k === self.memberId || now - w[k].lastSeen < 16000) next[k] = w[k];
        return next;
      });
    }, 4000);
    return () => { presence('leave'); clearInterval(beat); clearInterval(selfTick); clearInterval(prune); };
  }, [presence, self.memberId, self.name, self.avatarSeed]);

  // Load the media (direct or HLS).
  useEffect(() => {
    let alive = true;
    window.api.rooms.watchFile(roomId, file.fileId).then((info) => {
      if (!alive) return;
      const v = videoRef.current;
      if (!v) return;
      if (info.direct) {
        v.src = info.directUrl;
      } else if (Hls.isSupported()) {
        const hls = new Hls({ maxBufferLength: 30 });
        hlsRef.current = hls;
        hls.loadSource(info.hlsUrl);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setError(t('rooms.playError')); });
      } else {
        v.src = info.hlsUrl;
      }
      v.play().catch(() => {});
      setLoading(false);
    }).catch((e) => { if (alive) { setError(String(e instanceof Error ? e.message : e)); setLoading(false); } });
    return () => {
      alive = false;
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch { /* ignore */ } hlsRef.current = null; }
    };
  }, [roomId, file.fileId, t]);

  // Broadcast local play/pause/seek to peers when "together" is on.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const send = (action: string) => {
      if (!togetherRef.current || applyingRemote.current) return;
      window.api.rooms.broadcastSync(roomId, { fileId: file.fileId, action, position: v.currentTime, rate: v.playbackRate }).catch(() => {});
    };
    const onPlay = () => send('play');
    const onPause = () => send('pause');
    const onSeeked = () => send('seek');
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    return () => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeked', onSeeked); };
  }, [roomId, file.fileId]);

  // Track who's watching (presence) + apply remote sync when "together" is on.
  useEffect(() => {
    const off = window.api.onRoomSync((msg) => {
      if (msg.roomId !== roomId || msg.fileId !== file.fileId) return;
      // Presence: every message means that member is in the session right now.
      if (msg.action === 'leave') {
        setWatchers((w) => { const n = { ...w }; delete n[msg.memberId]; return n; });
      } else {
        setWatchers((w) => ({ ...w, [msg.memberId]: { memberId: msg.memberId, name: msg.name || '?', avatarSeed: msg.avatarSeed || msg.memberId, playing: !!msg.playing, lastSeen: Date.now() } }));
      }
      // Playback follow — only the actual control actions, only when in sync.
      if (!togetherRef.current) return;
      if (msg.action !== 'play' && msg.action !== 'pause' && msg.action !== 'seek') return;
      const v = videoRef.current;
      if (!v) return;
      setController(msg.name);
      const expected = msg.position + (msg.action === 'play' ? Math.max(0, (Date.now() - msg.at) / 1000) : 0);
      applyingRemote.current = true;
      try {
        if (msg.action === 'pause') { v.pause(); if (Math.abs(v.currentTime - msg.position) > 0.5) v.currentTime = msg.position; }
        else if (msg.action === 'seek') { v.currentTime = msg.position; }
        else if (msg.action === 'play') { if (Math.abs(v.currentTime - expected) > 1.5) v.currentTime = expected; v.play().catch(() => {}); }
      } finally {
        setTimeout(() => { applyingRemote.current = false; }, 250);
      }
    });
    return off;
  }, [roomId, file.fileId]);

  const toggleTogether = () => {
    const next = !together;
    setTogether(next);
    const v = videoRef.current;
    if (next && v) {
      window.api.rooms.broadcastSync(roomId, { fileId: file.fileId, action: v.paused ? 'pause' : 'play', position: v.currentTime, rate: v.playbackRate }).catch(() => {});
    }
  };

  return (
    <div className="room-player-backdrop" onClick={onClose}>
      <div className="room-player" onClick={(e) => e.stopPropagation()}>
        <div className="room-player-top">
          <span className="room-player-name" title={file.name}>{file.name}</span>
          <button className={`room-player-sync ${together ? 'on' : ''}`} onClick={toggleTogether} title={t('rooms.together.hint')}>
            <Icon name="users" size={14} /> {together ? t('rooms.together.on') : t('rooms.together.off')}
          </button>
          <button className="room-player-close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <video ref={videoRef} className="room-player-video" controls autoPlay playsInline />
        <div className="room-player-watchers">
          <span className="room-player-watchers-label"><Icon name="users" size={13} /> {t('rooms.watching')}</span>
          <div className="room-player-avatars">
            {Object.values(watchers).sort((a, b) => a.name.localeCompare(b.name)).map((w) => (
              <span key={w.memberId} className={`room-watcher ${w.playing ? 'playing' : 'paused'}`} title={`${w.name}${w.memberId === self.memberId ? ' (you)' : ''} — ${w.playing ? '▶' : '❚❚'}`}>
                <Identicon seed={w.avatarSeed} size={26} />
                <span className="room-watcher-dot" />
              </span>
            ))}
          </div>
          {Object.keys(watchers).length <= 1 && <span className="room-player-alone">{t('rooms.watchAlone')}</span>}
        </div>
        {loading && !error && <div className="room-player-msg">{t('common.loading')}</div>}
        {error && <div className="room-player-msg err">{error}</div>}
        {together && controller && <div className="room-player-controller">{t('rooms.together.synced')}: {controller}</div>}
      </div>
    </div>
  );
};

export default RoomsPage;
