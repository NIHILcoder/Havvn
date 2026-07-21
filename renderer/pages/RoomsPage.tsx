/**
 * Rooms page — "friend swarms" / private rooms (Phase 3).
 *
 * A room is a serverless private group: create one to get a speakable invite
 * code, share it, and everyone's chosen files auto-distribute P2P into a shared
 * folder. Each member is shown with a deterministic identicon avatar, with a
 * live "who has what" view of the shared manifest.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Hls from 'hls.js';
import toast from 'react-hot-toast';
import { RoomState, RoomSummary, RoomProfile, RoomFile, RoomFolder, RoomMember } from '../../shared/types';
import { Button, Icon, IconName, EmptyState, Identicon, Avatar, ProfileCard, TransferPickerModal, Toggle, PlayerControls, Modal, useConfirm, VoiceSettingsModal, ScreenSourcePicker, ScreenView, Select, Tabs, DropdownMenu } from '../components';
import { VoicePrefs, VOICE_PREFS_EVENT, loadVoicePrefs, saveVoicePrefs, toVoiceSettings, PeerVoicePref, loadPeerVoicePrefs, savePeerVoicePref, effectivePeerGain } from '../utils/voicePrefs';
import { loadRoomLayout, saveRoomLayout, RAIL_MIN, RAIL_MAX, CHAT_MIN, CHAT_MAX } from '../utils/roomLayout';
import { usePopout } from '../utils/popout';
import { RoomFilesPrefs, loadRoomFilesPrefs, saveRoomFilesPrefs, loadRoomSort, saveRoomSort, loadRoomSortDir, saveRoomSortDir, SORT_NATURAL_DIR, RoomFilesSortDir, loadCollapsedFolders, saveCollapsedFolders, clearRoomFilesPrefs } from '../utils/roomFilesPrefs';
import { ContextMenu } from '../components/ContextMenu';
import { avatarCandidates } from '../components/Identicon';
import { groupFilesByHierarchy, wantAutoFetch, FOLDER_ICONS } from '../../shared/room-folders';
import { sanitizeProfileColor, sanitizeProfileStatus, PROFILE_COLOR_RE } from '../../shared/profile';
import { parseChatSegments, isCopyworthy, splitLinks } from '../../shared/chat-format';
import { CHAT_REACT_EMOJIS } from '../../shared/reactions';
import { classifyMediaKind } from '../../shared/media';
import { formatBytes, formatSpeed } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import './RoomsPage.css';

const isPlayable = (name: string): boolean => classifyMediaKind(name) !== 'other';

/** The compact per-file reaction set (mirrors the engine's allow-list). */
const FILE_REACT_EMOJIS = ['🔥', '👍', '❤️', '😂'] as const;

/** Mirrors MAX_VOICE_PEERS in electron/sharing/room-voice.ts (serverless mesh cap). */
const VOICE_MESH_LIMIT = 8;

