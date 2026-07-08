/**
 * Phase-5 cross-link modals.
 *
 * ShareToRoomModal — "Share to room" on a transfer: pick one of your rooms and
 * the download's files are seeded into it (rooms:shareDownload).
 * TransferPickerModal — "Bring a file from Transfers" inside a room: pick a
 * finished download, same backend path.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { Download, RoomSummary, RoomState } from '../../shared/types';
import { Button } from './Button';
import { Icon } from './Icon';
import { formatBytes, cleanError } from '../utils/format-helpers';
import { useTranslation } from '../utils/i18nContext';
import './RoomShareModals.css';

/** Room initials tile, mirroring the sidebar rail's room chip. */
const RoomTile: React.FC<{ name: string }> = ({ name }) => (
  <span className="rsm-tile rsm-tile-room" aria-hidden="true">
    {name.trim().slice(0, 2).toUpperCase() || '?'}
  </span>
);

const useEscape = (onClose: () => void): void => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
};

/** Move focus into the dialog on open; hand it back where it was on close. */
const useModalFocus = (): React.RefObject<HTMLDivElement> => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);
  return ref;
};

// ── File-pick stage (multi-file downloads) ───────────────────────────────────
interface ShareableFile { path: string; name: string; size: number }
interface ShareableList { files: ShareableFile[]; truncated: boolean; maxShare: number }

/** Checkbox list of a download's shareable files, capped at `maxShare` picks. */
const FilePickStage: React.FC<{
  list: ShareableList;
  busy: boolean;
  onBack: () => void;
  onShare: (paths: string[]) => void;
}> = ({ list, busy, onBack, onShare }) => {
  const { t } = useTranslation();
  const { files, truncated, maxShare } = list;
  // Everything pre-selected when it fits the cap; a blank slate otherwise.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(files.length <= maxShare ? files.map((f) => f.path) : []),
  );
  const toggle = (p: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });
  const selectedSize = files.reduce((sum, f) => (picked.has(f.path) ? sum + f.size : sum), 0);
  const over = picked.size > maxShare;

  return (
    <>
      <p className="rsm-desc">{t('share.files.pick')}</p>
      <div className="rsm-files-tools">
        <button
          className="rsm-tool"
          disabled={busy || files.length > maxShare}
          onClick={() => setPicked(new Set(files.map((f) => f.path)))}
        >{t('share.files.all')}</button>
        <button className="rsm-tool" disabled={busy} onClick={() => setPicked(new Set())}>
          {t('share.files.none')}
        </button>
        {truncated && <span className="rsm-files-note">{t('share.files.truncated')}</span>}
      </div>
      <div className="rsm-list rsm-files">
        {files.map((f) => (
          <label key={f.path} className="rsm-frow" title={f.path}>
            <input
              type="checkbox"
              checked={picked.has(f.path)}
              disabled={busy}
              onChange={() => toggle(f.path)}
            />
            <span className="rsm-frow-name">{f.name}</span>
            <span className="rsm-frow-size">{f.size > 0 ? formatBytes(f.size) : ''}</span>
          </label>
        ))}
      </div>
      <div className="rsm-files-foot">
        <span className={`rsm-files-count ${over ? 'over' : ''}`}>
          {picked.size} {t('share.files.selected')}
          {selectedSize > 0 && ` · ${formatBytes(selectedSize)}`}
          {over && ` — ${t('share.files.overLimit')} ${maxShare}`}
        </span>
        <div className="rsm-actions-row">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onBack}>{t('share.files.back')}</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || picked.size === 0 || over}
            loading={busy}
            onClick={() => onShare(files.filter((f) => picked.has(f.path)).map((f) => f.path))}
          >
            {t('downloads.share')}
          </Button>
        </div>
      </div>
    </>
  );
};

// ── Share a download into a room ─────────────────────────────────────────────
interface ShareToRoomModalProps {
  downloadId: string;
  downloadName: string;
  /** Complete downloads only — incomplete ones show a hint + link fallback. */
  canShare: boolean;
  onClose: () => void;
  /** "Share as link instead" (opens the existing ShareLinkModal). */
  onShareLink?: () => void;
}

