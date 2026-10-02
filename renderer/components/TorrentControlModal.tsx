/**
 * TorrentControlModal
 * Per-torrent advanced controls: sequential download, speed limits,
 * seed ratio/time, file priorities, tracker management.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Download, TorrentFile, TrackerInfo, FilePriority, PeerInfo, TorrentPieces } from '../../shared/types';
import { peerHostToIPv4 } from '../../shared/ip-range';
import { Button, Icon, IconName, Toggle } from './index';
import { NumberInput } from './NumberInput';
import { Modal } from './Modal';
import { ContextMenu } from './ContextMenu';
import { useConfirm } from './ConfirmDialog';
import { useTranslation } from '../utils/i18nContext';
import { cleanError } from '../utils/format-helpers';
import { classifyMediaKind } from '../../shared/media';
import { ExternalPlayerModal } from './ExternalPlayerModal';
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
  const [savedSequential, setSavedSequential] = useState(sequential);
  const [savingDownload, setSavingDownload] = useState(false);

  // Seeding tab state
  const [seedRatio, setSeedRatio] = useState(download.seedRatioLimit == null ? '' : String(download.seedRatioLimit));
  const [seedTime, setSeedTime] = useState(download.seedTimeLimitMinutes == null ? '' : String(download.seedTimeLimitMinutes));
  const [savedLimits, setSavedLimits] = useState({ ratio: download.seedRatioLimit, time: download.seedTimeLimitMinutes });
  const [ratioEdited, setRatioEdited] = useState(false);
  const [timeEdited, setTimeEdited] = useState(false);
  const [savingSeeding, setSavingSeeding] = useState(false);

  // Files tab state
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [externalFile, setExternalFile] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [savingPriority, setSavingPriority] = useState<{ index: number; priority: FilePriority } | null>(null);

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
  const [removingTracker, setRemovingTracker] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Tab, string>>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [savedNotice, setSavedNotice] = useState(false);
  const actionRef = useRef(false);
  const busy = savingDownload || savingSeeding || savingPriority !== null || moving || addingTracker || reannouncing || removingTracker !== null;
  const ratioNumber = Number(seedRatio);
  const timeNumber = Number(seedTime);
  const ratioDirty = ratioEdited && (savedLimits.ratio == null || ratioNumber !== savedLimits.ratio);
  const timeDirty = timeEdited && (savedLimits.time == null || timeNumber !== savedLimits.time);
  const ratioValid = (!ratioEdited && savedLimits.ratio == null) || (seedRatio.trim() !== '' && Number.isFinite(ratioNumber)
    && ratioNumber >= 0 && ratioNumber <= Number.MAX_SAFE_INTEGER);
  const timeValid = (!timeEdited && savedLimits.time == null) || (seedTime.trim() !== '' && Number.isSafeInteger(timeNumber) && timeNumber >= 0);
  const limitsValid = ratioValid && timeValid;
  const startAction = () => {
    if (actionRef.current) return false;
    actionRef.current = true;
    setSavedNotice(false);
    return true;
  };
  const showError = (err: unknown) => alert({ message: `${t('tcm.failed')}: ${cleanError(err)}` });

  // Poll the active tab only, without overlapping calls or accepting results
  // from an earlier tab. A failed request must not look like an empty list.
  useEffect(() => {
    if (tab === 'download' || tab === 'seeding') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoadingFiles(tab === 'files');
    setLoadingTrackers(tab === 'trackers');
    setPeersLoaded(false);
    setPiecesLoaded(false);
    const tick = async () => {
      try {
        if (tab === 'files') {
          const list = await window.api.historyPlayback.files(download.id);
          if (alive) setFiles(list || []);
        } else if (tab === 'trackers') {
          const list = await window.api.getTrackers(download.id);
          if (alive) setTrackers(list || []);
        } else if (tab === 'pieces') {
          const result = await window.api.getPieces(download.id);
          if (alive) setPieces(result);
        } else {
          const list = await window.api.getPeers(download.id);
          if (!alive) return;
          const hide = bannedIpsRef.current;
          setPeers((list || []).filter((p) => {
            const n = peerHostToIPv4(p.address);
            return n === null || !hide.has(n);
          }));
        }
        if (alive) setErrors(prev => ({ ...prev, [tab]: undefined }));
      } catch (err) {
        if (alive) setErrors(prev => ({ ...prev, [tab]: cleanError(err) }));
      } finally {
        if (alive) {
          setLoadingFiles(false); setLoadingTrackers(false);
          setPeersLoaded(true); setPiecesLoaded(true);
          timer = setTimeout(() => { void tick(); }, tab === 'peers' ? 1500 : 2500);
        }
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [tab, download.id, refreshKey]);

  const handleMoveData = async () => {
    if (!startAction()) return;
    setMoving(true);
    try {
      const dest = await window.api.selectDirectory();
      if (!dest) return;
      await window.api.setDownloadLocation(download.id, dest, true);
      onUpdate?.();
      setSavedNotice(true);
    } catch (err) {
      await showError(err);
    } finally {
      setMoving(false);
      actionRef.current = false;
    }
  };

  const handleReannounce = async () => {
    if (!startAction()) return;
    setReannouncing(true);
    try {
      await window.api.reannounceDownload(download.id);
      setRefreshKey(key => key + 1);
    } catch (err) {
      await showError(err);
    } finally {
      setReannouncing(false);
      actionRef.current = false;
    }
  };

  // Save download settings
  const handleSaveDownload = async () => {
    if (sequential === savedSequential || !startAction()) return;
    setSavingDownload(true);
    try {
      await window.api.setSequentialDownload(download.id, sequential);
      setSavedSequential(sequential);
      setSavedNotice(true);
      onUpdate?.();
    } catch (err) {
      await showError(err);
    } finally {
      setSavingDownload(false);
      actionRef.current = false;
    }
  };

  // Save seeding limits
  const handleSaveSeeding = async () => {
    if (!limitsValid || (!ratioDirty && !timeDirty) || !startAction()) return;
    setSavingSeeding(true);
    try {
      if (ratioDirty) {
        await window.api.setSeedRatioLimit(download.id, ratioNumber);
        setSavedLimits(prev => ({ ...prev, ratio: ratioNumber }));
        setRatioEdited(false);
      }
      if (timeDirty) {
        await window.api.setSeedTimeLimit(download.id, timeNumber);
        setSavedLimits(prev => ({ ...prev, time: timeNumber }));
        setTimeEdited(false);
      }
      setSavedNotice(true);
      onUpdate?.();
    } catch (err) {
      onUpdate?.();
      await showError(err);
    } finally {
      setSavingSeeding(false);
      actionRef.current = false;
    }
  };

  // Change file priority
  const handleFilePriority = async (fileIndex: number, priority: FilePriority) => {
    if (!startAction()) return;
    setSavingPriority({ index: fileIndex, priority });
    try {
      await window.api.setFilePriority(download.id, fileIndex, priority);
      setFiles(prev =>
        prev.map((f, i) => i === fileIndex ? { ...f, priority } : f)
      );
      setRefreshKey(key => key + 1);
      onUpdate?.();
    } catch (err) {
      await showError(err);
    } finally {
      setSavingPriority(null);
      actionRef.current = false;
    }
  };

  // Add tracker
  const handleAddTracker = async () => {
    if (!newTrackerUrl.trim() || !startAction()) return;
    setAddingTracker(true);
    try {
      await window.api.addTracker(download.id, newTrackerUrl.trim());
      setNewTrackerUrl('');
      setRefreshKey(key => key + 1);
    } catch (err) {
      await showError(err);
    } finally {
      setAddingTracker(false);
      actionRef.current = false;
    }
  };

  // Remove tracker
  const handleRemoveTracker = async (url: string) => {
    if (!startAction()) return;
    setRemovingTracker(url);
    try {
      await window.api.removeTracker(download.id, url);
      setTrackers(prev => prev.filter(t => t.url !== url));
      setRefreshKey(key => key + 1);
    } catch (err) {
      await showError(err);
    } finally {
      setRemovingTracker(null);
      actionRef.current = false;
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

  const tabs: { id: Tab; label: string; icon: IconName }[] = [
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
      busy={busy}
      className={`tcm-modal${tab === 'peers' ? ' tcm-modal-wide' : ''}`}
      bodyClassName="tcm-modal-body"
    >
        {/* Tabs */}
        <div className="tcm-tabs" role="tablist" aria-label={t('tcm.title')}>
          {tabs.map((t, index) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tcm-tab-${t.id}`}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              aria-controls="tcm-panel"
              disabled={busy}
              className={`tcm-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => { setTab(t.id); setSavedNotice(false); setPeerMenu(null); }}
              onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                setTab(tabs[next].id); setSavedNotice(false); setPeerMenu(null);
                (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
              }}
            >
              <Icon name={t.icon} size={14} />
              <span className="tcm-tab-label">{t.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="tcm-body" id="tcm-panel" role="tabpanel" aria-labelledby={`tcm-tab-${tab}`}>
          {errors[tab] && <div className="tcm-error" role="alert">
            <Icon name="alert-circle" size={16} />
            <span>{t('tcm.loadFailed')}: {errors[tab]}</span>
            <Button size="sm" variant="secondary" disabled={busy || (tab === 'files' ? loadingFiles : tab === 'trackers' ? loadingTrackers : tab === 'peers' ? !peersLoaded : !piecesLoaded)}
              onClick={() => setRefreshKey(key => key + 1)}>{t('downloads.retry')}</Button>
          </div>}

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
                <Toggle checked={sequential} disabled={busy} ariaLabel={t('tcm.sequential')}
                  onChange={value => { setSequential(value); setSavedNotice(false); }} />
              </div>

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
                  disabled={busy}
                  onClick={() => { void handleMoveData(); }}
                  icon={<Icon name="folder" size={14} />}
                >
                  {t('settings.choose')}
                </Button>
              </div>

              {/* Per-torrent speed limits were removed: webtorrent 1.9.7 only
                  throttles globally, so they never applied. Use the global /
                  alternative-speed limits in Settings instead. */}

              <div className="tcm-actions">
                <Button variant="primary" size="sm" loading={savingDownload} disabled={busy || sequential === savedSequential} onClick={handleSaveDownload}
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
                  <NumberInput
                    className="tcm-input"
                    min="0"
                    step="0.1"
                    value={seedRatio}
                    disabled={busy}
                    aria-label={t('tcm.seedRatioLimit')}
                    aria-invalid={!ratioValid}
                    placeholder={t('tcm.inherited')}
                    onValueChange={value => { setSeedRatio(value); setRatioEdited(true); setSavedNotice(false); }}
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
                  <NumberInput
                    className="tcm-input"
                    min="0"
                    step="1"
                    value={seedTime}
                    disabled={busy}
                    aria-label={t('tcm.seedTimeLimit')}
                    aria-invalid={!timeValid}
                    placeholder={t('tcm.inherited')}
                    onValueChange={value => { setSeedTime(value); setTimeEdited(true); setSavedNotice(false); }}
                  />
                  <span className="tcm-unit">{t('settings.unit.min')}</span>
                </div>
              </div>

              {((savedLimits.ratio == null && !ratioEdited) || (savedLimits.time == null && !timeEdited)) &&
                <p className="tcm-inherited">{t('tcm.inheritedHint')}</p>}
              {!limitsValid && <p className="tcm-error" role="alert">{t('tcm.invalidLimits')}</p>}
              {limitsValid && (ratioNumber > 0 || timeNumber > 0) && (
                <div className="tcm-preview-box">
                  <Icon name="zap" size={13} />
                  <span>
                    {t('tcm.seedingStopWhen')}{' '}
                    {ratioNumber > 0 && <strong>{t('settings.unit.ratio')} ≥ {seedRatio}</strong>}
                    {ratioNumber > 0 && timeNumber > 0 && <>{' '}{t('settings.or')}{' '}</>}
                    {timeNumber > 0 && <strong>{seedTime} {t('tcm.minElapsed')}</strong>}
                  </span>
                </div>
              )}

              <div className="tcm-actions">
                <Button variant="primary" size="sm" loading={savingSeeding} disabled={busy || !limitsValid || (!ratioDirty && !timeDirty)} onClick={handleSaveSeeding}
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
              ) : files.length === 0 ? (errors.files ? null :
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
                            {classifyMediaKind(file.path) !== 'other' && <Button size="sm" variant="ghost" iconOnly disabled={busy} title={t('external.title')} aria-label={t('external.title')} onClick={() => setExternalFile(file.path)} icon={<Icon name="external-link" size={14} />} />}
                            {(['skip', 'low', 'normal', 'high'] as FilePriority[]).map(p => (
                              <Button
                                key={p}
                                size="sm"
                                variant="secondary"
                                aria-pressed={priority === p}
                                className={`tcm-priority-btn ${priority === p ? 'active' : ''}`}
                                disabled={busy}
                                loading={savingPriority?.index === idx && savingPriority.priority === p}
                                onClick={() => handleFilePriority(idx, p)}
                                title={priorityLabel(p)}
                              >
                                {priorityLabel(p)}
                              </Button>
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
              ) : peers.length === 0 ? (errors.peers ? null :
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
                      <span className="pc-cc" title={t('tcm.colCountry')}>{t('tcm.colCountry')}</span>
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
              ) : !pieces || pieces.pieceCount === 0 ? (errors.pieces ? null :
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
                  disabled={busy}
                  aria-label={t('trackers.add')}
                  maxLength={2048}
                  onChange={e => setNewTrackerUrl(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTracker(); }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={addingTracker}
                  disabled={busy || !newTrackerUrl.trim()}
                  onClick={handleAddTracker}
                  icon={<Icon name="plus" size={14} />}
                >
                  {t('trackers.add')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={reannouncing}
                  disabled={busy}
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
              ) : trackers.length === 0 ? (errors.trackers ? null :
                <div className="tcm-empty">
                  <Icon name="server" size={32} />
                  <p>{t('trackers.empty')}</p>
                  <span>{t('trackers.emptyHint')}</span>
                </div>
              ) : (
                <div className="tcm-tracker-list">
                  {trackers.map((tracker) => {
                    const statusLabel = t(`trackers.status.${tracker.status}` as Parameters<typeof t>[0]);
                    return (
                    <div key={tracker.url} className="tcm-tracker-row">
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
                      <Button variant="ghost" size="sm" iconOnly
                        disabled={busy}
                        loading={removingTracker === tracker.url}
                        onClick={() => handleRemoveTracker(tracker.url)}
                        title={t('trackers.remove')}
                        aria-label={t('trackers.remove')}
                        icon={<Icon name="trash" size={14} />}
                      />
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {savedNotice && <p className="tcm-saved" role="status"><Icon name="check" size={14} />{t('tcm.saved')}</p>}
        </div>
    </Modal>
    {externalFile && <ExternalPlayerModal downloadId={download.id} relativePath={externalFile} onClose={() => setExternalFile(null)} />}
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