/** Colors for a room folder (icons come from the shared FOLDER_ICONS list). */
const FOLDER_COLORS = ['#e8792b', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#eab308', '#14b8a6', '#94a3b8'];
/** dataTransfer type carrying a fileId when a file row is dragged onto a section. */
const FILE_DND_TYPE = 'text/havvn-fileid';

/** The colored folder icon chip (or the muted Uncategorized one). */
const FolderIcon: React.FC<{ folder: RoomFolder | null; size?: number }> = ({ folder, size = 14 }) => (
  folder
    ? <span className="room-folder-ic" style={{ color: folder.color || undefined }}><Icon name={(folder.icon as IconName) || 'folder'} size={size} /></span>
    : <span className="room-folder-ic room-folder-ic-none"><Icon name="folder" size={size} /></span>
);

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

/** Time-of-day only — chat messages carry the date via the day separators. */
function timeOnly(at: number): string {
  try { return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

/** Label for a chat day separator: Today / Yesterday / a locale date. */
function dayLabel(at: number, t: RoomsTFn): string {
  const d = new Date(at);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return t('rooms.today');
  if (diffDays === 1) return t('rooms.yesterday');
  try {
    return d.toLocaleDateString(undefined, {
      month: 'long', day: 'numeric',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  } catch { return ''; }
}

interface RoomsPageProps {
  /** Room requested from outside (sidebar rail / status-bar Join). */
  focusRoomId?: string | null;
  onFocusHandled?: () => void;
  /** Reports the currently-open room so the rail can highlight it. */
  onRoomSelected?: (roomId: string | null) => void;
}

const RoomsPage: React.FC<RoomsPageProps> = ({ focusRoomId, onFocusHandled, onRoomSelected }) => {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<RoomProfile | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Lightweight inline dialogs
  const [dialog, setDialog] = useState<null | 'create' | 'join' | 'profile' | 'invite' | 'leave'>(null);
  // Room queued for the leave dialog (which offers keep-files vs delete-files).
  const [leaveTarget, setLeaveTarget] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  // E2E on by default: a new room encrypts its files before they touch the public
  // swarm. Turning it OFF is an explicit choice (files go out in plaintext).
  const [createE2E, setCreateE2E] = useState(true);
  const [joinCode, setJoinCode] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profileSeed, setProfileSeed] = useState('');
  const [avatarPool, setAvatarPool] = useState<string[]>([]);
  const [profileColor, setProfileColor] = useState('');
  const [profileStatus, setProfileStatus] = useState('');

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  // Presence/share toasts: previous snapshot of the OPEN room (per roomId) so
  // successive updates can be diffed; a switch or initial load only seeds it.
  const presenceSnapRef = useRef<{ roomId: string; online: Map<string, boolean>; fileIds: Set<string> } | null>(null);
  // Dedupe: same member/file toast at most once per 30s.
  const presenceToastAtRef = useRef<Map<string, number>>(new Map());

  const refreshList = useCallback(async () => {
    try { setRooms(await window.api.rooms.list()); } catch (e) { console.error(e); }
  }, []);

  // Initial load. Selection is NOT set here — the auto-select effect below
  // picks the first room only when nothing is selected, so a focus request
  // (rail click / status-bar Join) applied on mount can't be clobbered by the
  // slower list fetch.
  useEffect(() => {
    (async () => {
      try {
        const [p, list] = await Promise.all([window.api.rooms.getProfile(), window.api.rooms.list()]);
        setProfile(p);
        setProfileName(p.name);
        setRooms(list);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, []);

  // Keep something selected whenever rooms exist — covers first load, leaving
  // the selected room (handleLeave nulls the selection), and dead focus ids.
  useEffect(() => {
    if (!selectedId && rooms.length > 0) setSelectedId(rooms[0].roomId);
  }, [selectedId, rooms]);

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

  // The VPN kill-switch suspends/resumes all room networking; refetch the list
  // so its `suspended` flag (and the paused notice below) update at once instead
  // of waiting for a poll.
  useEffect(() => {
    const offDrop = window.api.onVpnDropped(() => { void refreshList(); });
    const offUp = window.api.onVpnRestored(() => { void refreshList(); });
    return () => { offDrop(); offUp(); };
  }, [refreshList]);

  // Load detail when selection changes. A dead id (room left elsewhere, stale
  // "online now" entry) clears the selection so the auto-select effect can
  // recover instead of stranding the page on a permanent loading state.
  useEffect(() => {
    if (!selectedId) { setRoom(null); return; }
    let alive = true;
    window.api.rooms.get(selectedId)
      .then((s) => { if (alive) setRoom(s); })
      .catch(() => { if (alive) setSelectedId((prev) => (prev === selectedId ? null : prev)); });
    return () => { alive = false; };
  }, [selectedId]);

  // Quiet presence toasts for the OPEN room: a member coming back online, or a
  // new file appearing from someone else. Derived by diffing successive room
  // states; the first state after load/switch only seeds the snapshot, so
  // nothing fires on join — only on transitions observed while watching.
  useEffect(() => {
    if (!room) { presenceSnapRef.current = null; return; }
    const prev = presenceSnapRef.current;
    presenceSnapRef.current = {
      roomId: room.roomId,
      online: new Map(room.members.map((m) => [m.memberId, m.online])),
      fileIds: new Set(room.files.map((f) => f.fileId)),
    };
    if (!prev || prev.roomId !== room.roomId) return; // initial load / room switch — seed only
    const now = Date.now();
    const fire = (key: string, msg: string) => {
      const seen = presenceToastAtRef.current;
      for (const [k, at] of seen) if (now - at > 30_000) seen.delete(k);
      if (seen.has(key)) return;
      seen.set(key, now);
      toast(msg);
    };
    for (const m of room.members) {
      if (m.isSelf || !m.online) continue;
      if (prev.online.get(m.memberId) === false) {
        fire(`online:${m.memberId}`, `${m.name || '?'} ${t('rooms.presenceOnline')}`);
      }
    }
    const selfId = room.members.find((m) => m.isSelf)?.memberId;
    for (const f of room.files) {
      if (prev.fileIds.has(f.fileId) || f.addedBy === selfId) continue;
      const who = room.members.find((m) => m.memberId === f.addedBy)?.name || f.addedByName || '?';
      fire(`file:${f.fileId}`, `${who} ${t('rooms.presenceShared')} ${f.name}`);
    }
  }, [room, t]);

  // A room requested from outside (sidebar rail / status-bar Join) wins over
  // the default selection. Consumed once, then cleared by the parent.
  useEffect(() => {
    if (!focusRoomId) return;
    setSelectedId(focusRoomId);
    onFocusHandled?.();
  }, [focusRoomId]);

  // Let the rail highlight the open room.
  useEffect(() => {
    onRoomSelected?.(selectedId);
    return () => onRoomSelected?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const state = await window.api.rooms.create(createName.trim() || t('rooms.defaultName'), createE2E);
      await refreshList();
      setSelectedId(state.roomId);
      setRoom(state);
      setDialog('invite');
      setCreateName('');
      setCreateE2E(true); // back to the safe default for the next room
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  // Opening the Join dialog peeks at the clipboard ONCE (an explicit user
  // action, never a background watcher) — a copied invite pre-fills the field.
  useEffect(() => {
    if (dialog !== 'join') return;
    let alive = true;
    navigator.clipboard.readText().then((text) => {
      const candidate = (text || '').trim();
      if (!alive || !candidate || candidate.length > 200) return;
      const normalized = candidate.toLowerCase().replace(/\s*~\s*/g, '~').replace(/\s+/g, '-').replace(/-+/g, '-');
      if (!INVITE_SHAPE_RE.test(normalized)) return;
      setJoinCode((cur) => cur || candidate);
      toast(t('rooms.joinFromClipboard'), { icon: '📋' });
    }).catch(() => { /* clipboard unavailable — type it in */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog]);

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    // A shape check up front beats the engine's generic failure: an incomplete
    // paste would otherwise just announce into the void (wrong code = empty
    // rendezvous, indistinguishable from a sleeping room). Mirror the engine's
    // forgiveness (room-crypto normalizeCode + parseInvite): whitespace around
    // the ~pin is trimmed, runs of spaces/dashes collapse to one dash.
    const normalized = joinCode.trim().toLowerCase()
      .replace(/\s*~\s*/g, '~')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    if (!INVITE_SHAPE_RE.test(normalized)) {
      toast.error(t('rooms.joinBadFormat'));
      return;
    }
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

  // Open the leave dialog (which chooses keep-files vs delete-files); if the
  // player is open on this room, close it first so it can't outlive the room.
  const requestLeave = (roomId: string) => {
    setLeaveTarget(roomId);
    setDialog('leave');
  };

  const doLeave = async (deleteFiles: boolean) => {
    const roomId = leaveTarget;
    if (!roomId) return;
    setDialog(null);
    setBusy(true);
    clearRoomFilesPrefs(roomId); // per-room sort/collapsed entries would accrue forever
    try {
      await window.api.rooms.leave(roomId, deleteFiles);
      await refreshList();
      setSelectedId((prev) => (prev === roomId ? null : prev));
      toast.success(deleteFiles ? t('rooms.leaveDelete') : t('rooms.leave'));
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); setLeaveTarget(null); }
  };

  // Apply a room-state result from a folder/add op (guarded against a room
  // switch outliving the async call — same rule as the live-update listener).
  const applyRoomState = (state: RoomState) => {
    if (state.roomId === selectedRef.current) setRoom(state);
    void refreshList();
  };

  // The target folder (if any) is handed to the engine, which assigns exactly
  // the files it adds — no renderer before/after diff that a concurrent peer add
  // could poison, and a re-added existing file still lands in the target.
  const handleAddFiles = async (roomId: string, targetFolderId?: string) => {
    setBusy(true);
    try {
      const state = await window.api.rooms.pickAndAddFiles(roomId, targetFolderId);
      if (state) applyRoomState(state);
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  // Files dropped onto the open room (paths already resolved by the caller);
  // targetFolderId set when they were dropped onto a specific section.
  const handleDropPaths = async (roomId: string, paths: string[], targetFolderId?: string) => {
    setBusy(true);
    try {
      applyRoomState(await window.api.rooms.addFiles(roomId, paths, targetFolderId));
      toast.success(t('rooms.dropShared'));
    } catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  };

  // ── Folder ops (any member may manage; the engine converges via LWW) ──────
  const handleCreateFolder = async (roomId: string, name: string, icon: string, color: string, parentId?: string) => {
    try { applyRoomState(await window.api.rooms.createFolder(roomId, name, icon, color, parentId)); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };
  const handleUpdateFolder = async (roomId: string, folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }) => {
    try { applyRoomState(await window.api.rooms.updateFolder(roomId, folderId, patch)); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };
  const handleDeleteFolder = async (roomId: string, folderId: string) => {
    try { applyRoomState(await window.api.rooms.deleteFolder(roomId, folderId)); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };
  const handleAssignFile = async (roomId: string, fileId: string, folderId: string | null) => {
    try { applyRoomState(await window.api.rooms.assignFile(roomId, fileId, folderId)); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };

  // Per-room auto-download toggle — optimistic flip; the engine's state push
  // (onRoomUpdate) is the source of truth right after.
  const handleToggleAutoFetch = async (roomId: string, autoFetch: boolean) => {
    setRoom((prev) => (prev && prev.roomId === roomId ? { ...prev, autoFetch } : prev));
    try { await window.api.rooms.setAutoFetch(roomId, autoFetch); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };

  // Per-room speed ceilings (KB/s, 0 = unlimited) — persisted + throttled live.
  const handleSetLimits = async (roomId: string, upKbps: number, downKbps: number) => {
    setRoom((prev) => (prev && prev.roomId === roomId ? { ...prev, upKbps, downKbps } : prev));
    try { await window.api.rooms.setLimits(roomId, upKbps, downKbps); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); }
  };

  const openProfile = () => {
    if (!profile) return;
    setProfileName(profile.name);
    setProfileSeed(profile.avatarSeed);
    setAvatarPool(avatarCandidates(2, profile.avatarSeed));
    setProfileColor(profile.color || '');
    setProfileStatus(profile.status || '');
    setDialog('profile');
  };

  const handleSaveProfile = async () => {
    setBusy(true);
    try {
      const p = await window.api.rooms.setProfile({
        name: profileName.trim(),
        avatarSeed: profileSeed,
        color: sanitizeProfileColor(profileColor) ?? '',
        status: sanitizeProfileStatus(profileStatus),
        avatarImg: '', // custom avatar images were removed — always clear any prior one
      });
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
              <Avatar seed={profile.avatarSeed} img={profile.avatarImg} size={28} ring />
              <span style={profile.color ? { color: profile.color } : undefined}>{profile.name || t('rooms.you')}</span>
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
          action={{ label: t('rooms.create'), icon: 'plus', onClick: () => { setCreateName(''); setDialog('create'); } }}
          secondaryAction={{ label: t('rooms.join'), icon: 'link', onClick: () => { setJoinCode(''); setDialog('join'); } }}
        />
      ) : (
        <div className="rooms-body">
          {/* Room detail — the room list lives in the sidebar rail */}
          <section className="room-detail">
            {!room ? (
              rooms.some((r) => r.suspended) ? (
                <div className="room-suspended">
                  <Icon name="shield" size={28} />
                  <p className="room-suspended-title">{t('rooms.suspended.title')}</p>
                  <p className="room-suspended-body">{t('rooms.suspended.body')}</p>
                </div>
              ) : (
                <div className="page-loading">{t('common.loading')}</div>
              )
            ) : (
              <RoomDetail
                room={room}
                suspended={rooms.find((r) => r.roomId === room.roomId)?.suspended === true}
                notifyMuted={rooms.find((r) => r.roomId === room.roomId)?.notifyMuted === true}
                onToggleNotifyMuted={(muted) => {
                  window.api.rooms.setNotifyMuted(room.roomId, muted)
                    .then(() => refreshList())
                    .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                }}
                onAddFiles={(folderId) => handleAddFiles(room.roomId, folderId)}
                onDropFiles={(paths, folderId) => handleDropPaths(room.roomId, paths, folderId)}
                onCreateFolder={(name, icon, color, parentId) => handleCreateFolder(room.roomId, name, icon, color, parentId)}
                onUpdateFolder={(folderId, patch) => handleUpdateFolder(room.roomId, folderId, patch)}
                onDeleteFolder={(folderId) => handleDeleteFolder(room.roomId, folderId)}
                onAssignFile={(fileId, folderId) => handleAssignFile(room.roomId, fileId, folderId)}
                onOpenFolder={() => window.api.rooms.openFolder(room.roomId)}
                onInvite={() => setDialog('invite')}
                onLeave={() => requestLeave(room.roomId)}
                onCopyCode={() => copy(room.code, t('rooms.codeCopied'))}
                onToggleAutoFetch={(v) => handleToggleAutoFetch(room.roomId, v)}
                onSetLimits={(up, down) => handleSetLimits(room.roomId, up, down)}
                onShared={(state) => {
                  // The share can outlive a room switch — only apply the state
                  // if that room is still the one on screen (same guard as the
                  // live-update listener).
                  if (state.roomId === selectedRef.current) setRoom(state);
                  void refreshList();
                }}
                busy={busy}
              />
            )}
          </section>
        </div>
      )}

      {/* ── Dialogs (shared Ember Modal shell) ──────────────────────────── */}
      {dialog === 'create' && (
        <Modal
          title={t('rooms.createTitle')} icon="plus" busy={busy} onClose={() => setDialog(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleCreate} loading={busy}>{t('rooms.create')}</Button>
          </>}
        >
          <p className="rooms-modal-desc">{t('rooms.createDesc')}</p>
          <input
            className="rooms-input" data-autofocus
            placeholder={t('rooms.namePlaceholder')}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button type="button" className={`rooms-e2e-toggle ${createE2E ? 'on' : ''}`} onClick={() => setCreateE2E((v) => !v)}>
            <span className="rooms-e2e-check">{createE2E && <Icon name="check" size={12} />}</span>
            <span className="rooms-e2e-text">
              <span className="rooms-e2e-label"><Icon name="lock" size={12} /> {t('rooms.e2e')} <em>{t('rooms.e2eRecommended')}</em></span>
              <span className={`rooms-e2e-hint ${createE2E ? '' : 'warn'}`}>{createE2E ? t('rooms.e2eHint') : t('rooms.e2eOffWarn')}</span>
            </span>
          </button>
        </Modal>
      )}

      {dialog === 'join' && (
        <Modal
          title={t('rooms.joinTitle')} icon="link" busy={busy} onClose={() => setDialog(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleJoin} loading={busy} disabled={!joinCode.trim()}>{t('rooms.join')}</Button>
          </>}
        >
          <p className="rooms-modal-desc">{t('rooms.joinDesc')}</p>
          <input
            className="rooms-input rooms-input-code" data-autofocus
            placeholder="swift-amber-otter-comet-4821"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
          <p className="rooms-join-hint">{t('rooms.joinServerlessHint')}</p>
        </Modal>
      )}

      {dialog === 'leave' && (
        <Modal
          title={t('rooms.leaveTitle')} busy={busy} onClose={() => setDialog(null)}
          footer={<Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>}
        >
          <p className="rooms-modal-desc">{t('rooms.leaveDesc')}</p>
          <div className="rooms-leave">
            <button type="button" className="rooms-leave-opt" onClick={() => doLeave(false)} disabled={busy}>
              <span className="rooms-leave-ico"><Icon name="check" size={16} /></span>
              <span className="rooms-leave-txt"><strong>{t('rooms.leaveKeep')}</strong></span>
            </button>
            <button type="button" className="rooms-leave-opt danger" onClick={() => doLeave(true)} disabled={busy}>
              <span className="rooms-leave-ico"><Icon name="trash" size={16} /></span>
              <span className="rooms-leave-txt"><strong>{t('rooms.leaveDelete')}</strong><em>{t('rooms.leaveDeleteHint')}</em></span>
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'profile' && profile && (
        <Modal
          title={t('rooms.profileTitle')} icon="user" busy={busy} onClose={() => setDialog(null)}
          footer={<>
            <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSaveProfile} loading={busy}>{t('common.save')}</Button>
          </>}
        >
          <div className="rooms-profile-edit">
            <Identicon seed={profileSeed} size={64} ring />
            <div className="rooms-profile-fields">
              <input
                className="rooms-input" data-autofocus
                placeholder={t('rooms.namePlaceholder')}
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
              />
              <input
                className="rooms-input"
                placeholder={t('rooms.profileStatusPlaceholder')}
                maxLength={140}
                value={profileStatus}
                onChange={(e) => setProfileStatus(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
              />
            </div>
          </div>
          {/* Name color: a small themed palette + a free-pick well. */}
          <div className="rooms-avatar-pick-head">
            <span className="rooms-avatar-pick-label">{t('rooms.profileColor')}</span>
          </div>
          <div className="rooms-profile-colors">
            <button
              type="button"
              className={`rooms-color-swatch none ${profileColor === '' ? 'active' : ''}`}
              onClick={() => setProfileColor('')}
              title={t('rooms.profileColorNone')}
              aria-pressed={profileColor === ''}
            >
              <Icon name="x" size={11} />
            </button>
            {['#e8590c', '#f59f00', '#40c057', '#22b8cf', '#4dabf7', '#748ffc', '#9775fa', '#f06595'].map((c) => (
              <button
                key={c}
                type="button"
                className={`rooms-color-swatch ${profileColor === c ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setProfileColor(c)}
                aria-pressed={profileColor === c}
                aria-label={c}
              />
            ))}
            <input
              type="color"
              className="rooms-color-custom"
              value={PROFILE_COLOR_RE.test(profileColor) ? profileColor : '#e8590c'}
              onChange={(e) => setProfileColor(e.target.value)}
              title={t('rooms.profileColorCustom')}
            />
          </div>
          <div className="rooms-avatar-pick-head">
            <span className="rooms-avatar-pick-label">{t('rooms.avatarPick')}</span>
            <button type="button" className="rooms-avatar-shuffle" onClick={() => setAvatarPool(avatarCandidates(2, profileSeed))} title={t('rooms.avatarShuffle')}>
              <Icon name="refresh" size={13} /> {t('rooms.avatarShuffle')}
            </button>
          </div>
          <div className="rooms-avatar-grid">
            {avatarPool.map((seed) => (
              <button key={seed} type="button" className={`rooms-avatar-option ${seed === profileSeed ? 'active' : ''}`} onClick={() => setProfileSeed(seed)} aria-pressed={seed === profileSeed}>
                <Identicon seed={seed} size={44} />
              </button>
            ))}
          </div>
          <p className="rooms-modal-desc">{t('rooms.profileDesc')}</p>
        </Modal>
      )}

      {dialog === 'invite' && room && (
        <Modal
          title={t('rooms.inviteTitle')} icon="share-2" onClose={() => setDialog(null)}
          footer={<Button variant="primary" onClick={() => setDialog(null)}>{t('common.done')}</Button>}
        >
          <p className="rooms-modal-desc">{t('rooms.inviteDesc')}</p>
          {/* A preview of what you're inviting people INTO (a QR is useless on a
              desktop-only app). The invite string PINS the owner so a joiner
              can't be tricked into adopting an impostor. The chip below shows the
              speakable code for verbal sharing (trust-on-first-use). */}
          {(() => {
            const totalSize = room.files.reduce((s, f) => s + (f.size || 0), 0);
            const inVoice = room.voice?.participants?.length ?? 0;
            const shown = room.members.slice(0, 6);
            return (
              <div className="rooms-invite-preview">
                <div className="rooms-invite-preview-head">
                  <span className="rooms-invite-preview-name">{room.name || t('rooms.untitled')}</span>
                  {inVoice > 0 && (
                    <span className="rooms-invite-preview-voice"><Icon name="headphones" size={12} /> {inVoice}</span>
                  )}
                </div>
                {room.topic && <p className="rooms-invite-preview-topic">{room.topic}</p>}
                <div className="rooms-invite-preview-avatars">
                  {shown.map((m) => (
                    <Identicon key={m.memberId} seed={m.avatarSeed} size={28} title={m.name} />
                  ))}
                  {room.members.length > shown.length && (
                    <span className="rooms-invite-preview-more">+{room.members.length - shown.length}</span>
                  )}
                </div>
                <div className="rooms-invite-preview-stats">
                  <span><Icon name="users" size={12} /> {t('rooms.invitePeople').replace('{n}', String(room.members.length))}</span>
                  <span><Icon name="file" size={12} /> {t('rooms.inviteFiles').replace('{n}', String(room.files.length))}</span>
                  {totalSize > 0 && <span>{formatBytes(totalSize)}</span>}
                </div>
              </div>
            );
          })()}
          <button
            type="button"
            className="rooms-invite-copy"
            onClick={() => copy(room.invite || room.code, t('rooms.codeCopied'))}
          >
            <Icon name="copy" size={15} /> {t('rooms.copyInvite')}
          </button>
          <div className="rooms-invite-code" onClick={() => copy(room.code, t('rooms.codeCopied'))} title={t('rooms.copyCode')}>
            <span>{room.code}</span>
            <Icon name="copy" size={16} />
          </div>
        </Modal>
      )}
    </div>
  );
};

// Inline create/rename editor for a room folder (name + icon + color).
const RoomFolderEditor: React.FC<{
  initial?: { name: string; icon: string; color: string };
  onSubmit: (name: string, icon: string, color: string) => void;
  onCancel: () => void;
}> = ({ initial, onSubmit, onCancel }) => {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState<string>(initial?.icon || FOLDER_ICONS[0]);
  const [color, setColor] = useState<string>(initial?.color || FOLDER_COLORS[0]);
  const submit = () => { const n = name.trim(); if (n) onSubmit(n, icon, color); };
  return (
    <div className="room-folder-editor">
      <input
        className="room-folder-name"
        autoFocus
        placeholder={t('rooms.folder.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
      />
      <div className="room-folder-swatches" role="group" aria-label={t('rooms.folder.icon')}>
        {FOLDER_ICONS.map((ic) => (
          <button key={ic} type="button" className={`room-folder-swatch${icon === ic ? ' active' : ''}`} onClick={() => setIcon(ic)} aria-label={ic} aria-pressed={icon === ic}>
            <Icon name={ic} size={13} />
          </button>
        ))}
      </div>
      <div className="room-folder-swatches" role="group" aria-label={t('rooms.folder.color')}>
        {FOLDER_COLORS.map((c) => (
          <button key={c} type="button" className={`room-folder-color${color === c ? ' active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`${t('rooms.folder.color')} ${c}`} aria-pressed={color === c} />
        ))}
      </div>
      <div className="room-folder-editor-actions">
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={!name.trim()}>{t('common.save')}</Button>
      </div>
    </div>
  );
};

// What the room's center Stage is showing. Files is the base; Watch/Screen add a
// tab and auto-focus. Single-slot union — opening one supersedes the other.
// `together` seeds the player's sync toggle ON (joining an ongoing session).
type StageView =
  | { kind: 'files' }
  | { kind: 'watch'; file: RoomFile; together?: boolean }
  | { kind: 'screen'; memberId: string };

/** Loose shape check for an invite code: word-word-word-word-NNNN, optional
 *  legacy "-e2e" suffix, optional "~<32-hex ownerPin>" (see room-crypto.ts).
 *  Format-only on purpose — wordlist membership isn't checked, so older or
 *  hand-typed codes with unknown words still pass. */
const INVITE_SHAPE_RE = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{4}(-e2e)?(~[0-9a-f]{32})?$/i;

// ── Files panel (the Stage's default surface) ─────────────────────────────
// The room's shared files: list/folders, search/sort/filter, bulk selection,
// request-a-file, speed limits. Extracted from RoomDetail so the Stage can swap
// it for the inline watch player or screen viewer. OS-file drag-drop stays on
// RoomDetail's container; only the section-internal file→folder reassign is here.
interface FilesPanelProps {
  room: RoomState;
  onAddFiles: (folderId?: string) => void;
  /** OS files dropped onto a specific section/subfolder (paths resolved). */
  onDropFiles: (paths: string[], folderId?: string) => void;
  onCreateFolder: (name: string, icon: string, color: string, parentId?: string) => void;
  onUpdateFolder: (folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }) => void;
  onDeleteFolder: (folderId: string) => void;
  onAssignFile: (fileId: string, folderId: string | null) => void;
  onWatch: (file: RoomFile) => void;
  /** Join an ongoing watch session on this file (sync pre-enabled). */
  onWatchJoin: (file: RoomFile) => void;
  /** Live watch-session member counts per fileId (row badges). */
  watchCounts: Record<string, number>;
  /** Open the invite dialog (the empty-room onboarding CTA). */
  onInvite: () => void;
  onShared: (state: RoomState) => void;
  onToggleAutoFetch: (autoFetch: boolean) => void;
  busy: boolean;
}

const RoomFilesPanel: React.FC<FilesPanelProps> = ({ room, onAddFiles, onDropFiles, onCreateFolder, onUpdateFolder, onDeleteFolder, onAssignFile, onWatch, onWatchJoin, watchCounts, onInvite, onShared, onToggleAutoFetch, busy }) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [pickTransfer, setPickTransfer] = useState(false);
  // Client-side file filter/sort + bulk selection (all room-local, no engine calls).
  const [fileQuery, setFileQuery] = useState('');
  const [sortKey, setSortKeyRaw] = useState<'added' | 'name' | 'size' | 'status'>(() => loadRoomSort(room.roomId));
  const [sortDir, setSortDirRaw] = useState<RoomFilesSortDir>(() => loadRoomSortDir(room.roomId, loadRoomSort(room.roomId)));
  // Switching the sort key resets the direction to that key's natural one.
  const setSortKey = (k: typeof sortKey) => {
    setSortKeyRaw(k); saveRoomSort(room.roomId, k);
    setSortDirRaw(SORT_NATURAL_DIR[k]); saveRoomSortDir(room.roomId, SORT_NATURAL_DIR[k]);
  };
  const toggleSortDir = () => {
    const d: RoomFilesSortDir = sortDir === 'asc' ? 'desc' : 'asc';
    setSortDirRaw(d); saveRoomSortDir(room.roomId, d);
  };
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'audio' | 'other'>('all');
  const [onlyMine, setOnlyMine] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // View prefs (density / reactions / type icons) + per-room collapsed folders.
  const [viewPrefs, setViewPrefs] = useState<RoomFilesPrefs>(loadRoomFilesPrefs);
  const [viewOpen, setViewOpen] = useState(false);
  const viewWrapRef = useRef<HTMLDivElement>(null);
  const updateView = (patch: Partial<RoomFilesPrefs>) => {
    setViewPrefs((p) => { const next = { ...p, ...patch }; saveRoomFilesPrefs(next); return next; });
  };
  // The view popover closes like every other floating surface: outside click / Escape.
  useEffect(() => {
    if (!viewOpen) return;
    const onDown = (e: MouseEvent) => {
      if (viewWrapRef.current && !viewWrapRef.current.contains(e.target as Node)) setViewOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [viewOpen]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedFolders(room.roomId));
  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveCollapsedFolders(room.roomId, next);
      return next;
    });
  };
  const selfId = room.members.find((m) => m.isSelf)?.memberId;
  const statusRank = useCallback((f: RoomFile) => {
    const tr = room.transfers?.[f.fileId];
    if (tr?.haveLocally) return 0;
    if (tr?.status === 'downloading') return 1;
    if (tr?.status === 'queued') return 2;
    return 3;
  }, [room.transfers]);
  const visibleFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    let arr = room.files;
    if (q) arr = arr.filter((f) => f.name.toLowerCase().includes(q));
    if (typeFilter !== 'all') arr = arr.filter((f) => classifyMediaKind(f.name) === typeFilter);
    if (onlyMine) arr = arr.filter((f) => f.addedBy === selfId);
    if (onlyMissing) arr = arr.filter((f) => !room.transfers?.[f.fileId]?.haveLocally);
    // Ascending comparators; the direction toggle flips the whole order.
    const cmp = (a: RoomFile, b: RoomFile): number => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      if (sortKey === 'size') return (a.size || 0) - (b.size || 0);
      // Status keeps its historical newest-first tiebreak WITHIN a rank (the
      // direction toggle flips ranks; equal-rank recency reads better fixed).
      if (sortKey === 'status') return statusRank(a) - statusRank(b) || (b.addedAt || 0) - (a.addedAt || 0);
      return (a.addedAt || 0) - (b.addedAt || 0);
    };
    return [...arr].sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : -cmp(a, b)));
  }, [room.files, room.transfers, fileQuery, typeFilter, onlyMine, onlyMissing, selfId, sortKey, sortDir, statusRank]);
  const toggleSelect = useCallback((fileId: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(fileId)) next.delete(fileId); else next.add(fileId); return next; });
  }, []);
  // Drop selected ids that no longer exist (a file was removed elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const live = new Set(room.files.map((f) => f.fileId));
      const next = new Set(Array.from(prev).filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [room.files]);
  // Request-a-file: rides the signed chat pipeline (renders as a normal message).
  const [requesting, setRequesting] = useState(false);
  const [requestDraft, setRequestDraft] = useState('');
  const submitRequest = () => {
    const q = requestDraft.trim();
    setRequesting(false); setRequestDraft('');
    if (!q) return;
    window.api.rooms.requestFile(room.roomId, `🙋 ${t('rooms.requestPrefix')}: ${q}`)
      .then(() => toast.success(t('rooms.requestSent')))
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  useEffect(() => {
    setFileQuery(''); // the filter belongs to one room's list, not the next
    setSortKeyRaw(loadRoomSort(room.roomId)); // per-room remembered sort
    setSortDirRaw(loadRoomSortDir(room.roomId, loadRoomSort(room.roomId)));
    setTypeFilter('all'); setOnlyMine(false); setOnlyMissing(false);
    setSelecting(false); setSelected(new Set());
    setCollapsed(loadCollapsedFolders(room.roomId));
    setViewOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId]);
  // Folders/sections overlay. `hasFolders` gates progressive disclosure: with
  // none, the file list renders flat exactly as before.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // Section id an inline "new subfolder" editor is open under (null = none).
  const [newSubfolderFor, setNewSubfolderFor] = useState<string | null>(null);
  const [editFolderId, setEditFolderId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  useEffect(() => { setNewFolderOpen(false); setNewSubfolderFor(null); setEditFolderId(null); }, [room.roomId]);
  const folders = room.folders ?? [];
  const hasFolders = folders.length > 0;
  const grouped = useMemo(() => {
    const g = groupFilesByHierarchy(visibleFiles, room.folders ?? []);
    if (!fileQuery.trim()) return g;
    // During an active search, hide empty folders/sections so matches aren't buried.
    return g
      .map((s) => ({ ...s, children: s.children.filter((c) => c.files.length > 0) }))
      .filter((s) => s.files.length > 0 || s.children.length > 0);
  }, [visibleFiles, room.folders, fileQuery]);
  // Section list for "move to section" menus (a folder with children can't
  // become a child itself — the engine enforces the same one-level rule).
  const sectionFolders = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f] as const));
    return folders.filter((f) => !f.parentId || f.parentId === f.id || !byId.has(f.parentId));
  }, [folders]);
  const folderLabel = useCallback((f: RoomFolder) => {
    const parent = f.parentId ? folders.find((x) => x.id === f.parentId) : undefined;
    return parent && parent.id !== f.id ? `${parent.name} / ${f.name}` : f.name;
  }, [folders]);

  // Drop targets on a section: an internal file-row drag reassigns the file(s)
  // there (folderId null = Uncategorized); an OS-file drag shares straight into
  // that section. An OS drop anywhere else still falls through to the room
  // overlay and lands in Uncategorized.
  const sectionDropProps = (folderId: string | null, key: string) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      const internal = types.includes(FILE_DND_TYPE);
      const osFiles = types.includes('Files') && !room.kicked;
      if (!internal && !osFiles) return;
      e.preventDefault(); e.stopPropagation();
      if (dragOverKey !== key) setDragOverKey(key);
    },
    onDragLeave: () => setDragOverKey((k) => (k === key ? null : k)),
    onDrop: (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (types.includes(FILE_DND_TYPE)) {
        e.preventDefault(); e.stopPropagation();
        setDragOverKey(null);
        // Payload is one-or-more fileIds ('\n'-joined — a multi-selection drag).
        // Skip files already in the target folder (a same-section drop is a no-op).
        const target = folderId || null;
        const ids = e.dataTransfer.getData(FILE_DND_TYPE).split('\n').filter(Boolean)
          .filter((id) => (room.files.find((f) => f.fileId === id)?.folderId ?? null) !== target);
        if (ids.length > 1) assignMany(ids, folderId);
        else if (ids[0]) onAssignFile(ids[0], folderId);
        return;
      }
      if (types.includes('Files') && !room.kicked) {
        e.preventDefault(); e.stopPropagation();
        setDragOverKey(null);
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => { try { return window.api.getPathForFile(f); } catch { return ''; } })
          .filter(Boolean);
        // Virtual files (mail attachments, images dragged from a browser)
        // resolve to no path — surface the same error the room-level drop
        // shows instead of silently eating the consumed drop.
        if (paths.length) onDropFiles(paths, folderId || undefined);
        else toast.error(t('create.dropReadError'));
      }
    },
  });

  // Dragging a SELECTED row moves the whole selection; any other row moves alone.
  const getDragIds = useCallback((fileId: string): string[] => (
    selecting && selected.has(fileId) ? Array.from(selected) : [fileId]
  ), [selecting, selected]);

  const assignMany = (fileIds: string[], folderId: string | null) => {
    window.api.rooms.assignFiles(room.roomId, fileIds, folderId)
      .then(onShared)
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  const renderFolderFiles = (files: RoomFile[]) => (
    files.map((f) => (
      <RoomFileRow
        key={f.fileId} file={f} room={room} onWatch={onWatch} onWatchJoin={onWatchJoin}
        watchCount={watchCounts[f.fileId] || 0} onAssignFile={onAssignFile}
        selecting={selecting} selected={selected.has(f.fileId)} onToggleSelect={toggleSelect}
        getDragIds={getDragIds} viewPrefs={viewPrefs} highlightQuery={fileQuery}
      />
    ))
  );

  // One header for both levels (sections and their subfolders): collapse toggle,
  // fetch-cycle with the EFFECTIVE inherited state in the tooltip, add-into,
  // new-subfolder (sections only), move-to-section (nested / childless), rename,
  // delete. Renders the inline editor in place while renaming.
  const renderFolderHeader = (
    folder: RoomFolder | null,
    count: number,
    isCollapsed: boolean,
    key: string,
    opts: { canNest: boolean; childCount: number },
  ) => {
    if (folder && editFolderId === folder.id) {
      return (
        <RoomFolderEditor
          initial={{ name: folder.name, icon: folder.icon, color: folder.color }}
          onSubmit={(name, icon, color) => { setEditFolderId(null); onUpdateFolder(folder.id, { name, icon, color }); }}
          onCancel={() => setEditFolderId(null)}
        />
      );
    }
    const moveTargets = folder
      ? sectionFolders.filter((s) => s.id !== folder.id && s.id !== (folder.parentId || ''))
      : [];
    const canMove = !!folder && opts.childCount === 0 && (moveTargets.length > 0 || !!folder.parentId);
    return (
      <div className="room-folder-header">
        <button type="button" className="room-folder-label room-folder-toggle" onClick={() => toggleCollapsed(key)} title={isCollapsed ? t('rooms.folder.expand') : t('rooms.folder.collapse')}>
          <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} className="room-folder-chevron" />
          <FolderIcon folder={folder} />
          <span className="room-folder-title">{folder ? folder.name : t('rooms.folder.uncategorized')}</span>
          <span className="room-folder-count">{count}</span>
        </button>
        <span className="room-folder-acts">
          {/* Quick actions stay as buttons; everything secondary — including the
              auto-download override (per the "one master toggle, the rest in a
              menu" model) — lives in the ⋯ overflow so the header stays calm. */}
          <button className="room-folder-act" title={t('rooms.folder.addHere')} onClick={() => onAddFiles(folder?.id)}>
            <Icon name="file-plus" size={13} />
          </button>
          {folder && opts.canNest && (
            <button
              className="room-folder-act"
              title={t('rooms.folder.newSub')}
              onClick={() => {
                setNewFolderOpen(false); setEditFolderId(null); setNewSubfolderFor((v) => (v === folder.id ? null : folder.id));
                if (collapsed.has(key)) toggleCollapsed(key); // the editor must be visible
              }}
            >
              <Icon name="folder-plus" size={13} />
            </button>
          )}
          {folder && (() => {
            const ov = room.folderFetch?.[folder.id];
            const effective = wantAutoFetch(room.autoFetch, room.folderFetch, folder.id, (id) => folders.find((x) => x.id === id)?.parentId);
            const check = (on: boolean) => (on ? <Icon name="check" size={13} /> : <span style={{ width: 13, display: 'inline-block' }} />);
            const setFetch = (mode: boolean | null) => window.api.rooms.setFolderAutoFetch(room.roomId, folder.id, mode).then(onShared).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
            return (
              <DropdownMenu
                portal
                renderTrigger={({ toggle }) => (
                  <button className="room-folder-act" title={t('rooms.folder.more')} onClick={toggle}>
                    <Icon name="more-horizontal" size={13} />
                  </button>
                )}
                items={[
                  { key: 'af-inherit', icon: check(ov === undefined), label: `${t('rooms.folder.fetchInherit')} · ${effective ? t('rooms.folder.effOn') : t('rooms.folder.effOff')}`, onSelect: () => setFetch(null) },
                  { key: 'af-on', icon: check(ov === true), label: t('rooms.folder.fetchOn'), onSelect: () => setFetch(true) },
                  { key: 'af-off', icon: check(ov === false), label: t('rooms.folder.fetchOff'), onSelect: () => setFetch(false) },
                  ...(canMove ? moveTargets.map((s) => ({ key: `mv-${s.id}`, icon: <Icon name="arrow-right" size={13} />, label: `${t('rooms.folder.moveToSection')}: ${s.name}`, onSelect: () => onUpdateFolder(folder.id, { parentId: s.id }) })) : []),
                  ...(canMove && folder.parentId ? [{ key: 'mv-root', icon: <Icon name="arrow-right" size={13} />, label: t('rooms.folder.toRoot'), onSelect: () => onUpdateFolder(folder.id, { parentId: null }) }] : []),
                  { key: 'rename', icon: <Icon name="edit-2" size={13} />, label: t('rooms.folder.rename'), onSelect: () => { setNewFolderOpen(false); setNewSubfolderFor(null); setEditFolderId(folder.id); } },
                  { key: 'delete', icon: <Icon name="trash" size={13} />, label: t('rooms.folder.delete'), onSelect: async () => {
                    const realCount = room.files.filter((f) => f.folderId === folder.id).length;
                    const msg = opts.childCount > 0 ? t('rooms.folder.deleteSectionConfirm') : t('rooms.folder.deleteConfirm');
                    if ((realCount === 0 && opts.childCount === 0) || await confirm({ message: msg, danger: true })) onDeleteFolder(folder.id);
                  } },
                ]}
              />
            );
          })()}
        </span>
      </div>
    );
  };

  return (
    <div className={`room-section${viewPrefs.density === 'compact' ? ' room-files-compact' : ''}`}>
      <div className="room-section-title-row">
        <div className="room-section-title">
          {t('rooms.sharedFiles')} · {room.files.length}
          {room.files.length > 0 && (
            <span className="room-files-total"> · {formatBytes(room.files.reduce((s, f) => s + (f.size || 0), 0))}</span>
          )}
        </div>
        <div className="room-section-title-actions">
          <div className="room-view-wrap" ref={viewWrapRef}>
            <button
              type="button"
              className={`room-newfolder-btn icon-only${viewOpen ? ' active' : ''}`}
              title={t('rooms.view')}
              aria-label={t('rooms.view')}
              onClick={() => setViewOpen((v) => !v)}
            >
              <Icon name="sliders" size={14} />
            </button>
            {viewOpen && (
              <div className="room-view-pop">
                <div className="room-view-row">
                  <span>{t('rooms.viewCompact')}</span>
                  <Toggle size="small" checked={viewPrefs.density === 'compact'} onChange={(v) => updateView({ density: v ? 'compact' : 'cozy' })} ariaLabel={t('rooms.viewCompact')} />
                </div>
                <div className="room-view-row">
                  <span>{t('rooms.viewReactions')}</span>
                  <Toggle size="small" checked={viewPrefs.showReactions} onChange={(v) => updateView({ showReactions: v })} ariaLabel={t('rooms.viewReactions')} />
                </div>
                <div className="room-view-row">
                  <span>{t('rooms.viewTypeIcons')}</span>
                  <Toggle size="small" checked={viewPrefs.typeIcons} onChange={(v) => updateView({ typeIcons: v })} ariaLabel={t('rooms.viewTypeIcons')} />
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="room-newfolder-btn icon-only"
            title={t('rooms.requestFile')}
            aria-label={t('rooms.requestFile')}
            onClick={() => setRequesting((v) => !v)}
          >
            <Icon name="file-question" size={14} />
          </button>
          <button
            type="button"
            className="room-newfolder-btn icon-only"
            title={t('rooms.folder.newSection')}
            aria-label={t('rooms.folder.newSection')}
            onClick={() => { setEditFolderId(null); setNewSubfolderFor(null); setNewFolderOpen((v) => !v); }}
          >
            <Icon name="plus" size={14} />
          </button>
          <div className="room-autofetch" title={t('rooms.autoFetchHint')}>
            <Toggle size="small" checked={room.autoFetch} onChange={onToggleAutoFetch} label={t('rooms.autoFetch')} />
          </div>
        </div>
      </div>

      {room.files.length > 0 && (
        <div className="room-file-search">
          <Icon name="search" size={13} />
          <input
            type="text"
            placeholder={t('rooms.fileSearch')}
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setFileQuery(''); }}
          />
        </div>
      )}

      {room.files.length > 1 && !selecting && (
        <div className="room-file-toolbar">
          <Select
            className="room-file-select"
            value={sortKey}
            onChange={(v) => setSortKey(v as typeof sortKey)}
            options={[
              { value: 'added', label: t('rooms.sort.added') },
              { value: 'name', label: t('rooms.sort.name') },
              { value: 'size', label: t('rooms.sort.size') },
              { value: 'status', label: t('rooms.sort.status') },
            ]}
          />
          <button
            type="button"
            className="room-newfolder-btn icon-only"
            title={sortDir === 'asc' ? t('rooms.sortAsc') : t('rooms.sortDesc')}
            aria-label={sortDir === 'asc' ? t('rooms.sortAsc') : t('rooms.sortDesc')}
            onClick={toggleSortDir}
          >
            <Icon name={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} size={13} />
          </button>
          <span className="room-file-chips">
            {([['all', t('rooms.filter.all')], ['video', t('rooms.filter.video')], ['audio', t('rooms.filter.audio')], ['other', t('rooms.filter.other')]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`room-file-chip${typeFilter === k ? ' active' : ''}`}
                onClick={() => setTypeFilter(k)}
              >
                {label}
              </button>
            ))}
            <button type="button" className={`room-file-chip${onlyMine ? ' active' : ''}`} onClick={() => setOnlyMine((v) => !v)}>
              {t('rooms.filter.mine')}
            </button>
            <button type="button" className={`room-file-chip${onlyMissing ? ' active' : ''}`} onClick={() => setOnlyMissing((v) => !v)}>
              {t('rooms.filter.missing')}
            </button>
          </span>
          <button type="button" className="room-file-select-btn" onClick={() => setSelecting(true)}>
            <Icon name="check-circle" size={13} /> {t('rooms.select')}
          </button>
        </div>
      )}

      {selecting && (
        <div className="room-file-bulkbar">
          <span className="room-file-bulk-count">{t('rooms.selectedCount').replace('{n}', String(selected.size))}</span>
          <button type="button" className="room-file-select-btn" onClick={() => setSelected(new Set(visibleFiles.map((f) => f.fileId)))}>{t('rooms.selectAll')}</button>
          <button type="button" className="room-file-select-btn" onClick={() => setSelected(new Set())}>{t('rooms.clearSelection')}</button>
          {hasFolders && (
            <DropdownMenu
              portal
              renderTrigger={({ toggle }) => (
                <button type="button" className="room-file-select-btn" disabled={selected.size === 0} onClick={toggle}>
                  <Icon name="folder" size={13} /> {t('rooms.moveToFolder')}
                </button>
              )}
              items={[
                ...folders.map((f) => ({ key: f.id, label: folderLabel(f), onSelect: () => { assignMany(Array.from(selected), f.id); setSelected(new Set()); setSelecting(false); } })),
                { key: '', label: t('rooms.folder.uncategorized'), onSelect: () => { assignMany(Array.from(selected), null); setSelected(new Set()); setSelecting(false); } },
              ]}
            />
          )}
          <button
            type="button" className="room-file-bulk-del" disabled={selected.size === 0}
            onClick={async () => {
              const ids = Array.from(selected);
              if (!ids.length) return;
              // The engine only tombstones files we're authorized to delete
              // (ours, or any as owner); the rest degrade to a local hide —
              // say so up front instead of promising a room-wide delete.
              const others = room.canManage ? 0 : ids.filter((id) => room.files.find((f) => f.fileId === id)?.addedBy !== selfId).length;
              const own = ids.length - others;
              const message = others === 0
                ? t('rooms.deleteSelectedConfirm').replace('{n}', String(ids.length))
                : own === 0
                  ? t('rooms.hideSelectedConfirm').replace('{n}', String(ids.length))
                  : t('rooms.deleteSelectedMixed').replace('{own}', String(own)).replace('{other}', String(others));
              if (!(await confirm({ message, danger: own > 0 }))) return;
              window.api.rooms.removeFiles(room.roomId, ids).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
              setSelected(new Set()); setSelecting(false);
            }}
          >
            <Icon name="trash" size={13} /> {t('rooms.deleteSelected')}
          </button>
          <button type="button" className="room-file-select-btn" onClick={() => { setSelecting(false); setSelected(new Set()); }}>{t('rooms.selectDone')}</button>
        </div>
      )}

      {requesting && (
        <div className="room-request-row">
          <Icon name="file-question" size={14} />
          <input
            type="text" autoFocus placeholder={t('rooms.requestPlaceholder')} value={requestDraft}
            onChange={(e) => setRequestDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitRequest(); if (e.key === 'Escape') { setRequesting(false); setRequestDraft(''); } }}
          />
          <Button variant="primary" size="sm" onClick={submitRequest} disabled={!requestDraft.trim()}>{t('rooms.requestFile')}</Button>
        </div>
      )}

      {newFolderOpen && (
        <RoomFolderEditor
          onSubmit={(name, icon, color) => { setNewFolderOpen(false); onCreateFolder(name, icon, color); }}
          onCancel={() => setNewFolderOpen(false)}
        />
      )}

      <div className="room-files-scroll">
      {!hasFolders ? (
        room.files.length === 0 ? (
          // Empty-room onboarding: the three steps that bring a room to life.
          <div className="room-onboard">
            <p className="room-onboard-desc">{t('rooms.onboard.desc')}</p>
            <div className="room-onboard-steps">
              <button type="button" className="room-onboard-step" onClick={onInvite}>
                <Icon name="share-2" size={16} /> {t('rooms.onboard.invite')}
              </button>
              <button type="button" className="room-onboard-step" onClick={() => onAddFiles()}>
                <Icon name="file-plus" size={16} /> {t('rooms.onboard.add')}
              </button>
              {!room.voice.inVoice && (
                <button
                  type="button"
                  className="room-onboard-step"
                  onClick={() => {
                    window.api.rooms.voice.join(room.roomId)
                      .then((r) => { if (r?.warning) toast(r.warning, { icon: '⚠️' }); })
                      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                  }}
                >
                  <Icon name="mic" size={16} /> {t('rooms.onboard.voice')}
                </button>
              )}
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="room-files-empty">{t('rooms.fileSearchEmpty')}</div>
        ) : (
          <div className="room-files">{renderFolderFiles(visibleFiles)}</div>
        )
      ) : grouped.length === 0 ? (
        <div className="room-files-empty">{t('rooms.fileSearchEmpty')}</div>
      ) : (
        <div className="room-folder-list">
          {grouped.map((sec) => {
            const key = sec.section?.id ?? 'uncategorized';
            const total = sec.files.length + sec.children.reduce((s, c) => s + c.files.length, 0);
            // A live search force-expands so matches are never hidden.
            const isCollapsed = !fileQuery.trim() && collapsed.has(key);
            const childCount = sec.section ? folders.filter((f) => f.parentId === sec.section!.id).length : 0;
            return (
              <div key={key} className={`room-folder-section${dragOverKey === key ? ' dragover' : ''}`} {...sectionDropProps(sec.section?.id ?? null, key)}>
                {renderFolderHeader(sec.section, total, isCollapsed, key, { canNest: !!sec.section, childCount })}
                {isCollapsed ? null : (
                  <>
                    {sec.section && newSubfolderFor === sec.section.id && (
                      <div className="room-subfolder">
                        <RoomFolderEditor
                          onSubmit={(name, icon, color) => { setNewSubfolderFor(null); onCreateFolder(name, icon, color, sec.section!.id); }}
                          onCancel={() => setNewSubfolderFor(null)}
                        />
                      </div>
                    )}
                    {sec.children.map((c) => {
                      const cKey = c.folder!.id;
                      const cCollapsed = !fileQuery.trim() && collapsed.has(cKey);
                      return (
                        <div key={cKey} className={`room-subfolder${dragOverKey === cKey ? ' dragover' : ''}`} {...sectionDropProps(cKey, cKey)}>
                          {renderFolderHeader(c.folder, c.files.length, cCollapsed, cKey, { canNest: false, childCount: 0 })}
                          {cCollapsed ? null : c.files.length > 0 ? (
                            <div className="room-files">{renderFolderFiles(c.files)}</div>
                          ) : editFolderId === cKey ? null : (
                            <div className="room-folder-empty">{t('rooms.folder.empty')}</div>
                          )}
                        </div>
                      );
                    })}
                    {sec.files.length > 0 ? (
                      <div className="room-files">{renderFolderFiles(sec.files)}</div>
                    ) : sec.children.length === 0 && newSubfolderFor !== sec.section?.id && editFolderId !== sec.section?.id ? (
                      <div className="room-folder-empty">{t('rooms.folder.empty')}</div>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      </div>

      <div className="room-files-actions">
        <Button
          variant="ghost"
          size="sm"
          className="room-add-files"
          disabled={busy}
          onClick={() => setPickTransfer(true)}
          icon={<Icon name="download" size={14} />}
        >
          {t('rooms.fromTransfers')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="room-add-files"
          onClick={() => onAddFiles()}
          loading={busy}
          icon={<Icon name="file-plus" size={14} />}
        >
          {t('rooms.addFiles')}
        </Button>

      </div>

      {pickTransfer && (
        <TransferPickerModal
          roomId={room.roomId}
          onClose={() => setPickTransfer(false)}
          onShared={onShared}
        />
      )}
    </div>
  );
};

// ── People rail (left region: voice on top, members below) ────────────────
const RoomPeopleRail: React.FC<{ room: RoomState; onWatchShare: (memberId: string) => void }> = ({ room, onWatchShare }) => {
  const { t } = useTranslation();
  const online = room.members.filter((m) => m.online);
  return (
    <div className="room-col-rail">
      <RoomVoicePanel room={room} onWatchShare={onWatchShare} />
      <div className="room-rail-people">
        <div className="room-rail-people-head">
          <span className="room-section-title">{t('rooms.people')}</span>
          <span className="room-chat-online">{online.length}/{room.members.length}</span>
        </div>
        <div className="room-rail-people-list">
          <RoomMembersList room={room} />
        </div>
      </div>
    </div>
  );
};

// ── Stage (center region: files by default; inline watch / screen viewer) ──
interface StageProps {
  room: RoomState;
  stageView: StageView;
  onCloseStage: () => void;
  onWatch: (file: RoomFile) => void;
  onWatchJoin: (file: RoomFile) => void;
  watchCounts: Record<string, number>;
  onInvite: () => void;
  onAddFiles: (folderId?: string) => void;
  onDropFiles: (paths: string[], folderId?: string) => void;
  onCreateFolder: (name: string, icon: string, color: string, parentId?: string) => void;
  onUpdateFolder: (folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }) => void;
  onDeleteFolder: (folderId: string) => void;
  onAssignFile: (fileId: string, folderId: string | null) => void;
  onShared: (state: RoomState) => void;
  onToggleAutoFetch: (autoFetch: boolean) => void;
  busy: boolean;
}
const RoomStage: React.FC<StageProps> = ({ room, stageView, onCloseStage, onWatch, onWatchJoin, watchCounts, onInvite, onAddFiles, onDropFiles, onCreateFolder, onUpdateFolder, onDeleteFolder, onAssignFile, onShared, onToggleAutoFetch, busy }) => {
  const { t } = useTranslation();
  const self = room.members.find((m) => m.isSelf) || { memberId: 'self', name: t('rooms.you'), avatarSeed: 'self' };
  const shareName = stageView.kind === 'screen'
    ? (() => { const m = room.members.find((mm) => mm.memberId === stageView.memberId); return m?.isSelf ? t('rooms.you') : (m?.name || '?'); })()
    : '';
  const tabs = [{ id: 'files', label: t('rooms.stage.files'), icon: <Icon name="folder-open" size={13} /> }];
  if (stageView.kind === 'watch') tabs.push({ id: 'watch', label: stageView.file.name, icon: <Icon name="film" size={13} /> });
  if (stageView.kind === 'screen') tabs.push({ id: 'screen', label: shareName, icon: <Icon name="screen-share" size={13} /> });
  return (
    <div className="room-col-stage">
      {tabs.length > 1 && (
        <Tabs tabs={tabs} activeTab={stageView.kind} onTabChange={(id) => { if (id === 'files') onCloseStage(); }} />
      )}
      {/* Conditional render (never display:none) so the player/viewer unmounts on
          tab switch and fires its presence leave / watchStop cleanup. */}
      {stageView.kind === 'watch' ? (
        <RoomPlayer room={room} roomId={room.roomId} file={stageView.file} self={self} initialTogether={stageView.together === true} onClose={onCloseStage} />
      ) : stageView.kind === 'screen' ? (
        <ScreenView roomId={room.roomId} memberId={stageView.memberId} title={shareName} onClose={onCloseStage} />
      ) : (
        <RoomFilesPanel
          room={room} onWatch={onWatch} onWatchJoin={onWatchJoin} watchCounts={watchCounts} onInvite={onInvite}
          onAddFiles={onAddFiles} onDropFiles={onDropFiles} onCreateFolder={onCreateFolder}
          onUpdateFolder={onUpdateFolder} onDeleteFolder={onDeleteFolder} onAssignFile={onAssignFile}
          onShared={onShared} onToggleAutoFetch={onToggleAutoFetch} busy={busy}
        />
      )}
    </div>
  );
};

// ── Room detail panel ─────────────────────────────────────────────────────
interface DetailProps {
  room: RoomState;
  /** The VPN kill-switch has this room's networking paused (from the summary). */
  suspended?: boolean;
  /** OS notifications silenced for this room (from the summary). */
  notifyMuted?: boolean;
  onToggleNotifyMuted?: (muted: boolean) => void;
  /** Open the OS file picker; folderId assigns the added files to that section. */
  onAddFiles: (folderId?: string) => void;
  /** Files were dropped onto the room — absolute paths, already resolved. */
  onDropFiles: (paths: string[], folderId?: string) => void;
  onCreateFolder: (name: string, icon: string, color: string, parentId?: string) => void;
  onUpdateFolder: (folderId: string, patch: { name?: string; icon?: string; color?: string; parentId?: string | null }) => void;
  onDeleteFolder: (folderId: string) => void;
  onAssignFile: (fileId: string, folderId: string | null) => void;
  onOpenFolder: () => void;
  onInvite: () => void;
  onLeave: () => void;
  onCopyCode: () => void;
  /** A transfer was shared into this room — apply the returned state. */
  onShared: (state: RoomState) => void;
  /** Flip the room's auto-download preference. */
  onToggleAutoFetch: (autoFetch: boolean) => void;
  /** Set the room's speed ceilings (KB/s, 0 = unlimited). */
  onSetLimits: (upKbps: number, downKbps: number) => void;
  busy: boolean;
}

const RoomDetail: React.FC<DetailProps> = ({ room, suspended, notifyMuted, onToggleNotifyMuted, onAddFiles, onDropFiles, onCreateFolder, onUpdateFolder, onDeleteFolder, onAssignFile, onOpenFolder, onInvite, onLeave, onCopyCode, onShared, onToggleAutoFetch, onSetLimits, busy }) => {
  const { t } = useTranslation();
  // Drag & drop files into the room. The depth counter survives child
  // enter/leave churn; internalDrag suppresses drags that started on this page
  // (text selections etc.) so only OS file drags light the overlay. The OS drop
  // target is the whole container, so this stays here (not in the files panel).
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const internalDrag = useRef(false);
  const isFileDrag = (e: React.DragEvent) =>
    !internalDrag.current && !room.kicked && Array.from(e.dataTransfer?.types || []).includes('Files');
  const handleDrop = (e: React.DragEvent) => {
    internalDrag.current = false;
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => { try { return window.api.getPathForFile(f); } catch { return ''; } })
      .filter(Boolean);
    if (paths.length === 0) { toast.error(t('create.dropReadError')); return; }
    onDropFiles(paths);
  };
  // Owner-only inline room rename (the engine gates + signs + gossips it).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(room.name);
  useEffect(() => { setRenaming(false); setNameDraft(room.name); }, [room.roomId, room.name]);
  // Owner-only topic, same signed/LWW discipline; '' clears it.
  const [topicEditing, setTopicEditing] = useState(false);
  const [topicDraft, setTopicDraft] = useState(room.topic || '');
  useEffect(() => { setTopicEditing(false); setTopicDraft(room.topic || ''); }, [room.roomId, room.topic]);
  const submitTopic = () => {
    setTopicEditing(false);
    const text = topicDraft.trim();
    if (text === (room.topic || '')) return;
    window.api.rooms.setTopic(room.roomId, text).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  const submitRename = () => {
    const n = nameDraft.trim();
    setRenaming(false);
    if (n && n !== room.name) window.api.rooms.rename(room.roomId, n).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  // The Stage shows Files by default and swaps to the inline watch player or
  // screen viewer. Single-slot: opening one supersedes the other. Both the file-row
  // Watch and the voice LIVE-badge feed this.
  const [stageView, setStageView] = useState<StageView>({ kind: 'files' });
  // Reset to Files SYNCHRONOUSLY when the open room changes (adjust-state-during-
  // render, not a post-commit effect) — otherwise RoomStage would render the player/
  // viewer for one frame against the NEW room but the PREVIOUS room's file/memberId
  // (a cross-room presence broadcast / bad watchFile).
  const [stageRoomId, setStageRoomId] = useState(room.roomId);
  if (stageRoomId !== room.roomId) {
    setStageRoomId(room.roomId);
    setStageView({ kind: 'files' });
  }
  // Close the inline screen viewer when its sharer stops or we leave voice
  // (lifted from the voice panel so the Stage owns the view).
  useEffect(() => {
    if (stageView.kind !== 'screen') return;
    const v = room.voice;
    const still = v.inVoice && !!v.participants.find((p) => p.memberId === stageView.memberId)?.sharing;
    if (!still) setStageView({ kind: 'files' });
  }, [stageView, room.voice]);

  // Live watch-session presence per file — fed by the same sync gossip the
  // player uses (join/beat/track add a watcher, leave removes, TTL prunes) so
  // the file rows can show a "N watching · join" badge without a player open.
  const [watchersByFile, setWatchersByFile] = useState<Record<string, Record<string, number>>>({});
  useEffect(() => { setWatchersByFile({}); }, [room.roomId]);
  useEffect(() => {
    const off = window.api.onRoomSync((msg) => {
      if (msg.roomId !== room.roomId || !msg.fileId || !msg.memberId) return;
      if (msg.action === 'leave') {
        setWatchersByFile((w) => {
          const cur = w[msg.fileId];
          if (!cur || !(msg.memberId in cur)) return w;
          const nextFile = { ...cur };
          delete nextFile[msg.memberId];
          const next = { ...w };
          if (Object.keys(nextFile).length) next[msg.fileId] = nextFile; else delete next[msg.fileId];
          return next;
        });
      } else if (msg.action === 'join' || msg.action === 'beat' || msg.action === 'track') {
        setWatchersByFile((w) => ({ ...w, [msg.fileId]: { ...w[msg.fileId], [msg.memberId]: Date.now() } }));
      }
    });
    const prune = setInterval(() => {
      setWatchersByFile((w) => {
        const now = Date.now();
        let changed = false;
        const next: typeof w = {};
        for (const [fid, members] of Object.entries(w)) {
          const kept: Record<string, number> = {};
          for (const [mid, at] of Object.entries(members)) {
            if (now - at < 16_000) kept[mid] = at; else changed = true;
          }
          if (Object.keys(kept).length) next[fid] = kept; else changed = true;
        }
        return changed ? next : w;
      });
    }, 5000);
    return () => { off(); clearInterval(prune); };
  }, [room.roomId]);
  const watchCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [fid, members] of Object.entries(watchersByFile)) {
      const n = Object.keys(members).length;
      if (n > 0) m[fid] = n;
    }
    return m;
  }, [watchersByFile]);

  // Room-settings popover (auto-download, speed limits, code/rename/leave) —
  // the room's ONE settings point; closes like every floating surface.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsWrapRef = useRef<HTMLDivElement>(null);
  // Closing by outside-click/Escape unmounts a focused limit input WITHOUT a
  // blur event — commit through a ref first, or the typed value is silently
  // lost while the draft keeps showing it on reopen.
  const commitLimitsRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsWrapRef.current && !settingsWrapRef.current.contains(e.target as Node)) {
        commitLimitsRef.current();
        setSettingsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { commitLimitsRef.current(); setSettingsOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [settingsOpen]);
  // Speed-limit drafts: commit on blur/Enter; re-seed only on room switch so
  // live state pushes don't stomp typing. 0/empty = unlimited.
  const [upDraft, setUpDraft] = useState(String(room.upKbps || ''));
  const [downDraft, setDownDraft] = useState(String(room.downKbps || ''));
  useEffect(() => {
    setUpDraft(String(room.upKbps || ''));
    setDownDraft(String(room.downKbps || ''));
    setSettingsOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.roomId]);
  const commitLimits = () => {
    const up = Math.max(0, Math.floor(Number(upDraft) || 0));
    const down = Math.max(0, Math.floor(Number(downDraft) || 0));
    if (up !== room.upKbps || down !== room.downKbps) onSetLimits(up, down);
  };
  commitLimitsRef.current = commitLimits;

  // Draggable three-region widths (persisted). The Stage (center) flexes; the rail
  // and chat are set via CSS vars so the narrow-mode @container rule (which sets the
  // grid-template-columns PROPERTY) still wins and stacks the columns.
  const [layout, setLayout] = useState(loadRoomLayout);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const dragRef = useRef<null | { edge: 'rail' | 'chat'; startX: number; startW: number }>(null);
  const onSplitDown = (edge: 'rail' | 'chat') => (e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = { edge, startX: e.clientX, startW: edge === 'rail' ? layout.railW : layout.chatW };
  };
  const onSplitMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (d.edge === 'rail') {
      const w = Math.max(RAIL_MIN, Math.min(RAIL_MAX, d.startW + dx));
      setLayout((l) => ({ ...l, railW: w }));
    } else {
      const w = Math.max(CHAT_MIN, Math.min(CHAT_MAX, d.startW - dx)); // chat grows dragging left
      setLayout((l) => ({ ...l, chatW: w }));
    }
  };
  const onSplitUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setLayout((l) => { saveRoomLayout(l); return l; });
  };

  // Connection indicator: removed → connecting → online (peers) → alone (no peers).
  // The label talks about STATE only; the transport peer count (wires, not
  // people) moved into the tooltip so it can't be misread as a member count.
  const connState = room.kicked ? 'removed' : suspended ? 'suspended' : !room.connected ? 'connecting' : room.peerCount > 0 ? 'online' : 'alone';
  const connLabel = room.kicked
    ? t('rooms.removed')
    : suspended
      ? t('rooms.suspendedBadge')
      : !room.connected
        ? t('rooms.connecting')
        : room.peerCount > 0
          ? t('rooms.connected')
          : t('rooms.alone');
  const onlineCount = room.members.filter((m) => m.online).length;
  return (
    <div
      className="room-detail-inner"
      onDragStartCapture={() => { internalDrag.current = true; }}
      onDragEndCapture={() => { internalDrag.current = false; }}
      // Capture-phase reset: a section's own drop handler stops the bubble
      // (so the room-level add can't double-fire), which would strand the
      // overlay open — capture runs regardless and clears it.
      onDropCapture={() => { dragDepth.current = 0; setDropping(false); }}
      onDragEnter={(e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth.current += 1; setDropping(true); }}
      onDragOver={(e) => { if (!isFileDrag(e)) return; e.preventDefault(); }}
      onDragLeave={(e) => { if (!isFileDrag(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDropping(false); }}
      onDrop={handleDrop}
    >
      {/* A slim banner, not a full-cover sheet — the section drop targets
          underneath must stay visible and highlightable during an OS drag. */}
      {dropping && (
        <div className="room-drop-overlay" aria-hidden="true">
          <Icon name="file-plus" size={16} />
          <span>{t('rooms.dropHint')}</span>
        </div>
      )}
      {/* Title bar */}
      <div className="room-detail-head">
        <div className="room-detail-title">
          {renaming ? (
            <input
              className="room-rename-input" autoFocus value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') { setRenaming(false); setNameDraft(room.name); } }}
            />
          ) : (
            <h2 className={room.canManage ? 'renamable' : ''} onDoubleClick={room.canManage ? () => setRenaming(true) : undefined} title={room.canManage ? t('rooms.rename') : undefined}>
              {room.name}
              {room.canManage && (
                <button type="button" className="room-rename-btn" onClick={() => setRenaming(true)} title={t('rooms.rename')} aria-label={t('rooms.rename')}>
                  <Icon name="edit-2" size={13} />
                </button>
              )}
            </h2>
          )}
          {/* Topic line: owner edits inline (dbl-click / the add button). */}
          {topicEditing ? (
            <input
              className="room-topic-input" autoFocus value={topicDraft} maxLength={300}
              placeholder={t('rooms.topicPlaceholder')}
              onChange={(e) => setTopicDraft(e.target.value)}
              onBlur={submitTopic}
              onKeyDown={(e) => { if (e.key === 'Enter') submitTopic(); if (e.key === 'Escape') { setTopicEditing(false); setTopicDraft(room.topic || ''); } }}
            />
          ) : room.topic ? (
            <p
              className={`room-topic${room.canManage ? ' editable' : ''}`}
              // Full text in the tooltip — the line ellipsizes and there is no
              // other surface that shows a long topic whole.
              title={room.canManage ? `${room.topic} — ${t('rooms.topicHint')}` : room.topic}
              onDoubleClick={room.canManage ? () => setTopicEditing(true) : undefined}
            >
              {room.topic}
            </p>
          ) : room.canManage ? (
            <button type="button" className="room-topic-add" onClick={() => setTopicEditing(true)}>
              <Icon name="plus" size={11} /> {t('rooms.topicAdd')}
            </button>
          ) : null}
          <div className="room-detail-badges">
            {room.e2e && (
              <span className="room-e2e-badge" title={t('rooms.e2eHint')}>
                <Icon name="lock" size={12} /> {t('rooms.encrypted')}
              </span>
            )}
            <span
              className={`room-conn ${connState}`}
              title={!room.kicked && !suspended && room.connected ? t('rooms.connPeersHint').replace('{n}', String(room.peerCount)) : undefined}
            >
              <span className="dot" />
              {connLabel}
            </span>
            {/* People at a glance; also the visible way in/out of a collapsed
                rail (the splitter's double-click stays as the shortcut). */}
            <button
              type="button"
              className={`room-people-chip${railCollapsed ? ' collapsed' : ''}`}
              onClick={() => setRailCollapsed((c) => !c)}
              title={t('rooms.peopleChipHint')}
            >
              <Icon name="users" size={12} /> {onlineCount}/{room.members.length}
            </button>
          </div>
        </div>
        <div className="room-detail-actions">
          <Button variant="ghost" size="sm" onClick={onInvite} icon={<Icon name="share-2" size={14} />}>{t('rooms.invite')}</Button>
          <Button variant="ghost" size="sm" onClick={onOpenFolder} icon={<Icon name="folder-open" size={14} />}>{t('rooms.folder')}</Button>
          {/* THE room-settings point: auto-download, speed limits, code,
              rename, leave — secondary + destructive actions live here, not as
              a permanent red button beside the everyday pair. */}
          <div className="room-settings-wrap" ref={settingsWrapRef}>
            <Button
              variant="ghost" size="sm" iconOnly onClick={() => setSettingsOpen((o) => !o)}
              icon={<Icon name="settings" size={14} />}
              aria-label={t('rooms.roomSettings')} title={t('rooms.roomSettings')}
            />
            {settingsOpen && (
              <div className="room-settings-pop">
                <div className="room-settings-row" title={t('rooms.autoFetchHint')}>
                  <span>{t('rooms.autoFetch')}</span>
                  <Toggle size="small" checked={room.autoFetch} onChange={onToggleAutoFetch} ariaLabel={t('rooms.autoFetch')} />
                </div>
                <div className="room-settings-row">
                  <span>{t('rooms.notifyToggle')}</span>
                  <Toggle size="small" checked={!notifyMuted} onChange={(v) => onToggleNotifyMuted?.(!v)} ariaLabel={t('rooms.notifyToggle')} />
                </div>
                <div className="room-settings-row" title={t('rooms.limitsHint')}>
                  <span className="room-settings-limits-label"><Icon name="gauge" size={13} /> {t('rooms.limits')}</span>
                  <span className="room-settings-limits">
                    <label className="room-limit">
                      ↑
                      <input
                        type="number" min={0} placeholder="∞" value={upDraft}
                        onChange={(e) => setUpDraft(e.target.value)}
                        onBlur={commitLimits}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        aria-label={`${t('rooms.limits')} ↑ ${t('rooms.kbps')}`}
                      />
                    </label>
                    <label className="room-limit">
                      ↓
                      <input
                        type="number" min={0} placeholder="∞" value={downDraft}
                        onChange={(e) => setDownDraft(e.target.value)}
                        onBlur={commitLimits}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        aria-label={`${t('rooms.limits')} ↓ ${t('rooms.kbps')}`}
                      />
                    </label>
                    <span className="room-settings-kbps">{t('rooms.kbps')}</span>
                  </span>
                </div>
                <div className="room-settings-sep" />
                <button type="button" className="room-settings-item" onClick={onCopyCode}>
                  <Icon name="copy" size={13} /> {t('rooms.copyCodeAction')}
                </button>
                {room.canManage && (
                  <button type="button" className="room-settings-item" onClick={() => { setSettingsOpen(false); setRenaming(true); }}>
                    <Icon name="edit-2" size={13} /> {t('rooms.rename')}
                  </button>
                )}
                <button type="button" className="room-settings-item danger" onClick={() => { setSettingsOpen(false); onLeave(); }}>
                  <Icon name="x" size={13} /> {t('rooms.leave')}
                </button>
              </div>
            )}
          </div>
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

      {/* VPN kill-switch banner — otherwise the pause reads as a stuck "Connecting…" */}
      {suspended && !room.kicked && (
        <div className="room-suspended-inline">
          <Icon name="shield" size={16} />
          <span>{t('rooms.suspended.body')}</span>
        </div>
      )}

      {/* Three-region layout: People+Voice rail | Stage (files/watch/screen) | Chat.
          Rail/chat widths are draggable (set as CSS vars so the narrow-mode
          @container rule, which sets the grid-template-columns PROPERTY, still wins). */}
      <div
        className={`room-detail-grid${railCollapsed ? ' rail-collapsed' : ''}`}
        style={{ '--rail-w': `${railCollapsed ? 0 : layout.railW}px`, '--chat-w': `${layout.chatW}px` } as React.CSSProperties}
      >
        <RoomPeopleRail room={room} onWatchShare={(id) => setStageView({ kind: 'screen', memberId: id })} />
        <div
          className="room-splitter"
          role="separator" aria-orientation="vertical" title={t('rooms.resize')}
          onPointerDown={onSplitDown('rail')} onPointerMove={onSplitMove} onPointerUp={onSplitUp}
          onDoubleClick={() => setRailCollapsed((c) => !c)}
        />
        <RoomStage
          room={room}
          stageView={stageView}
          onCloseStage={() => setStageView({ kind: 'files' })}
          onWatch={(file) => setStageView({ kind: 'watch', file })}
          onWatchJoin={(file) => setStageView({ kind: 'watch', file, together: true })}
          watchCounts={watchCounts} onInvite={onInvite}
          onAddFiles={onAddFiles} onDropFiles={onDropFiles} onCreateFolder={onCreateFolder} onUpdateFolder={onUpdateFolder}
          onDeleteFolder={onDeleteFolder} onAssignFile={onAssignFile} onShared={onShared}
          onToggleAutoFetch={onToggleAutoFetch} busy={busy}
        />
        <div
          className="room-splitter"
          role="separator" aria-orientation="vertical" title={t('rooms.resize')}
          onPointerDown={onSplitDown('chat')} onPointerMove={onSplitMove} onPointerUp={onSplitUp}
        />
        <RoomChat room={room} onAttachRequest={() => onAddFiles()} />
      </div>
    </div>
  );
};

// ── Members list (rows with mute/kick controls) ───────────────────────────
// Voice preferences live in renderer/utils/voicePrefs.ts (shared with the
// settings modal); the panel below pushes the engine-side subset over IPC.
// A short synthesized join/leave chime so we don't bundle audio assets.
let chimeCtx: AudioContext | null = null;
function playChime(rising: boolean): void {
  try {
    chimeCtx = chimeCtx || new AudioContext();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const ctx = chimeCtx, now = ctx.currentTime;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(rising ? 520 : 660, now);
    osc.frequency.exponentialRampToValueAtTime(rising ? 784 : 440, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.24);
  } catch { /* audio unavailable — no chime */ }
}
const isTypingTarget = (e: KeyboardEvent): boolean => {
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable;
};

// Serverless mesh voice channel: a live roster (glowing ring while talking), self
// mute/deafen/leave, mic-live indicator, input-mode + push-to-talk settings, and
// per-participant volume.
const RoomVoicePanel: React.FC<{ room: RoomState; onWatchShare: (memberId: string) => void }> = ({ room, onWatchShare }) => {
  const { t } = useTranslation();
  const roomId = room.roomId;
  const v = room.voice;
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-peer volume/mute popover (persisted — the engine doesn't echo gains back).
  const [peerFor, setPeerFor] = useState<string | null>(null);
  const [peerPrefs, setPeerPrefs] = useState<Record<string, PeerVoicePref>>(loadPeerVoicePrefs);
  const [prefs, setPrefs] = useState(loadVoicePrefs);
  const [pickerOpen, setPickerOpen] = useState(false);        // screenshare source picker
  const memberOf = (id: string) => room.members.find((m) => m.memberId === id);
  const selfId = room.members.find((m) => m.isSelf)?.memberId;
  const nameOf = (id: string) => (id === selfId ? t('rooms.you') : (memberOf(id)?.name || '?'));
  const seedOf = (id: string) => memberOf(id)?.avatarSeed || id;
  const fail = (e: unknown) => toast.error(String(e instanceof Error ? e.message : e));
  const wrap = (fn: () => Promise<unknown>) => async () => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  useEffect(() => {
    const h = () => setPrefs(loadVoicePrefs());
    window.addEventListener(VOICE_PREFS_EVENT, h);
    return () => window.removeEventListener(VOICE_PREFS_EVENT, h);
  }, []);

  // Change a peer's local volume/mute: persist + apply to the live call.
  const setPeerPref = (memberId: string, patch: Partial<PeerVoicePref>) => {
    const cur = peerPrefs[memberId] || { volume: 100, muted: false };
    const next = { ...cur, ...patch };
    savePeerVoicePref(memberId, next);
    window.api.rooms.voice.volume(roomId, memberId, effectivePeerGain(next)).catch(() => { /* not in voice */ });
    setPeerPrefs((prev) => ({ ...prev, [memberId]: next }));
  };

  // Re-assert the remembered per-peer gains whenever the roster changes (a peer
  // (re)joining starts at the engine's default full volume).
  const rosterKey = v.participants.map((p) => p.memberId).sort().join(',');
  useEffect(() => {
    if (!v.inVoice) return;
    for (const p of v.participants) {
      if (p.memberId === selfId) continue;
      const pref = peerPrefs[p.memberId];
      if (pref && (pref.muted || pref.volume !== 100)) {
        window.api.rooms.voice.volume(roomId, p.memberId, effectivePeerGain(pref)).catch(() => { /* ignore */ });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.inVoice, rosterKey, roomId]);

  // The peer popover closes like every floating surface: outside click.
  useEffect(() => {
    if (!peerFor) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && !el.closest('.room-voice-pop') && !el.closest('.room-voice-ring')) setPeerFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [peerFor]);

  // Surface transient voice warnings from the engine (e.g. a mid-call mic fell back
  // to the system default) as a toast.
  useEffect(() => {
    const off = window.api.onVoiceWarning((msg) => { if (msg) toast(msg, { icon: '⚠️' }); });
    return off;
  }, []);

  // Tell the engine our input mode whenever we're in voice (and when it changes).
  useEffect(() => { if (v.inVoice) window.api.rooms.voice.inputMode(roomId, prefs.inputMode).catch(() => { /* ignore */ }); }, [v.inVoice, prefs.inputMode, roomId]);

  // Push the GLOBAL hardware/processing settings to the engine on mount and on
  // every prefs change (debounced — slider drags fire many events). The manager
  // caches them and re-asserts after an engine respawn.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => {
    const timer = setTimeout(() => {
      window.api.rooms.voice.settings(toVoiceSettings(prefs)).catch(() => { /* engine not up yet — readied() re-asserts */ });
    }, 200);
    return () => clearTimeout(timer);
  }, [prefs]);
  // Flush the latest settings on unmount so a change made within the 200ms debounce
  // right before leaving the room page (which unmounts this panel — the only pusher)
  // still reaches a live call and the manager's respawn cache.
  useEffect(() => () => {
    window.api.rooms.voice.settings(toVoiceSettings(prefsRef.current)).catch(() => { /* ignore */ });
  }, []);

  // Keep the main process's global-PTT config current (it runs the OS key hook
  // only while some room is in voice in PTT mode). Track whether the hook is
  // ACTUALLY usable — if the native module is missing or the key isn't globally
  // expressible, the in-app listener below must stay on or PTT would go dead.
  const [globalPttLive, setGlobalPttLive] = useState(false);
  useEffect(() => {
    let dead = false;
    window.api.rooms.voice.globalPtt(prefs.globalPtt, prefs.pttKey)
      .then((r) => { if (!dead) setGlobalPttLive(prefs.globalPtt && r.available && r.supported); })
      .catch(() => { if (!dead) setGlobalPttLive(false); });
    return () => { dead = true; };
  }, [prefs.globalPtt, prefs.pttKey]);

  // Push-to-talk: hold the key to transmit (window-wide while a room is open).
  // With GLOBAL PTT actually running, the OS hook covers the focused case too —
  // skip this one (its blur-release would drop a held key on every focus change).
  useEffect(() => {
    if (!v.inVoice || prefs.inputMode !== 'ptt' || globalPttLive) return;
    let held = false;
    const set = (a: boolean) => { held = a; window.api.rooms.voice.ptt(roomId, a).catch(() => { /* ignore */ }); };
    const down = (e: KeyboardEvent) => { if (e.code === prefs.pttKey && !held && !e.repeat && !isTypingTarget(e)) set(true); };
    const up = (e: KeyboardEvent) => { if (e.code === prefs.pttKey && held) set(false); };
    const blur = () => { if (held) set(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      if (held) window.api.rooms.voice.ptt(roomId, false).catch(() => { /* ignore */ });
    };
  }, [v.inVoice, prefs.inputMode, prefs.pttKey, globalPttLive, roomId]);

  // Join/leave chimes: rising when someone joins the call, falling when they go.
  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (!v.inVoice) { prevCount.current = null; return; }
    const n = v.participants.length;
    if (prevCount.current !== null && n !== prevCount.current && prefs.chimes) playChime(n > prevCount.current);
    prevCount.current = n;
  }, [v.inVoice, v.participants.length, prefs.chimes]);

  const join = wrap(async () => {
    const res = await window.api.rooms.voice.join(roomId);
    // e.g. the saved mic is unplugged — joined on the default one.
    if (res?.warning) toast(res.warning, { icon: '⚠️' });
  });

  const toggleShare = () => {
    if (v.sharing) window.api.rooms.screen.shareStop(roomId).catch(fail);
    else setPickerOpen(true);
  };
  const pickSource = (sourceId: string) => {
    setPickerOpen(false);
    window.api.rooms.screen.shareStart(roomId, sourceId).catch(fail);
  };

  return (
    <div className="room-voice">
      {/* Header: title left, ghost settings gear right. Actions live on their own
          full-width row below — a 200-360px rail can't fit title + buttons inline. */}
      <div className="room-voice-head">
        <span className="room-voice-title">
          <Icon name="headphones" size={13} /> {t('rooms.voice.title')}
          {v.inVoice && v.transmitting && !v.muted && <span className="room-voice-live" title={t('rooms.voice.live')} />}
        </span>
        <button className={`room-voice-gear${settingsOpen ? ' active' : ''}`} onClick={() => setSettingsOpen((o) => !o)} title={t('rooms.voice.settings')}>
          <Icon name="settings" size={14} />
        </button>
      </div>
      {v.inVoice ? (
        <div className="room-voice-ctl">
          <button className={`room-voice-btn${v.muted ? ' active' : ''}`} onClick={() => window.api.rooms.voice.mute(roomId, !v.muted).catch(fail)} title={v.muted ? t('rooms.voice.unmute') : t('rooms.voice.mute')}>
            <Icon name={v.muted ? 'mic-off' : 'mic'} size={15} />
          </button>
          <button className={`room-voice-btn${v.deafened ? ' active' : ''}`} onClick={() => window.api.rooms.voice.deafen(roomId, !v.deafened).catch(fail)} title={v.deafened ? t('rooms.voice.undeafen') : t('rooms.voice.deafen')}>
            <Icon name={v.deafened ? 'volume-x' : 'headphones'} size={15} />
          </button>
          <button className={`room-voice-btn${v.sharing ? ' active' : ''}`} onClick={toggleShare} title={v.sharing ? t('rooms.screen.stop') : t('rooms.screen.share')}>
            <Icon name="screen-share" size={15} />
          </button>
          <button className="room-voice-btn leave" onClick={wrap(() => window.api.rooms.voice.leave(roomId))} disabled={busy} title={t('rooms.voice.leave')}>
            <Icon name="phone-off" size={15} />
          </button>
        </div>
      ) : (() => {
        // The serverless mesh tops out — say so instead of failing the join.
        const full = v.participants.length >= VOICE_MESH_LIMIT;
        return (
          <button className="room-voice-join" onClick={join} disabled={busy || full} title={full ? t('rooms.voice.full') : undefined}>
            <Icon name="mic" size={14} /> {t('rooms.voice.join')}
          </button>
        );
      })()}

      {settingsOpen && <VoiceSettingsModal onClose={() => setSettingsOpen(false)} />}
      {pickerOpen && <ScreenSourcePicker onClose={() => setPickerOpen(false)} onPick={pickSource} />}

      {v.participants.length > 0 && (
        <div className="room-voice-people">
          {v.participants.map((p) => {
            const self = p.memberId === selfId;
            const live = self && v.transmitting && !v.muted;
            const pref = peerPrefs[p.memberId] || { volume: 100, muted: false };
            return (
              <div key={p.memberId} className={`room-voice-person${p.speaking ? ' speaking' : ''}${p.muted ? ' muted' : ''}${live ? ' live' : ''}`} title={nameOf(p.memberId)}>
                <button
                  className="room-voice-ring"
                  onClick={() => { if (!self) setPeerFor((cur) => (cur === p.memberId ? null : p.memberId)); }}
                  title={self ? nameOf(p.memberId) : t('rooms.voice.volume')}
                >
                  <Avatar seed={seedOf(p.memberId)} img={memberOf(p.memberId)?.avatarImg} size={30} />
                </button>
                <span className="room-voice-pname" style={memberOf(p.memberId)?.color ? { color: memberOf(p.memberId)?.color } : undefined}>{nameOf(p.memberId)}</span>
                {/* One inline glyph row (a bare list would stack vertically in
                    the 52px column tile). Deafen implies mute — show only the
                    deafen glyph then; slash = MY local mute of them. */}
                {(p.muted || p.deafened || (!self && pref.muted)) && (
                  <span className="room-voice-picons">
                    {p.muted && !p.deafened && <Icon name="mic-off" size={12} className="room-voice-pmic" />}
                    {p.deafened && <Icon name="volume-x" size={12} className="room-voice-pmic" />}
                    {!self && pref.muted && <Icon name="slash" size={12} className="room-voice-pmic" />}
                  </span>
                )}
                {p.sharing && (
                  <button
                    className="room-voice-share-badge"
                    onClick={() => onWatchShare(p.memberId)}
                    title={self ? t('rooms.screen.preview') : t('rooms.screen.watch')}
                  >
                    <Icon name="screen-share" size={9} /> {t('rooms.screen.live')}
                  </button>
                )}
              </div>
            );
          })}
          {/* One shared popover UNDER the tile row (full rail width) — an
              in-tile popover would be clipped by the rail's overflow:hidden. */}
          {(() => {
            if (!peerFor) return null;
            const p = v.participants.find((x) => x.memberId === peerFor);
            if (!p || p.memberId === selfId) return null;
            const pref = peerPrefs[p.memberId] || { volume: 100, muted: false };
            return (
              <div className="room-voice-pop">
                <span className="room-voice-pop-name">{nameOf(p.memberId)}</span>
                <button
                  type="button"
                  className={`room-voice-pop-mute${pref.muted ? ' on' : ''}`}
                  onClick={() => setPeerPref(p.memberId, { muted: !pref.muted })}
                >
                  <Icon name={pref.muted ? 'volume-x' : 'headphones'} size={13} />
                  {pref.muted ? t('rooms.voice.peerUnmute') : t('rooms.voice.peerMute')}
                </button>
                <input
                  type="range" min={0} max={100} value={pref.muted ? 0 : pref.volume} className="room-voice-vol"
                  onChange={(e) => setPeerPref(p.memberId, { volume: Number(e.target.value), muted: false })}
                  title={t('rooms.voice.volume')}
                />
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

// Extracted from the old side-column card; now rendered inside the chat
// card's collapsible panel. Markup and handlers are unchanged.
const RoomMembersList: React.FC<{ room: RoomState }> = ({ room }) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  // Click a member → their profile card, anchored to the clicked row.
  const [cardFor, setCardFor] = useState<{ memberId: string; anchor: HTMLElement } | null>(null);
  const cardMember = cardFor ? room.members.find((m) => m.memberId === cardFor.memberId) : undefined;
  useEffect(() => { setCardFor(null); }, [room.roomId]);
  const muteToggle = (m: RoomMember) => async () => {
    if (m.muted) {
      window.api.rooms.setMuted(room.roomId, m.memberId, false).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
    } else if (await confirm({ message: t('rooms.muteConfirm') })) {
      window.api.rooms.setMuted(room.roomId, m.memberId, true).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
    }
  };
  const kick = (m: RoomMember) => async () => {
    // Be honest about the model: the rekey cuts them off going forward, but in
    // an E2E room the content secret is not rotated — what they already
    // downloaded stays readable for them.
    const message = room.e2e ? `${t('rooms.kickConfirm')} ${t('rooms.kickConfirmE2E')}` : t('rooms.kickConfirm');
    if (await confirm({ message, danger: true })) {
      window.api.rooms.kick(room.roomId, m.memberId)
        .then(() => toast.success(t('rooms.kicked')))
        .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
    }
  };
  return (
    <div className="room-members">
      {cardMember && cardFor && (
        <ProfileCard
          member={cardMember}
          totalFiles={room.files.length}
          anchor={cardFor.anchor}
          canManage={room.canManage}
          onClose={() => setCardFor(null)}
          onMuteToggle={muteToggle(cardMember)}
          onKick={kick(cardMember)}
        />
      )}
      {room.members.map((m) => (
        <div key={m.memberId} className={`room-member ${m.online ? '' : 'offline'} ${m.muted ? 'muted' : ''}`} title={m.status ? m.status : m.isSelf ? t('rooms.you') : m.relayed ? t('rooms.relayed') : m.online ? t('rooms.direct') : t('rooms.offline')}>
          <button
            type="button"
            className="room-member-open"
            title={t('rooms.profileCardHint')}
            onClick={(e) => setCardFor((cur) => (cur?.memberId === m.memberId ? null : { memberId: m.memberId, anchor: e.currentTarget }))}
          >
            <Avatar seed={m.avatarSeed} img={m.avatarImg} size={30} online={m.online} ring={m.isSelf} />
          </button>
          <span className="room-member-name" style={m.color ? { color: m.color } : undefined}>
            {m.role === 'owner' && <Icon name="star" size={11} className="room-member-owner" />}
            {m.isSelf ? (m.name && m.name !== 'You' ? m.name : t('rooms.you')) : m.name}
            {m.relayed && <Icon name="network" size={11} className="room-member-relay" />}
          </span>
          <span className="room-member-have" title={m.muted ? undefined : t('rooms.memberHaveHint').replace('{n}', String(m.have.length)).replace('{total}', String(room.files.length))}>
            {m.muted ? t('rooms.muted') : `${m.have.length}/${room.files.length}`}
          </span>
          {!m.isSelf && (
            <button
              className="room-member-mute"
              title={m.muted ? t('rooms.unmute') : t('rooms.mute')}
              onClick={muteToggle(m)}
            >
              <Icon name={m.muted ? 'eye' : 'eye-off'} size={13} />
            </button>
          )}
          {room.canManage && !m.isSelf && m.role !== 'owner' && (
            <button
              className="room-member-kick"
              title={t('rooms.kick')}
              onClick={kick(m)}
            >
              <Icon name="x-circle" size={13} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

// ── Room chat panel ───────────────────────────────────────────────────────
// Pure text chat — the room's persistent right region. People + voice live in the
// left rail (RoomPeopleRail); this card is just log + typing indicator + composer.
// Highlight the current user's name inside a plain-text run (@-less mention).
const renderWithMention = (text: string, selfName?: string): React.ReactNode => {
  if (!selfName || selfName.length < 2) return text;
  const lower = text.toLowerCase();
  const needle = selfName.toLowerCase();
  let hit = lower.indexOf(needle);
  if (hit < 0) return text;
  const parts: React.ReactNode[] = [];
  let i = 0, k = 0;
  while (hit >= 0) {
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<mark key={k++} className="room-chat-mention">{text.slice(hit, hit + needle.length)}</mark>);
    i = hit + needle.length;
    hit = lower.indexOf(needle, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
};

// One chat message body, split into text / fenced-code segments, with a copy
// button for anything multiline (pasted scripts etc.).
const RoomChatBody: React.FC<{ text: string; copyLabel: string; copiedLabel: string; selfName?: string }> = ({ text, copyLabel, copiedLabel, selfName }) => {
  const segments = useMemo(() => parseChatSegments(text), [text]);
  const copy = (e: React.MouseEvent) => {
    // Use the clicked element's OWN realm: in the detached chat window the main
    // document is unfocused and ITS clipboard would reject ('not focused').
    const win = (e.currentTarget as HTMLElement).ownerDocument.defaultView ?? window;
    win.navigator.clipboard.writeText(
      // Copy the CODE when the message is a single fence, else the whole body.
      segments.length === 1 && segments[0].kind === 'code' ? segments[0].text : text,
    ).then(() => toast.success(copiedLabel)).catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
  };
  return (
    <span className="room-chat-bubble">
      {segments.map((s, i) => s.kind === 'code'
        ? <pre key={i} className="room-chat-code">{s.text}</pre>
        : (
          <span key={i} className="room-chat-text">
            {/* http(s)-only linkify; main routes target=_blank to the system
                browser (setWindowOpenHandler), incl. from the detached window. */}
            {splitLinks(s.text).map((r, j) => r.kind === 'link'
              ? <a key={j} className="room-chat-link" href={r.href} target="_blank" rel="noreferrer" title={r.href}>{r.text}</a>
              : <React.Fragment key={j}>{renderWithMention(r.text, selfName)}</React.Fragment>)}
          </span>
        ))}
      {isCopyworthy(text) && (
        <button type="button" className="room-chat-copy" onClick={copy} title={copyLabel}>
          <Icon name="copy" size={12} />
        </button>
      )}
    </span>
  );
};

const RoomChat: React.FC<{ room: RoomState; onAttachRequest?: () => void }> = ({ room, onAttachRequest }) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [zoneTab, setZoneTab] = useState<'chat' | 'history'>('chat');
  // Per-message reaction palette — PORTALED to the chat's document at fixed
  // coords (the log clips overflow, and the chat column can be 260px narrow).
  const [reactFor, setReactFor] = useState<{ msgId: string; x: number; y: number } | null>(null);
  useEffect(() => { setReactFor(null); }, [room.roomId]);
  const toggleChatReact = (msgId: string, emoji: string) => {
    window.api.rooms.reactChat(room.roomId, msgId, emoji)
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };
  // Local chat search: filters the persisted log (no protocol involved).
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatQuery, setChatQuery] = useState('');
  const chatQueryRef = useRef('');
  chatQueryRef.current = chatQuery.trim().toLowerCase();
  useEffect(() => { setSearchOpen(false); setChatQuery(''); }, [room.roomId]);
  // Author avatar click → info-only profile card (actions live in the rail).
  // Reset on room switch AND on detach/reattach — the card's anchor element
  // belongs to the previous document and dies with it.
  const [chatCardFor, setChatCardFor] = useState<{ memberId: string; anchor: HTMLElement } | null>(null);
  const chatCardMember = chatCardFor ? room.members.find((m) => m.memberId === chatCardFor.memberId) : undefined;
  useEffect(() => { setChatCardFor(null); }, [room.roomId]);
  const { popout, openPopout, closePopout } = usePopout('havvn-room-chat', t('rooms.chat'));
  // Detach/reattach and tab switches remount the log DOM — the card's anchor
  // element is gone, so a surviving card would pin to the window corner.
  useEffect(() => { setChatCardFor(null); }, [popout, zoneTab]);
  const selfId = room.members.find((m) => m.isSelf)?.memberId;
  const selfName = room.members.find((m) => m.isSelf)?.name;
  const messages = room.chat || [];
  const listRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  // Pin to the newest message only while the user is already near the bottom —
  // reading older history must not be yanked down by new arrivals (those feed
  // the "N new ↓" pill instead). The log window is capped (slice(-100)), so
  // arrivals are counted by the previous last-id's position, not length delta.
  const atBottomRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const prevLogRef = useRef<{ room: string; lastId: string | null }>({ room: room.roomId, lastId: null });
  const scrollToNewest = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setNewCount(0);
  }, []);
  const onLogScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = nearBottom;
    if (nearBottom) setNewCount(0);
  };
  useEffect(() => {
    const prev = prevLogRef.current;
    const last = messages.length ? messages[messages.length - 1] : null;
    prevLogRef.current = { room: room.roomId, lastId: last?.id ?? null };
    // Room switch FIRST: the reset effect clears the query only on the next
    // commit, and skipping here would eat the one-shot room-change evidence
    // (prevLogRef already advanced) — the new room would keep the old scroll.
    if (prev.room !== room.roomId) { scrollToNewest(); return; } // fresh log
    if (chatQueryRef.current) return; // a filtered view scrolls freely
    if (!last || last.id === prev.lastId) return; // state push without new chat
    const idx = prev.lastId ? messages.findIndex((m) => m.id === prev.lastId) : -1;
    const arrived = idx >= 0 ? messages.length - 1 - idx : messages.length;
    if (atBottomRef.current || last.memberId === selfId) scrollToNewest();
    else setNewCount((c) => c + arrived);
  }, [room.roomId, messages, selfId, scrollToNewest]);
  // Detach/reattach and tab switches REMOUNT the log DOM (fresh node,
  // scrollTop=0) without the messages changing — force a re-pin.
  useEffect(() => { scrollToNewest(); setReactFor(null); }, [zoneTab, popout, scrollToNewest]);

  // The reaction palette closes on outside click — in the CHAT's document
  // (the zone may live in the detached window).
  useEffect(() => {
    if (!reactFor) return;
    const doc = listRef.current?.ownerDocument ?? document;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && !el.closest('.room-chat-react-pop') && !el.closest('.room-chat-react-add')) setReactFor(null);
    };
    doc.addEventListener('mousedown', onDown);
    return () => doc.removeEventListener('mousedown', onDown);
  }, [reactFor]);

  // Auto-grow the composer with its content (bounded by CSS max-height).
  const autosize = () => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(autosize, [text, popout]);

  // Typing liveness. Outbound: at most one ping per 2.5s while composing (the
  // engine rate-limits the broadcast further). Inbound: mirror the engine's
  // typingMemberIds, restarting a 4s local TTL on every state push that still
  // carries ids — the engine drops stale typists itself, so the TTL only has
  // to cover the case where pushes stop arriving entirely.
  const typingSentAtRef = useRef(0);
  const [typingIds, setTypingIds] = useState<string[]>([]);
  useEffect(() => {
    const ids = room.typingMemberIds || [];
    setTypingIds(ids);
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => setTypingIds([]), 4000);
    return () => window.clearTimeout(timer);
  }, [room]);
  const typingNames = typingIds
    .map((id) => room.members.find((m) => m.memberId === id))
    .filter((m): m is RoomMember => !!m && !m.isSelf && !m.muted)
    .map((m) => m.name || '?');
  const pingTyping = (value: string) => {
    if (!value.trim()) return;
    const now = Date.now();
    if (now - typingSentAtRef.current < 2500) return;
    typingSentAtRef.current = now;
    window.api.rooms.typing(room.roomId);
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    try { await window.api.rooms.sendChat(room.roomId, body); }
    catch (e) { toast.error(String(e instanceof Error ? e.message : e)); setText(body); }
    finally { setSending(false); }
  };

  // @mention autocomplete: track a trailing "@word" at the caret; the popup
  // intercepts Enter/Tab/arrows while open (send/indent resume when closed).
  const [mention, setMention] = useState<null | { query: string; start: number; caret: number }>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  useEffect(() => { setMention(null); }, [room.roomId, popout, zoneTab]);
  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const seen = new Set<string>();
    return room.members.filter((m) => {
      if (m.isSelf || !m.name) return false;
      const k = m.name.toLowerCase();
      if (!k.startsWith(mention.query) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 6);
  }, [mention, room.members]);
  // The candidate list recomputes on every room push — a stale index must
  // clamp, not dereference past the end.
  const mentionActiveIdx = Math.min(mentionIdx, Math.max(0, mentionCandidates.length - 1));
  const insertMention = (name: string) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(mention.caret)}`;
    setMention(null);
    if (next.length > 2000) return;
    setText(next);
    const el = composeRef.current;
    if (el) {
      const pos = mention.start + name.length + 2;
      const win = el.ownerDocument.defaultView ?? window;
      win.requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = pos; });
    }
  };
  const trackMention = (value: string, caret: number) => {
    const upto = value.slice(0, caret);
    const mm = /(^|\s)@([\p{L}\p{N}_-]{0,24})$/u.exec(upto);
    setMention(mm ? { query: mm[2].toLowerCase(), start: caret - mm[2].length - 1, caret } : null);
    setMentionIdx(0);
  };

  // Tab inserts an indent at the caret (scripts!) instead of moving focus.
  const onComposeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME: Enter confirms the composition, not send
    if (mention && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionCandidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionCandidates[mentionActiveIdx].name); return; }
      if (e.key === 'Escape') { setMention(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = el;
      const next = text.slice(0, s) + '\t' + text.slice(en);
      if (next.length <= 2000) {
        setText(next);
        // Restore the caret via the textarea's OWN window — the main window's rAF
        // is throttled while it is minimized behind a detached chat.
        const win = el.ownerDocument.defaultView ?? window;
        win.requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; });
      }
    }
  };

  const zone = (
    <div className={`room-section room-chat-section${popout ? ' room-chat-popped' : ''}`}>
      <div className="room-chat-zone-tabs">
        {(['chat', 'history'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`room-zone-tab${zoneTab === tab ? ' active' : ''}`}
            onClick={() => setZoneTab(tab)}
          >
            {tab === 'chat' ? t('rooms.chat') : t('rooms.history')}
          </button>
        ))}
        <button
          type="button"
          className={`room-zone-popout room-zone-search${searchOpen ? ' active' : ''}`}
          title={t('rooms.chatSearch')}
          onClick={() => { setZoneTab('chat'); setSearchOpen((o) => { if (o) setChatQuery(''); return !o; }); }}
        >
          <Icon name="search" size={13} />
        </button>
        <button
          type="button"
          className="room-zone-popout"
          title={popout ? t('rooms.chatPopIn') : t('rooms.chatPopOut')}
          onClick={() => { if (popout) closePopout(); else openPopout(); }}
        >
          <Icon name={popout ? 'minimize' : 'external-link'} size={13} />
        </button>
      </div>
      {zoneTab === 'history' ? (
        <div className="room-chat room-zone-history">
          {room.history.length === 0 ? (
            <div className="room-files-empty">{t('rooms.historyEmpty')}</div>
          ) : (
            <div className="room-history room-history-zone">
              {room.history.slice().reverse().map((ev) => (
                <div key={ev.id} className="room-history-item">
                  <span className="room-history-actor">{ev.actorName}</span>
                  <span className="room-history-text">{eventText(t, ev)}</span>
                  <span className="room-history-time">{shortTime(ev.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
      <div className="room-chat">
        {chatCardMember && chatCardFor && (
          <ProfileCard
            member={chatCardMember}
            totalFiles={room.files.length}
            anchor={chatCardFor.anchor}
            canManage={false}
            onClose={() => setChatCardFor(null)}
          />
        )}
        {searchOpen && (
          <div className="room-chat-search">
            <Icon name="search" size={13} />
            <input
              type="text" autoFocus placeholder={t('rooms.chatSearch')} value={chatQuery}
              onChange={(e) => setChatQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setChatQuery(''); setSearchOpen(false); } }}
            />
          </div>
        )}
        <div className="room-chat-log" ref={listRef} onScroll={onLogScroll}>
          {messages.length === 0 ? (
            <div className="room-files-empty">{t('rooms.chatEmpty')}</div>
          ) : (() => {
            const q = chatQuery.trim().toLowerCase();
            const shown = (q
              ? messages.filter((m) => m.text.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
              : messages
            ).slice(-100);
            if (q && shown.length === 0) return <div className="room-files-empty">{t('rooms.chatSearchEmpty')}</div>;
            return shown.map((m, i) => {
              const mine = m.memberId === selfId;
              // Live member (if still around) carries the rich profile: custom
              // avatar, name color, and the click-through card. The message's
              // own name/seed snapshot is the fallback for departed members.
              const live = room.members.find((mm) => mm.memberId === m.memberId);
              const prev = i > 0 ? shown[i - 1] : null;
              const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
              // Continuation: same author within 5 min on the same day —
              // collapse the avatar/name so bursts read as one block.
              const cont = !!prev && !newDay && prev.memberId === m.memberId && m.at - prev.at < 5 * 60_000;
              return (
                <React.Fragment key={m.id}>
                  {newDay && (
                    <div className="room-chat-day" aria-hidden="true"><span>{dayLabel(m.at, t)}</span></div>
                  )}
                  <div className={`room-chat-msg ${mine ? 'mine' : ''}${cont ? ' cont' : ''}`}>
                    {!mine && (cont ? (
                      <span className="room-chat-gutter" aria-hidden="true" />
                    ) : live ? (
                      <button
                        type="button"
                        className="room-member-open"
                        title={t('rooms.profileCardHint')}
                        onClick={(e) => setChatCardFor((cur) => (cur?.memberId === m.memberId ? null : { memberId: m.memberId, anchor: e.currentTarget }))}
                      >
                        <Avatar seed={live.avatarSeed} img={live.avatarImg} size={28} />
                      </button>
                    ) : (
                      <Identicon seed={m.avatarSeed} size={28} />
                    ))}
                    <div className="room-chat-bubble-wrap">
                      {!mine && !cont && <span className="room-chat-author" style={live?.color ? { color: live.color } : undefined}>{live?.name || m.name || '?'}</span>}
                      {m.text.startsWith('🙋') ? (
                        // A file request (the 🙋 prefix rides the plain chat
                        // pipeline) — render as a card with an attach shortcut.
                        <span className="room-chat-request">
                          <span className="room-chat-request-head"><Icon name="file-question" size={12} /> {t('rooms.request.title')}</span>
                          <span className="room-chat-request-text">{m.text.replace(/^🙋\s*/, '')}</span>
                          {!mine && onAttachRequest && (
                            <button type="button" className="room-chat-request-attach" onClick={onAttachRequest}>
                              <Icon name="file-plus" size={12} /> {t('rooms.request.attach')}
                            </button>
                          )}
                        </span>
                      ) : (
                        <RoomChatBody text={m.text} copyLabel={t('rooms.chatCopy')} copiedLabel={t('rooms.chatCopied')} selfName={mine ? undefined : selfName} />
                      )}
                      {/* Reaction pills — the row exists only when reactions do
                          (an always-present row would pad EVERY message). */}
                      {(() => {
                        const reacts = room.chatReacts?.[m.id];
                        const present = CHAT_REACT_EMOJIS.filter((e) => (reacts?.[e] || []).length > 0);
                        if (!present.length) return null;
                        return (
                          <span className="room-chat-reacts">
                            {present.map((emoji) => {
                              const ids = reacts?.[emoji] || [];
                              const own = !!selfId && ids.includes(selfId);
                              return (
                                <button
                                  key={emoji}
                                  type="button"
                                  className={`room-chat-react${own ? ' mine' : ''}`}
                                  aria-pressed={own}
                                  title={ids.map((id) => room.members.find((mm) => mm.memberId === id)?.name || '?').join(', ')}
                                  onClick={() => toggleChatReact(m.id, emoji)}
                                >
                                  {emoji}<span className="room-chat-react-n">{ids.length}</span>
                                </button>
                              );
                            })}
                          </span>
                        );
                      })()}
                      <span className="room-chat-time">{timeOnly(m.at)}</span>
                    </div>
                    {/* Hover "+": absolutely positioned — costs no layout height. */}
                    <button
                      type="button"
                      className="room-chat-react-add"
                      title={t('rooms.chatReact')}
                      onClick={(e) => {
                        const btn = e.currentTarget as HTMLElement;
                        const win = btn.ownerDocument.defaultView ?? window;
                        const r = btn.getBoundingClientRect();
                        setReactFor((cur) => {
                          if (cur?.msgId === m.id) return null;
                          const w = 8 * 26 + 12; // palette width approximation
                          const x = Math.max(4, Math.min(r.left, win.innerWidth - w - 4));
                          const y = r.top - 38 < 4 ? r.bottom + 4 : r.top - 38;
                          return { msgId: m.id, x, y };
                        });
                      }}
                    >
                      <Icon name="plus" size={10} />
                    </button>
                  </div>
                </React.Fragment>
              );
            });
          })()}
          {newCount > 0 && !chatQuery.trim() && (
            <button type="button" className="room-chat-newpill" onClick={scrollToNewest}>
              <Icon name="arrow-down" size={12} /> {t('rooms.newMsgs').replace('{n}', String(newCount))}
            </button>
          )}
        </div>
        {reactFor && createPortal(
          <span className="room-chat-react-pop" style={{ position: 'fixed', left: reactFor.x, top: reactFor.y }}>
            {CHAT_REACT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="room-chat-react-opt"
                // mousedown-preventDefault: keep composer focus intact.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { const id = reactFor.msgId; setReactFor(null); toggleChatReact(id, emoji); }}
              >
                {emoji}
              </button>
            ))}
          </span>,
          (listRef.current?.ownerDocument ?? document).body,
        )}
        <div className={`room-chat-typing${typingNames.length > 0 ? ' on' : ''}`} aria-live="polite">
          {typingNames.length > 0 && (
            <>
              <span className="room-chat-typing-text">
                {typingNames.length === 1
                  ? `${typingNames[0]} ${t('rooms.typingOne')}`
                  : `${typingNames[0]} ${t('rooms.typingAnd')} ${typingNames.length - 1} ${t('rooms.typingMany')}`}
              </span>
              <span className="room-chat-typing-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
            </>
          )}
          {/* Near-limit counter only — silence until 1800 keeps the row calm.
              aria-hidden: this sits inside the typing row's polite live region,
              and a per-keystroke announcement would bury the screen reader. */}
          {text.length >= 1800 && (
            <span className={`room-chat-count${text.length >= 1950 ? ' warn' : ''}`} aria-hidden="true">{text.length}/2000</span>
          )}
        </div>
        <div className="room-chat-compose">
          {mention && mentionCandidates.length > 0 && (
            <div className="room-chat-mention-pop">
              {mentionCandidates.map((m, i) => (
                <button
                  key={m.memberId}
                  type="button"
                  className={`room-chat-mention-item${i === mentionActiveIdx ? ' active' : ''}`}
                  // mousedown, not click — a click would blur the textarea first.
                  onMouseDown={(e) => { e.preventDefault(); insertMention(m.name); }}
                >
                  <Identicon seed={m.avatarSeed} size={18} />
                  <span style={m.color ? { color: m.color } : undefined}>{m.name}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={composeRef}
            className="rooms-input room-chat-input"
            placeholder={t('rooms.chatPlaceholder')}
            value={text}
            maxLength={2000}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              pingTyping(e.target.value);
              trackMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onComposeKeyDown}
          />
          <Button variant="primary" size="sm" onClick={send} loading={sending} disabled={!text.trim()} icon={<Icon name="send" size={14} />}>
            {t('rooms.chatSend')}
          </Button>
        </div>
      </div>
      )}
    </div>
  );

  // Detached: the whole zone (tabs + log + composer) portals into the pop-out
  // window; the docked column shows a slim placeholder with a restore action.
  // Same React tree either way — chat state and subscriptions are unaffected.
  if (popout && !popout.closed) {
    return (
      <>
        <div className="room-section room-chat-section room-chat-placeholder">
          <div className="room-section-title">{t('rooms.chat')}</div>
          <div className="room-chat-placeholder-body">
            <Icon name="external-link" size={18} />
            <span>{t('rooms.chatDetached')}</span>
            <Button variant="ghost" size="sm" onClick={closePopout}>{t('rooms.chatPopIn')}</Button>
          </div>
        </div>
        {createPortal(zone, popout.document.body)}
      </>
    );
  }
  return zone;
};

// Highlight the search match inside a file name (case-insensitive, first hit).
const highlightName = (name: string, query: string): React.ReactNode => {
  const q = query.trim().toLowerCase();
  if (!q) return name;
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark className="room-file-mark">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </>
  );
};

const RoomFileRow: React.FC<{ file: RoomFile; room: RoomState; onWatch: (file: RoomFile) => void; onWatchJoin?: (file: RoomFile) => void; watchCount?: number; onAssignFile: (fileId: string, folderId: string | null) => void; selecting?: boolean; selected?: boolean; onToggleSelect?: (fileId: string) => void; getDragIds?: (fileId: string) => string[]; viewPrefs?: RoomFilesPrefs; highlightQuery?: string }> = ({ file, room, onWatch, onWatchJoin, watchCount = 0, onAssignFile, selecting = false, selected = false, onToggleSelect, getDragIds, viewPrefs, highlightQuery }) => {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const folders = room.folders ?? [];
  const tr = room.transfers[file.fileId];
  const owner = room.members.find((m) => m.memberId === file.addedBy);
  const haveCount = membersWithFile(room, file.fileId);
  const downloading = tr && tr.status === 'downloading';
  const haveLocally = tr?.haveLocally;
  const canWatch = haveLocally && isPlayable(file.name);
  // Manual mode: the file is listed but nothing has fetched it yet.
  const awaitingFetch = !room.autoFetch && !haveLocally && !downloading;

  // Reactions: fileId → emoji → memberIds from the engine; a click toggles ours.
  const selfId = room.members.find((m) => m.isSelf)?.memberId;
  const reacts = room.fileReacts?.[file.fileId];
  const toggleReact = (emoji: string) => {
    window.api.rooms.reactFile(room.roomId, file.fileId, emoji)
      .catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
  };

  // Who (besides us) holds the file complete, and who is mid-download (1-99%).
  const holders = room.members.filter((m) => !m.isSelf && m.have.includes(file.fileId));
  const fetching = room.members
    .map((m) => ({ m, pct: Math.round(room.memberProg?.[m.memberId]?.[file.fileId] ?? 0) }))
    .filter(({ m, pct }) => !m.isSelf && !m.have.includes(file.fileId) && pct >= 1 && pct <= 99);
  const holdersShown = holders.slice(0, 4);
  const holdersExtra = holders.length - holdersShown.length;
  const holderNames = holders.map((m) => m.name || '?').join(', ');

  return (
    <div
      className={`room-file ${selecting ? 'selecting' : ''} ${selected ? 'selected' : ''}`}
      draggable={folders.length > 0}
      onDragStart={(e) => {
        // A selected row drags the whole selection ('\n'-joined ids).
        const ids = getDragIds?.(file.fileId) ?? [file.fileId];
        e.dataTransfer.setData(FILE_DND_TYPE, ids.join('\n'));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={selecting ? () => onToggleSelect?.(file.fileId) : undefined}
      // Double-click does the row's most useful thing: watch when playable,
      // open when merely local, fetch when it hasn't been pulled yet.
      onDoubleClick={selecting ? undefined : (e) => {
        // dblclick bubbles from the row's inner controls too (their handlers
        // only stop CLICK propagation) — two fast clicks on a reaction or a
        // hover action must not also open/watch the file.
        if ((e.target as HTMLElement).closest('button, input, a')) return;
        if (canWatch) onWatch(file);
        else if (haveLocally) window.api.rooms.openFile(room.roomId, file.fileId);
        else if (awaitingFetch) window.api.rooms.fetchFile(room.roomId, file.fileId).catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
      }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {selecting && (
        <input
          type="checkbox" className="room-file-check" checked={selected} readOnly
          aria-label={file.name}
        />
      )}
      <div className="room-file-owner" title={`${t('rooms.addedBy')}: ${owner?.name || file.addedByName}`}>
        <Identicon seed={owner?.avatarSeed || file.addedBy} size={30} />
      </div>
      <div className="room-file-main">
        <div className="room-file-name" title={file.name}>
          {viewPrefs?.typeIcons !== false && (() => {
            const kind = classifyMediaKind(file.name);
            const archive = /\.(zip|7z|rar|tar|gz)$/i.test(file.name);
            const icon: IconName = kind === 'video' ? 'film' : kind === 'audio' ? 'music' : archive ? 'archive' : 'file';
            return <Icon name={icon} size={13} className={`room-file-kind kind-${kind}`} />;
          })()}
          {highlightQuery ? highlightName(file.name, highlightQuery) : file.name}
        </div>
        <div className="room-file-sub">
          <span>{formatBytes(file.size)}</span>
          <span className="room-file-dot">·</span>
          <span className="room-file-have">
            <Icon name="users" size={12} /> {haveCount}/{room.members.length}
          </span>
          {/* Live watch session on this file. Joining needs the file locally —
              without it the click fetches (manual mode) or stays an indicator. */}
          {watchCount > 0 && isPlayable(file.name) && (
            <button
              type="button"
              className={`room-file-watching${canWatch || awaitingFetch ? '' : ' passive'}`}
              title={(canWatch
                ? t('rooms.watchingBadge')
                : awaitingFetch ? t('rooms.watchingBadgeFetch') : t('rooms.watchingBadgeN')
              ).replace('{n}', String(watchCount))}
              onClick={(e) => {
                e.stopPropagation();
                if (canWatch) (onWatchJoin ?? onWatch)(file);
                else if (awaitingFetch) window.api.rooms.fetchFile(room.roomId, file.fileId).catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
              }}
            >
              <Icon name="play" size={10} /> {watchCount}
            </button>
          )}
          {(holdersShown.length > 0 || fetching.length > 0) && (
            <span className="room-file-peers">
              {holdersShown.length > 0 && (
                <span className="room-file-peers-group" title={`${t('rooms.haveBy')} ${holderNames}`}>
                  {holdersShown.map((m) => (
                    <span key={m.memberId} className="room-file-peer">
                      <Identicon seed={m.avatarSeed} size={16} />
                    </span>
                  ))}
                  {holdersExtra > 0 && <span className="room-file-peer room-file-peer-more">+{holdersExtra}</span>}
                </span>
              )}
              {fetching.map(({ m, pct }) => (
                <span
                  key={m.memberId}
                  className="room-file-peer room-file-peer-prog"
                  style={{ background: `conic-gradient(var(--color-accent-primary) ${pct}%, var(--color-border-default) 0)` }}
                  title={`${m.name || '?'} · ${pct}%`}
                >
                  <Identicon seed={m.avatarSeed} size={12} />
                </span>
              ))}
            </span>
          )}
          {downloading && (
            <>
              <span className="room-file-dot">·</span>
              <span className="room-file-speed">{formatSpeed(tr.downSpeed)}</span>
            </>
          )}
          {viewPrefs?.showReactions !== false && (
          <span className="room-file-reacts">
            {FILE_REACT_EMOJIS.map((emoji) => {
              const ids = reacts?.[emoji] || [];
              const mine = !!selfId && ids.includes(selfId);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`room-file-react${ids.length > 0 ? ' active' : ''}${mine ? ' mine' : ''}`}
                  aria-pressed={mine}
                  title={t('rooms.reactToggle')}
                  onClick={() => toggleReact(emoji)}
                >
                  {emoji}
                  {ids.length > 0 && <span className="room-file-react-n">{ids.length}</span>}
                </button>
              );
            })}
          </span>
          )}
        </div>
        {downloading && (
          <div className="room-file-progress">
            <div className="room-file-progress-bar" style={{ width: `${Math.round((tr.progress || 0) * 100)}%` }} />
          </div>
        )}
      </div>
      <span className="room-file-acts">
        {/* stopPropagation everywhere: in select mode the ROW's onClick toggles
            selection — an action click must not also flip the checkbox. */}
        {canWatch && (
          <button className="room-file-act" onClick={(e) => { e.stopPropagation(); onWatch(file); }} title={t('rooms.watchHint')}>
            <Icon name="play" size={14} />
          </button>
        )}
        {haveLocally && (
          <button className="room-file-act" onClick={(e) => { e.stopPropagation(); window.api.rooms.openFile(room.roomId, file.fileId); }} title={t('rooms.openFileHint')}>
            <Icon name="external-link" size={14} />
          </button>
        )}
        {awaitingFetch && (
          <button
            className="room-file-act room-file-act-fetch"
            onClick={(e) => {
              e.stopPropagation();
              window.api.rooms.fetchFile(room.roomId, file.fileId)
                .catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
            }}
            title={t('rooms.fetchHint')}
          >
            <Icon name="download" size={14} />
          </button>
        )}
        <button
          className="room-file-act"
          title={t('rooms.fileMenu')}
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          <Icon name="more-horizontal" size={14} />
        </button>
      </span>
      {menu && createPortal(
        // The wrapper stops clicks reaching the row's select-toggle through the
        // React tree (portals propagate events by COMPONENT hierarchy, not DOM).
        <div onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(canWatch ? [{ label: t('rooms.watch'), icon: 'play' as IconName, onClick: () => onWatch(file) }] : []),
            ...(haveLocally ? [{ label: t('rooms.openFile'), icon: 'external-link' as IconName, onClick: () => { window.api.rooms.openFile(room.roomId, file.fileId); } }] : []),
            ...(haveLocally ? [{ label: t('rooms.revealFile'), icon: 'folder' as IconName, onClick: () => { window.api.rooms.revealFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e))); } }] : []),
            ...(haveLocally && !tr?.released ? [{ label: t('rooms.stopSeeding'), icon: 'pause' as IconName, onClick: () => { window.api.rooms.releaseFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e))); } }] : []),
            ...(haveLocally && tr?.released ? [{ label: t('rooms.seedAgain'), icon: 'upload' as IconName, onClick: () => { window.api.rooms.reseedFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e))); } }] : []),
            ...(awaitingFetch ? [{ label: t('rooms.fetch'), icon: 'download' as IconName, onClick: () => { window.api.rooms.fetchFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e))); } }] : []),
            { label: t('rooms.copyName'), icon: 'copy' as IconName, onClick: () => { navigator.clipboard.writeText(file.name).catch(() => { /* ignore */ }); } },
            ...(folders.length > 0 ? [
              { label: '', onClick: () => { /* divider */ }, divider: true },
              ...folders.filter((fo) => fo.id !== file.folderId).map((fo) => {
                const parent = fo.parentId ? folders.find((x) => x.id === fo.parentId && x.id !== fo.id) : undefined;
                return {
                  label: `${t('rooms.folder.moveTo')}: ${parent ? `${parent.name} / ${fo.name}` : fo.name}`, icon: 'folder' as IconName,
                  onClick: () => onAssignFile(file.fileId, fo.id),
                };
              }),
              ...(file.folderId ? [{ label: `${t('rooms.folder.moveTo')}: ${t('rooms.folder.uncategorized')}`, icon: 'folder' as IconName, onClick: () => onAssignFile(file.fileId, null) }] : []),
            ] : []),
            { label: '', onClick: () => { /* divider */ }, divider: true },
            // The engine authorizes a room-wide delete only for the file's
            // author or the room owner; for anyone else the same call degrades
            // to a local hide — label the item as what it actually does.
            (() => {
              const canDeleteAll = room.canManage || file.addedBy === selfId;
              return {
                label: canDeleteAll ? t('rooms.deleteForAll') : t('rooms.hideForMe'),
                icon: (canDeleteAll ? 'trash' : 'eye-off') as IconName,
                danger: canDeleteAll,
                onClick: async () => {
                  if (await confirm({ message: canDeleteAll ? t('rooms.deleteConfirm') : t('rooms.hideConfirm'), danger: canDeleteAll }))
                    window.api.rooms.removeFile(room.roomId, file.fileId).catch((e) => toast.error(String(e instanceof Error ? e.message : e)));
                },
              };
            })(),
          ]}
        />
        </div>,
        document.body,
      )}
      <div className="room-file-status">
        {haveLocally && tr?.released ? (
          <span className="room-status released" title={t('rooms.releasedHint')}><Icon name="pause" size={16} /></span>
        ) : haveLocally ? (
          <span className="room-status seeding" title={t('rooms.haveLocal')}><Icon name="check-circle" size={16} /></span>
        ) : downloading ? (
          <span className="room-status downloading">{Math.round((tr.progress || 0) * 100)}%</span>
        ) : awaitingFetch ? (
          <span className="room-status queued" title={t('rooms.notFetched')}>—</span>
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
// Audio gets the music mode: a visualizer stage, the room's audio files as a
// queue with auto-advance, and track changes broadcast so everyone advances.
interface Watcher { memberId: string; name: string; avatarSeed: string; playing: boolean; lastSeen: number; }

const RoomPlayer: React.FC<{ room: RoomState; roomId: string; file: RoomFile; self: { memberId: string; name: string; avatarSeed: string }; initialTogether?: boolean; onClose: () => void }> = ({ room, roomId, file, self, initialTogether = false, onClose }) => {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // The Ember control bar drives the same element; main wraps stage + bar for fullscreen.
  const mainRef = useRef<HTMLDivElement>(null);
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      // Start at a comfortable middle volume instead of full blast; remember
      // the last level the user set so it sticks across tracks and sessions.
      const saved = Number(localStorage.getItem('havvn.roomVolume'));
      v.volume = Number.isFinite(saved) && saved > 0 && saved <= 1 ? saved : 0.6;
      const onVol = () => { try { if (v.volume > 0) localStorage.setItem('havvn.roomVolume', String(v.volume)); } catch { /* ignore */ } };
      v.addEventListener('volumechange', onVol);
      setMediaEl(v);
      return () => v.removeEventListener('volumechange', onVol);
    }
    setMediaEl(null);
  }, []);
  const applyingRemote = useRef(false); // suppress echo while applying a remote action
  // `initialTogether` = joining an ongoing session from a row badge — sync
  // starts ON, so the first presence('join') already carries it and incoming
  // beats converge us onto the session immediately.
  const togetherRef = useRef(initialTogether);
  const [together, setTogether] = useState(initialTogether);
  const [controller, setController] = useState<string | null>(null); // name we're synced to (display only)
  const watchersRef = useRef<Record<string, Watcher>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Embedded cover art of the current track (null → note icon). Speculative
  // URL from watchFile; a 404 lands in the img onError which clears it.
  const [cover, setCover] = useState<string | null>(null);
  const [watchers, setWatchers] = useState<Record<string, Watcher>>({});
  const [reactions, setReactions] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const reactSeq = useRef(0);
  togetherRef.current = together;
  watchersRef.current = watchers;

  // The track on stage — starts at the file that opened the player; the music
  // queue and remote 'track' commands switch it without remounting the player.
  const [current, setCurrent] = useState<RoomFile>(file);
  const currentRef = useRef(current);
  currentRef.current = current;
  const roomRef = useRef(room);
  roomRef.current = room;
  const isAudio = classifyMediaKind(current.name) === 'audio';

  // Subtitles: embedded text tracks + sidecar files (listed per track); the
  // chosen one arrives as VTT text and attaches as a same-origin blob <track>
  // (immune to the video's crossOrigin). Selection is local — not synced.
  const [subTracks, setSubTracks] = useState<Array<{ key: string; label: string }>>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [subActiveKey, setSubActiveKey] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState<string | null>(null);
  const subUrlRef = useRef<string | null>(null);
  const applySubUrl = useCallback((u: string | null) => {
    if (subUrlRef.current) URL.revokeObjectURL(subUrlRef.current);
    subUrlRef.current = u;
    setSubUrl(u);
  }, []);
  useEffect(() => () => { if (subUrlRef.current) URL.revokeObjectURL(subUrlRef.current); }, []);
  // Monotonic token: a slow ffmpeg extraction must not override a LATER
  // choice (including Off) when it finally resolves.
  const subReqRef = useRef(0);
  useEffect(() => {
    let alive = true;
    subReqRef.current++;
    setSubTracks([]); setSubOpen(false); setSubActiveKey(null); applySubUrl(null);
    if (classifyMediaKind(current.name) !== 'video') return;
    window.api.rooms.subtitleList(roomId, current.fileId)
      .then((tracks) => { if (alive) setSubTracks(tracks.map((s) => ({ key: s.key, label: s.label }))); })
      .catch(() => { /* no subtitles — the button just doesn't render */ });
    return () => { alive = false; };
  }, [roomId, current.fileId, current.name, applySubUrl]);
  const selectSubtitle = (key: string | null) => {
    setSubOpen(false);
    setSubActiveKey(key);
    const req = ++subReqRef.current;
    if (!key) { applySubUrl(null); return; }
    window.api.rooms.subtitleGet(roomId, current.fileId, key)
      .then((vtt) => {
        if (subReqRef.current !== req) return; // superseded by a later pick
        if (!vtt || !vtt.trim()) { setSubActiveKey((k) => (k === key ? null : k)); return; } // dead track
        applySubUrl(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })));
      })
      .catch((e) => {
        if (subReqRef.current !== req) return;
        setSubActiveKey(null);
        toast.error(String(e instanceof Error ? e.message : e));
      });
  };
  // The queue: every locally-available audio file of the room, in room order.
  const playlist = useMemo(
    () => room.files.filter((f) => classifyMediaKind(f.name) === 'audio' && room.transfers[f.fileId]?.haveLocally),
    [room.files, room.transfers],
  );
  // Remember the current track's slot in the queue. When the track is removed
  // its findIndex goes to -1, so this ref keeps the PRE-removal index — the slot
  // the next track shifts into — for the tombstone handler below.
  const curIdxRef = useRef(0);
  useEffect(() => {
    const i = playlist.findIndex((f) => f.fileId === currentRef.current.fileId);
    if (i >= 0) curIdxRef.current = i;
  }, [playlist]);

  // The track on stage was removed (by us or a peer) — don't leave a ghost
  // playing a file that no longer exists. Notify, then: for AUDIO, advance to the
  // next queued track (broadcast so together peers follow onto the same one);
  // for a video (or when nothing's left to play) just close the player.
  useEffect(() => {
    if (room.files.some((f) => f.fileId === currentRef.current.fileId)) return;
    toast(t('rooms.fileGone'), { icon: '🗑️' });
    const isAudioNow = classifyMediaKind(currentRef.current.name) === 'audio';
    const next = isAudioNow && playlist.length ? playlist[Math.min(curIdxRef.current, playlist.length - 1)] : undefined;
    if (next) playTrack(next, togetherRef.current);
    else onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.files]);

  const playTrack = useCallback((f: RoomFile, broadcastIt: boolean) => {
    setCurrent(f);
    if (broadcastIt) {
      window.api.rooms.broadcastSync(roomId, { fileId: f.fileId, action: 'track', position: 0, playing: true }).catch(() => {});
    }
  }, [roomId]);

  // Music queue: when a track ends, move on (and take the room along in sync).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnded = () => {
      if (classifyMediaKind(currentRef.current.name) !== 'audio') return;
      const idx = playlist.findIndex((f) => f.fileId === currentRef.current.fileId);
      const next = idx >= 0 ? playlist[idx + 1] : undefined;
      if (next) playTrack(next, togetherRef.current);
    };
    v.addEventListener('ended', onEnded);
    return () => v.removeEventListener('ended', onEnded);
  }, [playlist, playTrack]);

  // WebAudio tap for the real spectrum. Created ONCE per media element (the
  // browser allows a single MediaElementSource per element) and kept connected
  // for its whole life — later tracks (and even video) route through the same
  // graph, so the ctx is resumed on every 'play'. Needs the cast server's CORS
  // headers + crossOrigin on the element, or the tap would output silence.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const tapTriedRef = useRef(false);
  useEffect(() => {
    if (!isAudio || !mediaEl || tapTriedRef.current) return;
    tapTriedRef.current = true;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(mediaEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const resume = () => { void ctx.resume().catch(() => {}); };
      mediaEl.addEventListener('play', resume);
      resume();
    } catch {
      analyserRef.current = null; // decorative bars take over below
    }
  }, [isAudio, mediaEl]);
  useEffect(() => () => { try { void audioCtxRef.current?.close(); } catch { /* ignore */ } }, []);

  // Visualizer: the real spectrum when the tap works; if the analyser stays
  // silent while audio is playing (tainted source, odd codec path), it falls
  // back to time-driven bars that freeze on pause. Reduced motion pins them.
  const vizRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!isAudio) return;
    const canvas = vizRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--color-accent-primary').trim() || '#f2913f';
    const olive = css.getPropertyValue('--color-accent-secondary').trim() || '#adb87c';
    let raf = 0;
    const bins = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 0);
    let useSpectrum = !!analyserRef.current && !reduce;
    let silentFrames = 0;
    const draw = () => {
      const box = canvas.parentElement?.getBoundingClientRect();
      if (box && (canvas.width !== Math.floor(box.width) || canvas.height !== Math.floor(box.height))) {
        canvas.width = Math.floor(box.width);
        canvas.height = Math.floor(box.height);
      }
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      const playing = !!videoRef.current && !videoRef.current.paused;
      const n = Math.max(24, Math.floor(W / 26));
      const bw = W / n;

      let spectrumLevel = 0;
      if (useSpectrum && analyserRef.current) {
        analyserRef.current.getByteFrequencyData(bins);
        for (let b = 0; b < bins.length; b += 4) spectrumLevel += bins[b];
        // Playing but dead silent for ~1.5s ⇒ the tap isn't seeing data.
        if (playing && spectrumLevel === 0) { if (++silentFrames > 90) useSpectrum = false; }
        else silentFrames = 0;
      }
      (window as any).__vizDebug = { mode: useSpectrum ? 'spectrum' : 'wave', level: spectrumLevel };

      const time = reduce ? 0 : (videoRef.current?.currentTime ?? 0);
      // Music energy lives in the lower bins — spread the bars over ~70% of them.
      const usable = Math.max(1, Math.floor(bins.length * 0.7));
      for (let i = 0; i < n; i++) {
        let wave: number;
        if (useSpectrum) {
          const b = Math.min(usable - 1, Math.floor(Math.pow(i / n, 1.3) * usable));
          wave = 0.06 + 0.94 * (bins[b] / 255);
        } else {
          const ph = Math.sin(i * 12.9898) * 43758.5453;
          const seed = ph - Math.floor(ph);
          wave = 0.2 + 0.8 * Math.abs(Math.sin(time * (1.1 + seed * 2.2) + seed * 6.28));
        }
        const h = Math.max(3, wave * H * 0.55);
        ctx.fillStyle = i % 7 === 3 ? olive : accent;
        ctx.globalAlpha = 0.2 + wave * 0.6;
        ctx.fillRect(i * bw + bw * 0.28, (H - h) / 2, bw * 0.44, h);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [isAudio, mediaEl]);

  // Float an emoji reaction up over the video, then drop it after the animation.
  const spawnReaction = useCallback((emoji: string) => {
    const id = ++reactSeq.current;
    const x = 8 + Math.random() * 78; // % from the left
    setReactions((r) => [...r.slice(-24), { id, emoji, x }]);
    setTimeout(() => setReactions((r) => r.filter((it) => it.id !== id)), 2600);
  }, []);

  // Send a reaction to the room (and show it locally right away).
  const react = useCallback((emoji: string) => {
    spawnReaction(emoji);
    const v = videoRef.current;
    window.api.rooms.broadcastSync(roomId, { fileId: current.fileId, action: 'react', position: v ? v.currentTime : 0, emoji }).catch(() => {});
  }, [spawnReaction, roomId, current.fileId]);

  // ── Cinema presence: announce we're watching, heartbeat, and leave ────────
  const presence = useCallback((action: 'join' | 'leave' | 'beat') => {
    const v = videoRef.current;
    window.api.rooms.broadcastSync(roomId, {
      fileId: current.fileId, action,
      position: v ? v.currentTime : 0,
      playing: v ? !v.paused : false,
      together: togetherRef.current, // so peers only follow beats from members who are in sync
    }).catch(() => {});
  }, [roomId, current.fileId]);

  useEffect(() => {
    // Seed self into the watcher list right away.
    setWatchers({ [self.memberId]: { memberId: self.memberId, name: self.name || t('rooms.you'), avatarSeed: self.avatarSeed, playing: false, lastSeen: Date.now() } });
    presence('join');
    const beat = setInterval(() => presence('beat'), 5000);
    // Self heartbeat so our own card stays fresh and reflects play state.
    const selfTick = setInterval(() => {
      const v = videoRef.current;
      setWatchers((w) => ({ ...w, [self.memberId]: { ...(w[self.memberId] || { memberId: self.memberId, name: self.name || t('rooms.you'), avatarSeed: self.avatarSeed }), playing: v ? !v.paused : false, lastSeen: Date.now() } as Watcher }));
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

  // Load the media (direct or HLS) — re-runs on every track switch.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setCover(null); // don't wear the previous track's art while loading
    window.api.rooms.watchFile(roomId, current.fileId).then((info) => {
      if (!alive) return;
      setCover(info.coverUrl || null);
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
  }, [roomId, current.fileId, t]);

  // Broadcast local play/pause/seek to peers when "together" is on.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const send = (action: string) => {
      if (!togetherRef.current || applyingRemote.current) return;
      window.api.rooms.broadcastSync(roomId, { fileId: current.fileId, action, position: v.currentTime, rate: v.playbackRate, together: true }).catch(() => {});
    };
    const onPlay = () => send('play');
    const onPause = () => send('pause');
    const onSeeked = () => send('seek');
    // Speed changes propagate too (PlayerControls gained a rate menu) — the
    // sync handler below applies msg.rate, so the room plays at one speed.
    const onRate = () => send('rate');
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRate);
    return () => { v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeked', onSeeked); v.removeEventListener('ratechange', onRate); };
  }, [roomId, current.fileId]);

  // Leaving the player unmounts its <video> — close any PiP window it owns
  // instead of stranding a dead floating frame.
  useEffect(() => () => {
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
  }, []);

  // Track who's watching (presence) + apply remote sync when "together" is on.
  useEffect(() => {
    const off = window.api.onRoomSync((msg) => {
      if (msg.roomId !== roomId) return;
      // Track change (music queue) crosses the per-file scoping on purpose:
      // someone advanced the queue — follow them onto the new track.
      if (msg.action === 'track') {
        if (!togetherRef.current || msg.fileId === currentRef.current.fileId) return;
        const f = roomRef.current.files.find((x) => x.fileId === msg.fileId);
        if (f) { setController(msg.name); setCurrent(f); }
        return;
      }
      if (msg.fileId !== currentRef.current.fileId) return;
      // Presence: every message means that member is in the session right now.
      if (msg.action === 'leave') {
        setWatchers((w) => { const n = { ...w }; delete n[msg.memberId]; return n; });
      } else {
        setWatchers((w) => ({ ...w, [msg.memberId]: { memberId: msg.memberId, name: msg.name || '?', avatarSeed: msg.avatarSeed || msg.memberId, playing: !!msg.playing, lastSeen: Date.now() } }));
      }
      // Continuous soft-sync — forward-only catch-up. On a heartbeat from a peer
      // who ALSO has sync on and is playing AHEAD of us, we jump forward to them.
      // We never pull anyone BACKWARD on a mere beat, so there is no leader to
      // elect, lose or fight over: the room simply converges forward onto whoever
      // is furthest along, and a fresh joiner can't yank an established listener
      // back to zero. Deliberate play/pause/seek still propagate via the action
      // handler below. A peer freshly paused near the start counts as a joiner and
      // starts playing to catch up; a deliberate pause deep in the track does not.
      if ((msg.action === 'beat' || msg.action === 'join') && togetherRef.current
          && msg.together && msg.playing && msg.memberId !== self.memberId) {
        const v = videoRef.current;
        if (v && !applyingRemote.current) {
          const ahead = msg.position + Math.max(0, (Date.now() - msg.at) / 1000);
          const joiner = v.paused && v.currentTime < 5; // just opened, not a deliberate pause
          if (ahead - v.currentTime > 1.8 && (!v.paused || joiner)) {
            setController(msg.name);
            applyingRemote.current = true;
            try { v.currentTime = ahead; if (v.paused) void v.play().catch(() => {}); }
            finally { setTimeout(() => { applyingRemote.current = false; }, 250); }
          }
        }
      }
      // Reactions float for everyone, in or out of sync.
      if (msg.action === 'react') { if (msg.emoji) spawnReaction(msg.emoji); return; }
      // Playback follow — only the actual control actions, only when in sync.
      if (!togetherRef.current) return;
      if (msg.action !== 'play' && msg.action !== 'pause' && msg.action !== 'seek' && msg.action !== 'rate') return;
      const v = videoRef.current;
      if (!v) return;
      setController(msg.name);
      const expected = msg.position + (msg.action === 'play' ? Math.max(0, (Date.now() - msg.at) / 1000) : 0);
      applyingRemote.current = true;
      // Clear the echo guard when the media actually settles (a transcode/HLS
      // seek can take far longer than a fixed timer — the late 'seeked' would
      // otherwise re-broadcast and yank the room to our stale position). Fixed
      // timeout stays as a floor/fallback.
      const done = () => { applyingRemote.current = false; };
      const guard = setTimeout(done, 250);
      const settle = () => { clearTimeout(guard); done(); };
      try {
        // Speed rides every sync message; 'rate' is also its own action so a
        // lone speed change (no play/pause/seek) still propagates.
        if (typeof msg.rate === 'number' && msg.rate > 0 && Math.abs(v.playbackRate - msg.rate) > 0.001) v.playbackRate = msg.rate;
        if (msg.action === 'pause') { v.pause(); if (Math.abs(v.currentTime - msg.position) > 0.5) v.currentTime = msg.position; }
        else if (msg.action === 'seek') { v.addEventListener('seeked', settle, { once: true }); v.currentTime = msg.position; }
        else if (msg.action === 'play') { if (Math.abs(v.currentTime - expected) > 1.5) v.currentTime = expected; v.play().catch(() => {}); }
      } catch { /* ignore */ }
    });
    return off;
  }, [roomId, file.fileId, spawnReaction]);

  const toggleTogether = () => {
    const next = !together;
    setTogether(next);
    togetherRef.current = next; // live immediately so the beat below carries the right flag
    // Announce right away so the room converges without waiting for the next 5s
    // heartbeat: peers behind us catch up to our position, and incoming beats
    // pull us forward if we're the one behind. Forward-only — enabling sync
    // never yanks anyone backward.
    if (next) presence('beat');
  };

  return (
    <div className="room-player-inline">
      <div className="room-player">
        <div className="room-player-top">
          <span className="room-player-name" title={current.name}>{current.name}</span>
          {!isAudio && subTracks.length > 0 && (
            <span className="room-sub-wrap">
              <button className={`room-player-sync room-sub-btn${subActiveKey ? ' on' : ''}`} onClick={() => setSubOpen((o) => !o)} title={t('rooms.subtitles')}>
                <Icon name="type" size={14} /> CC
              </button>
              {subOpen && (
                <span className="room-sub-pop">
                  <button type="button" className={`room-sub-item${!subActiveKey ? ' active' : ''}`} onClick={() => selectSubtitle(null)}>{t('rooms.subtitlesOff')}</button>
                  {subTracks.map((s) => (
                    <button key={s.key} type="button" className={`room-sub-item${subActiveKey === s.key ? ' active' : ''}`} onClick={() => selectSubtitle(s.key)}>{s.label}</button>
                  ))}
                </span>
              )}
            </span>
          )}
          <button className={`room-player-sync ${together ? 'on' : ''}`} onClick={toggleTogether} title={t('rooms.together.hint')}>
            <Icon name="users" size={14} /> {together ? t('rooms.together.on') : t('rooms.together.off')}
          </button>
          <button className="room-player-close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <div className="room-player-body">
          <div className="room-player-main" ref={mainRef}>
            <div className="room-player-stage">
              <video
                ref={videoRef}
                className={`room-player-video ${isAudio ? 'room-player-video-hidden' : ''}`}
                autoPlay
                playsInline
                crossOrigin="anonymous"
                onClick={() => { const v = videoRef.current; if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } }}
              >
                {subUrl && <track kind="subtitles" src={subUrl} srcLang="und" default />}
              </video>
              {isAudio && (
                <div
                  className="room-audio-stage"
                  onClick={() => { const v = videoRef.current; if (v) { if (v.paused) void v.play().catch(() => {}); else v.pause(); } }}
                >
                  {cover && <div className="room-audio-backdrop" style={{ backgroundImage: `url("${cover}")` }} aria-hidden="true" />}
                  <canvas ref={vizRef} className="room-audio-viz" aria-hidden="true" />
                  <div className="room-audio-meta">
                    <span className="room-audio-disc">
                      {cover ? (
                        <img className="room-audio-cover" src={cover} alt="" onError={() => setCover(null)} />
                      ) : (
                        <Icon name="music" size={20} />
                      )}
                    </span>
                    <div className="room-audio-titles">
                      <div className="room-audio-name" title={current.name}>{current.name}</div>
                      <div className="room-audio-sub">
                        {formatBytes(current.size)}
                        {playlist.length > 1 && ` · ${Math.max(1, playlist.findIndex((f) => f.fileId === current.fileId) + 1)}/${playlist.length}`}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div className="room-player-reactions" aria-hidden="true">
                {reactions.map((r) => (
                  <span key={r.id} className="room-reaction" style={{ left: `${r.x}%` }}>{r.emoji}</span>
                ))}
              </div>
            </div>
            <PlayerControls media={mediaEl} fullscreenTarget={mainRef} />
            <div className="room-player-reactbar">
              {['😂', '❤️', '🔥', '😮', '👏', '🎉', '😢', '💀'].map((e) => (
                <button key={e} className="room-react-btn" onClick={() => react(e)} title={t('rooms.react')}>{e}</button>
              ))}
            </div>
            {isAudio && playlist.length > 1 && (
              <div className="room-player-queue">
                <div className="room-queue-head"><Icon name="music" size={12} /> {t('rooms.queue')} · {playlist.length}</div>
                {playlist.map((f, i) => (
                  <button
                    key={f.fileId}
                    className={`room-queue-row ${f.fileId === current.fileId ? 'on' : ''}`}
                    onClick={() => playTrack(f, togetherRef.current)}
                  >
                    <span className="room-queue-idx">{f.fileId === current.fileId ? '♪' : i + 1}</span>
                    <span className="room-queue-name">{f.name}</span>
                    <span className="room-queue-size">{formatBytes(f.size)}</span>
                  </button>
                ))}
              </div>
            )}
            {loading && !error && <div className="room-player-msg">{t('common.loading')}</div>}
            {error && <div className="room-player-msg err">{error}</div>}
            {together && controller && <div className="room-player-controller">{t('rooms.together.synced')}: {controller}</div>}
          </div>

          <aside className="room-player-side">
            <div className="room-player-watchers">
              <span className="room-player-watchers-label"><Icon name="users" size={13} /> {isAudio ? t('rooms.listening') : t('rooms.watching')}</span>
              <div className="room-player-avatars">
                {Object.values(watchers).sort((a, b) => a.name.localeCompare(b.name)).map((w) => (
                  <span key={w.memberId} className={`room-watcher ${w.playing ? 'playing' : 'paused'}`} title={`${w.name}${w.memberId === self.memberId ? ` ${t('rooms.youParen')}` : ''} — ${w.playing ? '▶' : '❚❚'}`}>
                    <Identicon seed={w.avatarSeed} size={26} />
                    <span className="room-watcher-dot" />
                  </span>
                ))}
              </div>
              {Object.keys(watchers).length <= 1 && <span className="room-player-alone">{t('rooms.watchAlone')}</span>}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default RoomsPage;
