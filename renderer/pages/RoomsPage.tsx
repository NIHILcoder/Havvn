/**
 * Rooms page — "friend swarms" / private rooms (Phase 3).
 *
 * A room is a serverless private group: create one to get a speakable invite
 * code, share it, and everyone's chosen files auto-distribute P2P into a shared
 * folder. Each member is shown with a deterministic identicon avatar, with a
 * live "who has what" view of the shared manifest.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { RoomState, RoomSummary, RoomProfile, RoomFile } from '../../shared/types';
import { Button, Icon, EmptyState, Identicon, QRCode } from '../components';
import { formatBytes, formatSpeed } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import './RoomsPage.css';

function membersWithFile(room: RoomState, fileId: string): number {
  return room.members.filter((m) => m.have.includes(fileId)).length;
}

const RoomsPage: React.FC = () => {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<RoomProfile | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Lightweight inline dialogs
  const [dialog, setDialog] = useState<null | 'create' | 'join' | 'profile' | 'invite'>(null);
  const [createName, setCreateName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [profileName, setProfileName] = useState('');

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
      const state = await window.api.rooms.create(createName.trim() || 'My Room');
      await refreshList();
      setSelectedId(state.roomId);
      setRoom(state);
      setDialog('invite');
      setCreateName('');
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

  const handleSaveProfile = async () => {
    setBusy(true);
    try {
      const p = await window.api.rooms.setProfile({ name: profileName.trim() });
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
            <button className="rooms-profile-chip" onClick={() => { setProfileName(profile.name); setDialog('profile'); }} title={t('rooms.editProfile')}>
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
                  <Identicon seed={profile.avatarSeed} size={64} ring />
                  <input
                    className="rooms-input"
                    autoFocus
                    placeholder={t('rooms.namePlaceholder')}
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
                  />
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
  busy: boolean;
}

const RoomDetail: React.FC<DetailProps> = ({ room, onAddFiles, onOpenFolder, onInvite, onLeave, onCopyCode, busy }) => {
  const { t } = useTranslation();
  const totalMembers = room.members.length;
  return (
    <div className="room-detail-inner">
      {/* Title bar */}
      <div className="room-detail-head">
        <div className="room-detail-title">
          <h2>{room.name}</h2>
          <span className={`room-conn ${room.connected ? 'on' : 'off'}`}>
            <span className="dot" />
            {room.connected ? `${t('rooms.connected')} · ${room.peerCount}` : t('rooms.connecting')}
          </span>
        </div>
        <div className="room-detail-actions">
          <Button variant="ghost" size="sm" onClick={onCopyCode} icon={<Icon name="copy" size={14} />}>{t('rooms.code')}</Button>
          <Button variant="ghost" size="sm" onClick={onInvite} icon={<Icon name="share-2" size={14} />}>{t('rooms.invite')}</Button>
          <Button variant="ghost" size="sm" onClick={onOpenFolder} icon={<Icon name="folder-open" size={14} />}>{t('rooms.folder')}</Button>
          <Button variant="danger" size="sm" onClick={onLeave} disabled={busy} icon={<Icon name="x" size={14} />}>{t('rooms.leave')}</Button>
        </div>
      </div>

      {/* Members */}
      <div className="room-section">
        <div className="room-section-title">{t('rooms.members')} · {totalMembers}</div>
        <div className="room-members">
          {room.members.map((m) => (
            <div key={m.memberId} className={`room-member ${m.online ? '' : 'offline'}`} title={m.online ? t('rooms.online') : t('rooms.offline')}>
              <Identicon seed={m.avatarSeed} size={46} online={m.online} ring={m.isSelf} />
              <span className="room-member-name">{m.isSelf ? (m.name && m.name !== 'You' ? m.name : t('rooms.you')) : m.name}</span>
              <span className="room-member-have">{m.have.length}/{room.files.length}</span>
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
              <RoomFileRow key={f.fileId} file={f} room={room} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const RoomFileRow: React.FC<{ file: RoomFile; room: RoomState }> = ({ file, room }) => {
  const { t } = useTranslation();
  const tr = room.transfers[file.fileId];
  const owner = room.members.find((m) => m.memberId === file.addedBy);
  const haveCount = membersWithFile(room, file.fileId);
  const downloading = tr && tr.status === 'downloading';
  const haveLocally = tr?.haveLocally;

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

export default RoomsPage;
