import { ErrorMessage } from './ErrorMessage';
/**
 * ShareLinkModal
 *
 * Creates an "Instant Share Link" for a completed download: the file is
 * re-seeded over WebRTC and anyone can open the link in a browser to download
 * it — no client, no cloud. The app must stay open while people download.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { Button } from './Button';
import { QRCode } from './QRCode';
import { useTranslation } from '../utils/i18nContext';
import { ShareInfo } from '../../shared/types';
import './ShareLinkModal.css';
import { useClipboardCopy } from '../utils/useClipboardCopy';
import { useHostWindow } from '../utils/hostWindow';
import { writeClipboardText } from '../utils/clipboard';

interface ShareLinkModalProps {
  downloadId: string;
  downloadName: string;
  onClose: () => void;
}

const ShareLinkSession: React.FC<ShareLinkModalProps> = ({ downloadId, downloadName, onClose }) => {
  const { t } = useTranslation();
  const host = useHostWindow();
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const [peers, setPeers] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const pollRef = useRef<number | null>(null);
  const stopPending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

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
    let cancelled = false;
    const tick = async () => {
      try {
        const info = await window.api.shareGet(downloadId);
        if (!cancelled && info) setPeers(info.peers);
      } catch { /* ignore */ }
    };
    tick();
    pollRef.current = window.setInterval(tick, 4000);
    return () => { cancelled = true; if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [share, downloadId]);

  const { copy: handleCopy, copied, copying } = useClipboardCopy(share?.link ?? '', {
    writeText: text => writeClipboardText(text, host.window),
    onSuccess: () => setCopyFailed(false), onError: () => setCopyFailed(true),
  });

  const handleStop = useCallback(async () => {
    if (stopPending.current) return;
    stopPending.current = true;
    setStopping(true);
    setStopFailed(false);
    try {
      const result = await window.api.shareStop(downloadId);
      if (!result?.ok) throw new Error('Sharing did not stop');
      if (alive.current) onClose();
    } catch {
      if (alive.current) setStopFailed(true);
    } finally {
      stopPending.current = false;
      if (alive.current) setStopping(false);
    }
  }, [downloadId, onClose]);

  return (
    <Modal
      onClose={onClose}
      title={t('share.title')}
      icon="share-2"
      size="lg"
      busy={stopping}
      footer={
        <>
          {share && !error && (
            <Button variant="danger" icon={<Icon name="x-circle" size={14} />} onClick={handleStop} loading={stopping}>
              {t('share.stop')}
            </Button>
          )}
          <Button variant="primary" onClick={onClose} disabled={stopping}>{t('share.done')}</Button>
        </>
      }
    >
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
          <p><ErrorMessage error={error} /></p>
        </div>
      )}

      {share && !error && (
        <>
          {stopFailed && <p className="share-action-error" role="alert">{t('share.stopFailed')}</p>}
          <label className="share-label">{t('share.linkLabel')}</label>
          <div className="share-link-row">
            <input className="share-link-input" readOnly value={share.link} onFocus={(e) => e.target.select()} />
            <button className={`share-copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy} disabled={copying || stopping}>
              <Icon name="copy" size={14} />
              {copied ? t('share.copied') : t('share.copy')}
            </button>
          </div>
          {copyFailed && <p className="share-action-error" role="alert">{t('common.copyFailed')}</p>}

          <div className="share-status">
            <span className="share-live-dot" />
            <span>{t('share.live')}</span>
            <button className="share-qr-toggle" onClick={() => setShowQR(v => !v)}>
              <Icon name="grid" size={12} /> {showQR ? t('share.hideQr') : t('share.showQr')}
            </button>
            <span className="share-peers">
              <Icon name="users" size={12} /> {peers} {t('share.peers')}
            </span>
          </div>

          {showQR && (
            <div className="share-qr">
              <QRCode data={share.link} size={184} />
              <span className="share-qr-hint">{t('share.qrHint')}</span>
            </div>
          )}

          <div className="share-note">
            <Icon name="info" size={13} />
            <span>{t('share.note')}</span>
          </div>
        </>
      )}
    </Modal>
  );
};

export const ShareLinkModal: React.FC<ShareLinkModalProps> = props => <ShareLinkSession key={props.downloadId} {...props} />;

export default ShareLinkModal;
