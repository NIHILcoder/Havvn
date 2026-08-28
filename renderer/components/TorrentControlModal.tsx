/**
 * TorrentControlModal
 * Per-torrent advanced controls: sequential download, speed limits,
 * seed ratio/time, file priorities, tracker management.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Download, TorrentFile, TrackerInfo, FilePriority, PeerInfo, TorrentPieces } from '../../shared/types';
import { peerHostToIPv4 } from '../../shared/ip-range';
import { Button, Icon } from './index';
import { Modal } from './Modal';
import { ContextMenu } from './ContextMenu';
import { useConfirm } from './ConfirmDialog';
import { useTranslation } from '../utils/i18nContext';
import { cleanError } from '../utils/format-helpers';
import './TorrentControlModal.css';

interface TorrentControlModalProps {
  download: Download;
  onClose: () => void;
  onUpdate?: () => void;
}

type Tab = 'download' | 'seeding' | 'files' | 'peers' | 'trackers' | 'pieces';

const formatSpeed = (bps: number): string => (bps > 0 ? formatBytes(bps) + '/s' : '—');

function codeToFlag(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return '';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

const FILE_PRIORITY_COLORS: Record<FilePriority, string> = {
  skip: '#6b7280',
  low: '#60a5fa',
  normal: '#22c55e',
  high: '#f59e0b',
};

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const TorrentControlModal: React.FC<TorrentControlModalProps> = ({
  download,
  onClose,
  onUpdate,
}) => {
  const { t } = useTranslation();
  const { alert, confirm } = useConfirm();
  const [tab, setTab] = useState<Tab>('download');

  // Localized "Ns/Nm/Nh ago" for a tracker's last-announce timestamp.
  const relTime = (ts: number): string => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}${t('time.sec')} ${t('time.ago')}`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}${t('time.min')} ${t('time.ago')}`;
    return `${Math.round(m / 60)}${t('time.hour')} ${t('time.ago')}`;
  };

  // Peer connection-type labels (mostly protocol tokens; only "Web seed" is text).
  const CONN_LABELS: Record<PeerInfo['connType'], string> = {
    'tcp-in': 'TCP ↓', 'tcp-out': 'TCP ↑', 'utp-in': 'µTP ↓', 'utp-out': 'µTP ↑',
    'webrtc': 'WebRTC', 'web-seed': t('tcm.webSeed'), 'other': '—',
  };
  const priorityLabel = (p: FilePriority): string =>
    t(`tcm.priority.${p}` as Parameters<typeof t>[0]);

  // Download tab state
  const [sequential, setSequential] = useState(download.sequentialDownload ?? false);
  const [savingDownload, setSavingDownload] = useState(false);

  // Seeding tab state
  const [seedRatio, setSeedRatio] = useState(download.seedRatioLimit ?? 0);
  const [seedTime, setSeedTime] = useState(download.seedTimeLimitMinutes ?? 0);
  const [savingSeeding, setSavingSeeding] = useState(false);

  // Files tab state
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [savingPriority, setSavingPriority] = useState<number | null>(null);

  // Trackers tab state
  const [trackers, setTrackers] = useState<TrackerInfo[]>([]);
  const [newTrackerUrl, setNewTrackerUrl] = useState('');
  const [loadingTrackers, setLoadingTrackers] = useState(false);
  const [addingTracker, setAddingTracker] = useState(false);

  // Peers tab state
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [peersLoaded, setPeersLoaded] = useState(false);
  const [peerMenu, setPeerMenu] = useState<{ x: number; y: number; address: string } | null>(null);
  const bannedIpsRef = useRef<Set<number>>(new Set());

  const [pieces, setPieces] = useState<TorrentPieces | null>(null);
  const [piecesLoaded, setPiecesLoaded] = useState(false);
  const [moving, setMoving] = useState(false);
  const [reannouncing, setReannouncing] = useState(false);

  // Load data when tab changes
  useEffect(() => {
    if (tab === 'files' && files.length === 0) loadFiles();
    if (tab === 'trackers' && trackers.length === 0) loadTrackers();
  }, [tab]);

  // Live-poll peers while the Peers tab is open (they change constantly).
  useEffect(() => {
    if (tab !== 'peers') return;
    let alive = true;
    const tick = () => {
      window.api.getPeers(download.id)
        .then((list) => {
          if (!alive) return;
          const hide = bannedIpsRef.current;
          setPeers((list || []).filter((p) => {
            const n = peerHostToIPv4(p.address);
            return n === null || !hide.has(n);
          }));
          setPeersLoaded(true);
        })
        .catch(() => { if (alive) setPeersLoaded(true); });
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [tab, download.id]);

  useEffect(() => {
    if (tab !== 'pieces') return;
    let alive = true;
    const tick = () => {
      window.api.getPieces(download.id)
        .then((result) => { if (alive) { setPieces(result); setPiecesLoaded(true); } })
        .catch(() => { if (alive) setPiecesLoaded(true); });
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [tab, download.id]);

  const loadFiles = async () => {
    setLoadingFiles(true);
    try {
      const result = await window.api.getTorrentFiles(download.id);
      setFiles(result || []);
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      setLoadingFiles(false);
    }
  };

  const loadTrackers = async () => {
    setLoadingTrackers(true);
    try {
      const result = await window.api.getTrackers(download.id);
      setTrackers(result || []);
    } catch (err) {
      console.error('Failed to load trackers:', err);
    } finally {
      setLoadingTrackers(false);
    }
  };

  const handleMoveData = async () => {
    const dest = await window.api.selectDirectory();
    if (!dest) return;
    setMoving(true);
    try {
      await window.api.setDownloadLocation(download.id, dest, true);
      onUpdate?.();
    } catch (err) {
      await alert({ message: `${t('tcm.failed')}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setMoving(false);
    }
  };

  const handleReannounce = async () => {
    setReannouncing(true);
    try {
      await window.api.reannounceDownload(download.id);
      await loadTrackers();
    } catch (err) {
      await alert({ message: `${t('tcm.failed')}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setReannouncing(false);
    }
  };

  // Save download settings
  const handleSaveDownload = async () => {
    setSavingDownload(true);
    try {
      await window.api.setSequentialDownload(download.id, sequential);
      onUpdate?.();
    } catch (err: any) {
      await alert({ message: `${t('tcm.failed')}: ${err?.message}` });
    } finally {
      setSavingDownload(false);
    }
  };

  // Save seeding limits
  const handleSaveSeeding = async () => {
    setSavingSeeding(true);
    try {
      await window.api.setSeedRatioLimit(download.id, seedRatio);
      await window.api.setSeedTimeLimit(download.id, seedTime);
      onUpdate?.();
    } catch (err: any) {
      await alert({ message: `${t('tcm.failed')}: ${err?.message}` });
    } finally {
      setSavingSeeding(false);
    }
  };

  // Change file priority
  const handleFilePriority = async (fileIndex: number, priority: FilePriority) => {
    setSavingPriority(fileIndex);
    try {
      await window.api.setFilePriority(download.id, fileIndex, priority);
      setFiles(prev =>
        prev.map((f, i) => i === fileIndex ? { ...f, priority } : f)
      );
    } catch (err: any) {
      await alert({ message: `${t('tcm.failed')}: ${err?.message}` });
    } finally {
      setSavingPriority(null);
    }
  };

  // Add tracker
  const handleAddTracker = async () => {
    if (!newTrackerUrl.trim()) return;
    setAddingTracker(true);
    try {
      await window.api.addTracker(download.id, newTrackerUrl.trim());
      setNewTrackerUrl('');
      await loadTrackers();
    } catch (err: any) {
      await alert({ message: `${t('tcm.failed')}: ${err?.message}` });
    } finally {
      setAddingTracker(false);
    }
  };

  // Remove tracker
  const handleRemoveTracker = async (url: string) => {
    try {
      await window.api.removeTracker(download.id, url);
      setTrackers(prev => prev.filter(t => t.url !== url));
    } catch (err: any) {
      await alert({ message: `${t('tcm.failed')}: ${err?.message}` });
    }
  };

  const handleBanPeer = async (address: string, persist: boolean) => {
    setPeerMenu(null);
    if (peerHostToIPv4(address) === null) {
      await alert({ message: t('tcm.ban.ipv4Only') });
      return;
    }
    if (persist && !(await confirm({ message: t('tcm.ban.confirmPersist'), danger: true }))) return;
    try {
      await window.api.banPeer(address, persist);
      const banned = peerHostToIPv4(address);
      if (banned !== null) bannedIpsRef.current.add(banned);
      setPeers((prev) => prev.filter((p) => peerHostToIPv4(p.address) !== banned));
    } catch (err) {
      const msg = cleanError(err);
      await alert({
        message: msg.includes('INVALID_PEER')
          ? t('tcm.ban.ipv4Only')
          : `${t('tcm.ban.failed')}: ${msg}`,
      });
    }
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'download', label: t('tcm.tabDownload'), icon: 'download' },
    { id: 'seeding', label: t('status.seeding'), icon: 'upload' },
    { id: 'files', label: t('downloads.files'), icon: 'file' },
    { id: 'peers', label: t('table.peers'), icon: 'users' },
    { id: 'pieces', label: t('create.pieces'), icon: 'grid' },
    { id: 'trackers', label: t('trackers.tab'), icon: 'server' },
  ];

  return (
    <>
    <Modal
      onClose={onClose}
      icon="settings"
      title={
        <span className="tcm-title-block">
          <span>{t('tcm.title')}</span>
          <span className="tcm-subtitle" title={download.name}>{download.name}</span>
        </span>
      }
      ariaLabel={t('tcm.title')}
      size="lg"
      bodyClassName="tcm-modal-body"
    >
        {/* Tabs */}
        <div className="tcm-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`tcm-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon as any} size={14} />
              <span className="tcm-tab-label">{t.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="tcm-body">

          {/* ── DOWNLOAD TAB ── */}
          {tab === 'download' && (
            <div className="tcm-section">
              {/* Sequential Download */}
              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">{t('tcm.sequential')}</span>
                  <span className="tcm-field-desc">
                    {t('tcm.sequentialDesc')}
                  </span>
                </div>
                <button
                  className={`tcm-toggle ${sequential ? 'on' : 'off'}`}
                  onClick={() => setSequential(!sequential)}
                >
                  <span className="tcm-toggle-knob" />
                </button>
              </div>

              <div className="tcm-divider" />

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">{t('tcm.moveData')}</span>
                  <span className="tcm-field-desc">{t('tcm.moveDataDesc')}</span>
                  <span className="tcm-field-desc" title={download.savePath}>{download.savePath}</span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={moving}
                  onClick={() => { void handleMoveData(); }}
                  icon={<Icon name="folder" size={14} />}
                >
                  {t('settings.choose')}
                </Button>
              </div>

              <div className="tcm-divider" />

              {/* Per-torrent speed limits were removed: webtorrent 1.9.7 only
                  throttles globally, so they never applied. Use the global /
                  alternative-speed limits in Settings instead. */}

              <div className="tcm-actions">
                <Button variant="primary" loading={savingDownload} onClick={handleSaveDownload}
                  icon={<Icon name="check" size={15} />}>
                  {t('tcm.apply')}
                </Button>
              </div>
            </div>
          )}

          {/* ── SEEDING TAB ── */}
          {tab === 'seeding' && (
            <div className="tcm-section">
              <div className="tcm-info-box">
                <Icon name="info" size={14} />
                <span>
                  {t('tcm.seedOverridePre')}{' '}
                  <strong>0</strong>{' '}
                  {t('tcm.seedOverridePost')}
                </span>
              </div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="percent" size={13} />
                    {t('tcm.seedRatioLimit')}
                  </span>
                  <span className="tcm-field-desc">{t('tcm.seedRatioDesc')}</span>
                </div>
                <div className="tcm-speed-input">
                  <input
                    type="number"
                    className="tcm-input"
                    min="0"
                    step="0.1"
                    value={seedRatio}
                    onChange={e => setSeedRatio(parseFloat(e.target.value) || 0)}
                  />
                  <span className="tcm-unit">{t('settings.unit.ratio')}</span>
                </div>
              </div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="clock" size={13} />
                    {t('tcm.seedTimeLimit')}
                  </span>
                  <span className="tcm-field-desc">{t('tcm.seedTimeDesc')}</span>
                </div>
                <div className="tcm-speed-input">
                  <input
                    type="number"
                    className="tcm-input"
                    min="0"
                    step="5"
                    value={seedTime}
                    onChange={e => setSeedTime(parseInt(e.target.value) || 0)}
                  />
                  <span className="tcm-unit">{t('settings.unit.min')}</span>
                </div>
              </div>

              {(seedRatio > 0 || seedTime > 0) && (
                <div className="tcm-preview-box">
                  <Icon name="zap" size={13} />
                  <span>
                    {t('tcm.seedingStopWhen')}{' '}
                    {seedRatio > 0 && <strong>{t('settings.unit.ratio')} ≥ {seedRatio}</strong>}
                    {seedRatio > 0 && seedTime > 0 && <>{' '}{t('settings.or')}{' '}</>}
                    {seedTime > 0 && <strong>{seedTime} {t('tcm.minElapsed')}</strong>}
                  </span>
                </div>
              )}

              <div className="tcm-actions">
                <Button variant="primary" loading={savingSeeding} onClick={handleSaveSeeding}
                  icon={<Icon name="check" size={15} />}>
                  {t('tcm.apply')}
                </Button>
              </div>
            </div>
          )}

          {/* ── FILES TAB ── */}
          {tab === 'files' && (
            <div className="tcm-section">
              {loadingFiles ? (
                <div className="tcm-loading">
                  <span className="spinner" />
                  <span>{t('tcm.loadingFiles')}</span>
                </div>
              ) : files.length === 0 ? (
                <div className="tcm-empty">
                  <Icon name="file" size={32} />
                  <p>{t('tcm.noFiles')}</p>
                  <span>{t('tcm.noFilesHint')}</span>
                </div>
              ) : (
                <>
                  <div className="tcm-files-hint">
                    {t('tcm.filesHintPre')} <strong>{t('tcm.priority.skip')}</strong> {t('tcm.filesHintPost')}
                  </div>
                  <div className="tcm-files-list">
                    {files.map((file, idx) => {
                      const priority: FilePriority = file.priority || 'normal';
                      return (
                        <div key={idx} className={`tcm-file-row ${priority === 'skip' ? 'skipped' : ''}`}>
                          <div className="tcm-file-info">
                            <Icon name="file-text" size={14} />
                            <div className="tcm-file-details">
                              <span className="tcm-file-name" title={file.name}>{file.name}</span>
                              <span className="tcm-file-size">{formatBytes(file.length)}</span>
                            </div>
                          </div>
                          <div className="tcm-priority-btns">
                            {(['skip', 'low', 'normal', 'high'] as FilePriority[]).map(p => (
                              <button
                                key={p}
                                className={`tcm-priority-btn ${priority === p ? 'active' : ''}`}
                                style={priority === p ? { borderColor: FILE_PRIORITY_COLORS[p], color: FILE_PRIORITY_COLORS[p] } : {}}
                                disabled={savingPriority === idx}
                                onClick={() => handleFilePriority(idx, p)}
                                title={priorityLabel(p)}
                              >
                                {savingPriority === idx && priority !== p ? (
                                  <span className="spinner spinner-xs" />
                                ) : (
                                  priorityLabel(p)
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── PEERS TAB ── */}
          {tab === 'peers' && (
            <div className="tcm-section">
              {!peersLoaded ? (
                <div className="tcm-loading">
                  <span className="spinner" />
                  <span>{t('tcm.loadingPeers')}</span>
                </div>
              ) : peers.length === 0 ? (
                <div className="tcm-empty">
                  <Icon name="users" size={32} />
                  <p>{t('tcm.noPeers')}</p>
                  <span>{t('tcm.noPeersHint')}</span>
                </div>
              ) : (
                <>
                  <div className="tcm-peers-summary">
                    <span><strong>{peers.length}</strong> {t('share.peers')}</span>
                    <span className="tcm-peers-live"><span className="tcm-live-dot" /> {t('tcm.live')}</span>
                  </div>
                  <p className="tcm-peers-hint">{t('tcm.ban.hint')}</p>
                  <div className="tcm-peers-table">
                    <div className="tcm-peers-head">
                      <span className="pc-cc">{t('privacy.dash.location')}</span>
                      <span className="pc-addr">{t('tcm.colAddress')}</span>
                      <span className="pc-client">{t('tcm.colClient')}</span>
                      <span className="pc-flags">{t('tcm.colFlags')}</span>
                      <span className="pc-type">{t('tcm.colConn')}</span>
                      <span className="pc-prog">{t('common.done')}</span>
                      <span className="pc-spd">↓</span>
                      <span className="pc-spd">↑</span>
                    </div>
                    <div className="tcm-peers-body">
                      {peers.map((p) => (
                        <div
                          key={p.address}
                          className="tcm-peer-row"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setPeerMenu({ x: e.clientX, y: e.clientY, address: p.address });
                          }}
                        >
                          <span className="pc-cc" title={p.country || ''}>{p.country ? `${codeToFlag(p.country)} ${p.country}` : '—'}</span>
                          <span className="pc-addr mono" title={p.address}>{p.address}</span>
                          <span className="pc-client" title={p.client || t('tcm.unknown')}>{p.client || '—'}</span>
                          <span className="pc-flags mono" title={p.flagStr || ''}>{p.flagStr || '—'}</span>
                          <span className="pc-type">{CONN_LABELS[p.connType]}</span>
                          <span className="pc-prog">
                            <span className="pc-prog-bar"><span className="pc-prog-fill" style={{ width: `${Math.round(p.progress * 100)}%` }} /></span>
                            <span className="pc-prog-txt">{Math.round(p.progress * 100)}%</span>
                          </span>
                          <span className="pc-spd dn">{formatSpeed(p.downSpeed)}</span>
                          <span className="pc-spd up">{formatSpeed(p.upSpeed)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'pieces' && (
            <div className="tcm-section">
              {!piecesLoaded ? (
                <div className="tcm-loading">
                  <span className="spinner" />
                  <span>{t('tcm.loadingFiles')}</span>
                </div>
              ) : !pieces || pieces.pieceCount === 0 ? (
                <div className="tcm-empty">
                  <Icon name="grid" size={32} />
                  <p>{t('tcm.noPieces')}</p>
                  <span>{t('tcm.noPiecesHint')}</span>
                </div>
              ) : (
                <>
                  <div className="tcm-peers-summary">
                    <span>
                      <strong>{pieces.haveCount}</strong>
                      {' / '}
                      {pieces.pieceCount}
                      {' '}
                      {t('create.pieces')}
                    </span>
                    <span>{((pieces.haveCount / pieces.pieceCount) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="tcm-piece-map" role="img" aria-label={t('create.pieces')}>
                    {pieces.buckets.map((fill, i) => (
                      <span
                        key={i}
                        className="tcm-piece"
                        style={{ opacity: 0.12 + 0.88 * fill }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── TRACKERS TAB ── */}
          {tab === 'trackers' && (
            <div className="tcm-section">
              {/* Add tracker input */}
              <div className="tcm-add-tracker">
                <input
                  type="url"
                  className="tcm-tracker-input"
                  placeholder="udp://tracker.example.com:6969/announce"
                  value={newTrackerUrl}
                  onChange={e => setNewTrackerUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTracker(); }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={addingTracker}
                  disabled={!newTrackerUrl.trim()}
                  onClick={handleAddTracker}
                  icon={<Icon name="plus" size={14} />}
                >
                  {t('trackers.add')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={reannouncing}
                  onClick={() => { void handleReannounce(); }}
                  icon={<Icon name="refresh-cw" size={14} />}
                >
                  {t('tcm.reannounce')}
                </Button>
              </div>

              {loadingTrackers ? (
                <div className="tcm-loading">
                  <span className="spinner" />
                  <span>{t('trackers.loading')}</span>
                </div>
              ) : trackers.length === 0 ? (
                <div className="tcm-empty">
                  <Icon name="server" size={32} />
                  <p>{t('trackers.empty')}</p>
                  <span>{t('trackers.emptyHint')}</span>
                </div>
              ) : (
                <div className="tcm-tracker-list">
                  {trackers.map((tracker, idx) => {
                    const statusLabel = t(`trackers.status.${tracker.status}` as Parameters<typeof t>[0]);
                    return (
                    <div key={idx} className="tcm-tracker-row">
                      <div className="tcm-tracker-info">
                        <span
                          className={`tcm-tracker-dot ${tracker.status}`}
                          title={statusLabel}
                        />
                        <div className="tcm-tracker-details">
                          <span className="tcm-tracker-url" title={tracker.url}>{tracker.url}</span>
                          <span className="tcm-tracker-meta">
                            {tracker.peers} {t('trackers.peers')}
                            {tracker.lastAnnounce ? ` · ${relTime(tracker.lastAnnounce)}` : ''}
                          </span>
                        </div>
                      </div>
                      <button
                        className="tcm-tracker-remove"
                        onClick={() => handleRemoveTracker(tracker.url)}
                        title={t('trackers.remove')}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
    </Modal>
    {peerMenu && (
      <ContextMenu
        x={peerMenu.x}
        y={peerMenu.y}
        onClose={() => setPeerMenu(null)}
        items={peerHostToIPv4(peerMenu.address) === null
          ? [{
              label: t('tcm.ban.ipv4Only'),
              icon: 'slash',
              disabled: true,
              onClick: () => {},
            }]
          : [
              {
                label: t('tcm.ban.session'),
                icon: 'slash',
                onClick: () => { void handleBanPeer(peerMenu.address, false); },
              },
              {
                label: t('tcm.ban.persist'),
                icon: 'slash',
                danger: true,
                onClick: () => { void handleBanPeer(peerMenu.address, true); },
              },
            ]}
      />
    )}
    </>
  );
};

export default TorrentControlModal;