export const ShareToRoomModal: React.FC<ShareToRoomModalProps> = ({
  downloadId,
  downloadName,
  canShare,
  onClose,
  onShareLink,
}) => {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  // What the download can share — drives the file-pick stage for multi-file
  // downloads. 'error' falls back to a direct share (the backend reports why).
  const [fileList, setFileList] = useState<ShareableList | 'error' | null>(null);
  const [pickFor, setPickFor] = useState<RoomSummary | null>(null);
  useEscape(useCallback(() => { if (!busyRoomId) onClose(); }, [busyRoomId, onClose]));
  const dialogRef = useModalFocus();

  useEffect(() => {
    window.api.rooms.list().then(setRooms).catch(() => setRooms([]));
  }, []);

  useEffect(() => {
    if (!canShare) return;
    window.api.rooms.listShareableFiles(downloadId).then(setFileList).catch(() => setFileList('error'));
  }, [downloadId, canShare]);

  const share = async (room: RoomSummary, selectedPaths?: string[]) => {
    if (busyRoomId || !canShare) return;
    setBusyRoomId(room.roomId);
    try {
      await window.api.rooms.shareDownload(room.roomId, downloadId, selectedPaths);
      toast.success(`${t('share.toRoom.success')} ${room.name}`);
      onClose();
    } catch (e) {
      toast.error(cleanError(e));
      setBusyRoomId(null);
    }
  };

  const handleRoomClick = (room: RoomSummary) => {
    if (fileList && fileList !== 'error' && fileList.files.length > 1) setPickFor(room);
    else void share(room);
  };

  return (
    <div className="rsm-backdrop" onClick={() => !busyRoomId && onClose()}>
      <div
        ref={dialogRef}
        className="rsm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('share.toRoom.title')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rsm-head">
          <h3><Icon name="share-2" size={15} /> {t('share.toRoom.title')}</h3>
          <button
            className="rsm-close"
            disabled={!!busyRoomId}
            onClick={() => !busyRoomId && onClose()}
            aria-label={t('common.cancel')}
          ><Icon name="x" size={16} /></button>
        </div>
        <div className="rsm-file" title={downloadName}>{downloadName}</div>

        {!canShare && (
          <div className="rsm-note warn">
            <Icon name="clock" size={14} />
            <span>{t('share.toRoom.incomplete')}</span>
          </div>
        )}

        {pickFor && fileList && fileList !== 'error' ? (
          <FilePickStage
            list={fileList}
            busy={!!busyRoomId}
            onBack={() => setPickFor(null)}
            onShare={(paths) => void share(pickFor, paths)}
          />
        ) : rooms === null || (canShare && fileList === null) ? (
          <div className="rsm-empty">{t('common.loading')}</div>
        ) : rooms.length === 0 ? (
          <div className="rsm-empty">{t('share.toRoom.empty')}</div>
        ) : (
          <>
            <p className="rsm-desc">{t('share.toRoom.pick')}</p>
            <div className="rsm-list">
              {rooms.map((room) => (
                <button
                  key={room.roomId}
                  className="rsm-item"
                  disabled={!canShare || !!busyRoomId}
                  onClick={() => handleRoomClick(room)}
                >
                  <RoomTile name={room.name} />
                  <span className="rsm-text">
                    <span className="rsm-name">{room.name}</span>
                    <span className="rsm-meta">
                      <Icon name="users" size={11} /> {room.memberCount}
                      <span className="rsm-dot">·</span>
                      <Icon name="folder" size={11} /> {room.fileCount}
                      {room.e2e && (
                        <>
                          <span className="rsm-dot">·</span>
                          <Icon name="lock" size={11} /> {t('share.toRoom.e2e')}
                        </>
                      )}
                    </span>
                  </span>
                  {busyRoomId === room.roomId
                    ? <span className="spinner" />
                    : <Icon name="chevron-right" size={15} className="rsm-go" />}
                </button>
              ))}
            </div>
          </>
        )}

        {onShareLink && !pickFor && (
          <div className="rsm-actions">
            <Button variant="ghost" size="sm" disabled={!!busyRoomId} icon={<Icon name="link" size={13} />} onClick={onShareLink}>
              {t('share.toRoom.linkInstead')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Bring a finished download into the current room ─────────────────────────
interface TransferPickerModalProps {
  roomId: string;
  onClose: () => void;
  /** Receives the room state returned by the share (already includes the file). */
  onShared: (state: RoomState) => void;
}

export const TransferPickerModal: React.FC<TransferPickerModalProps> = ({ roomId, onClose, onShared }) => {
  const { t } = useTranslation();
  const [downloads, setDownloads] = useState<Download[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Multi-file download chosen → its file-pick stage.
  const [pick, setPick] = useState<{ download: Download; list: ShareableList } | null>(null);
  useEscape(useCallback(() => { if (!busyId) onClose(); }, [busyId, onClose]));
  const dialogRef = useModalFocus();

  useEffect(() => {
    window.api.getDownloads()
      .then((list) => setDownloads(
        // 'removed' records are tombstoned in the db until next boot — hide them.
        list.filter((d) => d.status !== 'removed'
          && (d.progress >= 1 || ['completed', 'seeding'].includes(d.status)))
      ))
      .catch(() => setDownloads([]));
  }, []);

  const share = async (download: Download, selectedPaths?: string[]) => {
    setBusyId(download.id);
    try {
      const state = await window.api.rooms.shareDownload(roomId, download.id, selectedPaths);
      toast.success(`${t('share.toRoom.success')} ${state.name}`);
      onShared(state);
      onClose();
    } catch (e) {
      toast.error(cleanError(e));
      setBusyId(null);
    }
  };

  const handleDownloadClick = async (download: Download) => {
    if (busyId) return;
    setBusyId(download.id);
    try {
      const list = await window.api.rooms.listShareableFiles(download.id);
      if (list.files.length > 1) {
        setPick({ download, list });
        setBusyId(null);
        return;
      }
    } catch {
      // Fall through — the share itself will surface the real error.
    }
    setBusyId(null);
    await share(download);
  };

  return (
    <div className="rsm-backdrop" onClick={() => !busyId && onClose()}>
      <div
        ref={dialogRef}
        className="rsm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('rooms.fromTransfers.title')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rsm-head">
          <h3><Icon name="download" size={15} /> {t('rooms.fromTransfers.title')}</h3>
          <button
            className="rsm-close"
            disabled={!!busyId}
            onClick={() => !busyId && onClose()}
            aria-label={t('common.cancel')}
          ><Icon name="x" size={16} /></button>
        </div>

        {pick ? (
          <>
            <div className="rsm-file" title={pick.download.name}>{pick.download.name}</div>
            <FilePickStage
              list={pick.list}
              busy={!!busyId}
              onBack={() => setPick(null)}
              onShare={(paths) => void share(pick.download, paths)}
            />
          </>
        ) : downloads === null ? (
          <div className="rsm-empty">{t('common.loading')}</div>
        ) : downloads.length === 0 ? (
          <div className="rsm-empty">{t('rooms.fromTransfers.empty')}</div>
        ) : (
          <>
            <p className="rsm-desc">{t('rooms.fromTransfers.pick')}</p>
            <div className="rsm-list">
              {downloads.map((d) => (
                <button
                  key={d.id}
                  className="rsm-item"
                  disabled={!!busyId}
                  onClick={() => void handleDownloadClick(d)}
                >
                  <span className="rsm-tile" aria-hidden="true"><Icon name="file" size={15} /></span>
                  <span className="rsm-text">
                    <span className="rsm-name">{d.name}</span>
                    <span className="rsm-meta">{d.totalSize > 0 ? formatBytes(d.totalSize) : ''}</span>
                  </span>
                  {busyId === d.id
                    ? <span className="spinner" />
                    : <Icon name="chevron-right" size={15} className="rsm-go" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
