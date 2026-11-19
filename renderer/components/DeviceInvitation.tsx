import React, { useCallback, useEffect, useState } from 'react';
import { QRCode } from './QRCode';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
export function DeviceInvitation({ text, expiresAt }: { text: string; expiresAt: number | null }) {
  const { t } = useTranslation(), [show, setShow] = useState(false), [failed, setFailed] = useState(false), [copied, setCopied] = useState(false), [now, setNow] = useState(Date.now);
  const valid = expiresAt !== null && Number.isFinite(expiresAt) && expiresAt > now;
  const qrError = useCallback(() => setFailed(true), []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setShow(false); setFailed(false); setCopied(false); }, [text, expiresAt]);
  return <div className="device-invitation-card">
    <p>{t('devices.invite.secret')}</p><p role="status">{valid ? t('devices.invite.expires').replace('{seconds}', String(Math.max(0, Math.ceil((expiresAt! - now) / 1000)))) : t('devices.invite.expired')}</p>
    {valid && <><textarea className="input device-invitation" aria-label={t('devices.invite.text')} readOnly value={text} /><div className="device-actions">
      <Button onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(qrError); }}>{t(copied ? 'common.copied' : 'devices.invite.copy')}</Button>
      <Button variant="secondary" aria-expanded={show} onClick={() => setShow(value => !value)}>{t(show ? 'devices.invite.hideQr' : 'devices.invite.showQr')}</Button>
    </div></>}
    {valid && show && !failed && <div className="device-invitation-qr"><QRCode data={text} size={560} label={t('devices.invite.qrLabel')} onError={qrError} /><p>{t('devices.invite.qrHint')}</p></div>}
    {failed && <p role="alert">{t('devices.invite.qrError')}</p>}
  </div>;
}
