/**
 * ShareLinkModal
 *
 * Creates an "Instant Share Link" for a completed download: the file is
 * re-seeded over WebRTC and anyone can open the link in a browser to download
 * it — no client, no cloud. The app must stay open while people download.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { ShareInfo } from '../../shared/types';
import './ShareLinkModal.css';

interface ShareLinkModalProps {
  downloadId: string;
  downloadName: string;
  onClose: () => void;
}

export const ShareLinkModal: React.FC<ShareLinkModalProps> = ({ downloadId, downloadName, onClose }) => {
  const { t } = useTranslation();
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [peers, setPeers] = useState(0);
  const [stopping, setStopping] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Start sharing as soon as the modal opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await window.api.shareStart(downloadId);
        if (cancelled) return;
        setShare(info);
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        const msg = String(err?.message || err);
        setError(/NOT_COMPLETE|must be complete/i.test(msg) ? t('share.notComplete') : msg);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [downloadId, t]);

  // Poll the peer count while the share is live.
  useEffect(() => {
    if (!share) return;
    const tick = async () => {
      try {
        const info = await window.api.shareGet(downloadId);
        if (info) setPeers(info.peers);
      } catch { /* ignore */ }
    };
    tick();
    pollRef.current = window.setInterval(tick, 4000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [share, downloadId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  }, [share]);

  const handleStop = useCallback(async () => {
    setStopping(true);
    try { await window.api.shareStop(downloadId); } catch { /* ignore */ }
    onClose();
  }, [downloadId, onClose]);

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="share-header">
          <div className="share-title">
            <span className="share-title-icon"><Icon name="share-2" size={15} /></span>
            <span className="share-title-text">{t('share.title')}</span>
          </div>
          <button className="share-close" onClick={onClose} title={t('share.close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="share-body">
          <div className="share-file" title={downloadName}>
            <Icon name="file" size={14} />
            <span>{downloadName}</span>
          </div>

          {loading && (
            <div className="share-state">
              <span className="spinner spinner-lg" />
              <p>{t('share.creating')}</p>
            </div>
          )}

          {error && (
            <div className="share-state share-state-error">
              <Icon name="alert-triangle" size={28} />
              <p>{error}</p>
            </div>
          )}

          {share && !error && (
            <>
              <label className="share-label">{t('share.linkLabel')}</label>
              <div className="share-link-row">
                <input className="share-link-input" readOnly value={share.link} onFocus={(e) => e.target.select()} />
                <button className={`share-copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
                  <Icon name={copied ? 'check' : 'copy'} size={14} />
                  {copied ? t('share.copied') : t('share.copy')}
                </button>
              </div>

              <div className="share-status">
                <span className="share-live-dot" />
                <span>{t('share.live')}</span>
                <span className="share-peers">
                  <Icon name="users" size={12} /> {peers} {t('share.peers')}
                </span>
              </div>

              <div className="share-note">
                <Icon name="info" size={13} />
                <span>{t('share.note')}</span>
              </div>
            </>
          )}
        </div>

        <div className="share-footer">
          {share && !error && (
            <button className="share-stop-btn" onClick={handleStop} disabled={stopping}>
              <Icon name="x-circle" size={14} /> {t('share.stop')}
            </button>
          )}
          <button className="share-done-btn" onClick={onClose}>{t('share.done')}</button>
        </div>
      </div>
    </div>
  );
};

export default ShareLinkModal;
