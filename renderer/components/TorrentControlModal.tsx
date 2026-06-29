/**
 * TorrentControlModal
 * Per-torrent advanced controls: sequential download, speed limits,
 * seed ratio/time, file priorities, tracker management.
 */

import React, { useState, useEffect } from 'react';
import { Download, TorrentFile, TrackerInfo, FilePriority, PeerInfo } from '../../shared/types';
import { Button, Icon } from './index';
import { useTranslation } from '../utils/i18nContext';
import './TorrentControlModal.css';

interface TorrentControlModalProps {
  download: Download;
  onClose: () => void;
  onUpdate?: () => void;
}

type Tab = 'download' | 'seeding' | 'files' | 'peers' | 'trackers';

const CONN_TYPE_LABEL: Record<PeerInfo['connType'], string> = {
  'tcp-in': 'TCP ↓', 'tcp-out': 'TCP ↑', 'utp-in': 'µTP ↓', 'utp-out': 'µTP ↑',
  'webrtc': 'WebRTC', 'web-seed': 'Web seed', 'other': '—',
};

const formatSpeed = (bps: number): string => (bps > 0 ? formatBytes(bps) + '/s' : '—');

const FILE_PRIORITY_LABELS: Record<FilePriority, string> = {
  skip: 'Skip',
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

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
  const [tab, setTab] = useState<Tab>('download');

  // Localized "Ns/Nm/Nh ago" for a tracker's last-announce timestamp.
  const relTime = (ts: number): string => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}${t('time.sec')} ${t('time.ago')}`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}${t('time.min')} ${t('time.ago')}`;
    return `${Math.round(m / 60)}${t('time.hour')} ${t('time.ago')}`;
  };

  // Download tab state
  const [sequential, setSequential] = useState(download.sequentialDownload ?? false);
  const [downKbps, setDownKbps] = useState(download.maxDownloadSpeed ?? 0);
  const [upKbps, setUpKbps] = useState(download.maxUploadSpeed ?? 0);
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
        .then((list) => { if (alive) { setPeers(list || []); setPeersLoaded(true); } })
        .catch(() => { if (alive) setPeersLoaded(true); });
    };
    tick();
    const iv = setInterval(tick, 1500);
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

  // Save download settings
  const handleSaveDownload = async () => {
    setSavingDownload(true);
    try {
      await window.api.setSequentialDownload(download.id, sequential);
      await window.api.setTorrentSpeedLimits(download.id, downKbps, upKbps);
      onUpdate?.();
    } catch (err: any) {
      alert(`Failed: ${err?.message}`);
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
      alert(`Failed: ${err?.message}`);
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
      alert(`Failed: ${err?.message}`);
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
      alert(`Failed: ${err?.message}`);
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
      alert(`Failed: ${err?.message}`);
    }
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'download', label: 'Download', icon: 'download' },
    { id: 'seeding', label: 'Seeding', icon: 'upload' },
    { id: 'files', label: 'Files', icon: 'file' },
    { id: 'peers', label: 'Peers', icon: 'users' },
    { id: 'trackers', label: t('trackers.tab'), icon: 'server' },
  ];

  return (
    <div className="tcm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tcm-modal">
        {/* Header */}
        <div className="tcm-header">
          <div className="tcm-title-row">
            <Icon name="settings" size={18} />
            <div className="tcm-title-text">
              <h2 className="tcm-title">Torrent Controls</h2>
              <p className="tcm-subtitle" title={download.name}>{download.name}</p>
            </div>
          </div>
          <button className="tcm-close" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="tcm-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`tcm-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon as any} size={15} />
              {t.label}
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
                  <span className="tcm-field-label">Sequential Download</span>
                  <span className="tcm-field-desc">
                    Download pieces in order — good for media files you want to preview.
                    May reduce overall speed.
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

              {/* Speed limits */}
              <div className="tcm-group-label">SPEED LIMITS (per-torrent)</div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="arrow-down" size={13} />
                    Download Speed
                  </span>
                  <span className="tcm-field-desc">0 = use global limit or unlimited</span>
                </div>
                <div className="tcm-speed-input">
                  <input
                    type="number"
                    className="tcm-input"
                    min="0"
                    value={downKbps}
                    onChange={e => setDownKbps(parseInt(e.target.value) || 0)}
                  />
                  <span className="tcm-unit">KB/s</span>
                </div>
              </div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="arrow-up" size={13} />
                    Upload Speed
                  </span>
                  <span className="tcm-field-desc">0 = use global limit or unlimited</span>
                </div>
                <div className="tcm-speed-input">
                  <input
                    type="number"
                    className="tcm-input"
                    min="0"
                    value={upKbps}
                    onChange={e => setUpKbps(parseInt(e.target.value) || 0)}
                  />
                  <span className="tcm-unit">KB/s</span>
                </div>
              </div>

              <div className="tcm-actions">
                <Button variant="primary" loading={savingDownload} onClick={handleSaveDownload}
                  icon={<Icon name="check" size={15} />}>
                  Apply
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
                  These override the global defaults for this torrent only.
                  Set to <strong>0</strong> to use global defaults.
                </span>
              </div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="percent" size={13} />
                    Seed Ratio Limit
                  </span>
                  <span className="tcm-field-desc">Stop seeding when upload/download ratio reaches this value</span>
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
                  <span className="tcm-unit">ratio</span>
                </div>
              </div>

              <div className="tcm-field">
                <div className="tcm-field-info">
                  <span className="tcm-field-label">
                    <Icon name="clock" size={13} />
                    Seed Time Limit
                  </span>
                  <span className="tcm-field-desc">Stop seeding after this many minutes of seeding</span>
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
                  <span className="tcm-unit">min</span>
                </div>
              </div>

              {(seedRatio > 0 || seedTime > 0) && (
                <div className="tcm-preview-box">
                  <Icon name="zap" size={13} />
                  <span>
                    Seeding will stop when{' '}
                    {seedRatio > 0 && <strong>ratio ≥ {seedRatio}</strong>}
                    {seedRatio > 0 && seedTime > 0 && ' or '}
                    {seedTime > 0 && <strong>{seedTime} min elapsed</strong>}
                  </span>
                </div>
              )}

              <div className="tcm-actions">
                <Button variant="primary" loading={savingSeeding} onClick={handleSaveSeeding}
                  icon={<Icon name="check" size={15} />}>
                  Apply
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
                  <span>Loading files...</span>
                </div>
              ) : files.length === 0 ? (
                <div className="tcm-empty">
                  <Icon name="file" size={32} />
                  <p>No files found for this torrent.</p>
                  <span>File list is only available while the torrent is active.</span>
                </div>
              ) : (
                <>
                  <div className="tcm-files-hint">
                    Set priority for each file. <strong>Skip</strong> prevents the file from downloading.
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
                                title={FILE_PRIORITY_LABELS[p]}
                              >
                                {savingPriority === idx && priority !== p ? (
                                  <span className="spinner spinner-xs" />
                                ) : (
                                  FILE_PRIORITY_LABELS[p]
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
                  <span>Loading peers...</span>
                </div>
              ) : peers.length === 0 ? (
                <div className="tcm-empty">
                  <Icon name="users" size={32} />
                  <p>No connected peers.</p>
                  <span>Peers appear here while the torrent is active and connecting.</span>
                </div>
              ) : (
                <>
                  <div className="tcm-peers-summary">
                    <span><strong>{peers.length}</strong> connected</span>
                    <span className="tcm-peers-live"><span className="tcm-live-dot" /> live</span>
                  </div>
                  <div className="tcm-peers-table">
                    <div className="tcm-peers-head">
                      <span className="pc-addr">Address</span>
                      <span className="pc-client">Client</span>
                      <span className="pc-type">Conn</span>
                      <span className="pc-prog">Done</span>
                      <span className="pc-spd">↓</span>
                      <span className="pc-spd">↑</span>
                    </div>
                    <div className="tcm-peers-body">
                      {peers.map((p) => (
                        <div key={p.address} className="tcm-peer-row">
                          <span className="pc-addr mono" title={p.address}>{p.address}</span>
                          <span className="pc-client" title={p.client || 'Unknown'}>{p.client || '—'}</span>
                          <span className="pc-type">{CONN_TYPE_LABEL[p.connType]}</span>
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
      </div>
    </div>
  );
};

export default TorrentControlModal;
