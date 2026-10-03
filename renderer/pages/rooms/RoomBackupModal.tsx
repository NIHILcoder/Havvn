import { createPortal } from 'react-dom';
import { useHostWindow } from '../../utils/hostWindow';
import React, { useRef, useState } from 'react';
import { Button, Modal, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import './RoomDataModal.css';

export function RoomBackupModal({ mode, roomId, onClose, onDone }: { roomId?: string; mode: 'export' | 'import'; onClose: () => void; onDone?: (rooms?: number) => void }) {
  const host = useHostWindow();
  const { t } = useTranslation();
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [restored, setRestored] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const importing = mode === 'import';
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      if (importing) {
        const result = await window.api.rooms.importIdentity(password);
        if (result.success) { setPassword(''); setRepeat(''); setRestored(true); onDone?.(result.rooms); }
      } else {
        const result = await window.api.rooms.exportIdentity(password, roomId);
        if (result.success) { setPassword(''); setRepeat(''); onDone?.(); onClose(); }
      }
    } catch (cause) { setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return createPortal(<Modal title={t(importing ? 'rooms.data.restore' : 'rooms.data.backup')} icon="shield" size="md" onClose={onClose} busy={busy || restored}
    footer={restored ? <Button variant="primary" onClick={() => { void window.api.relaunchApp().catch(cause => setError(String(cause))); }}>{t('rooms.data.restart')}</Button>
      : <><Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} disabled={password.length < 12 || password.length > 1024 || !approved || !importing && password !== repeat} onClick={run}>{t(importing ? 'rooms.data.restore' : 'rooms.data.backup')}</Button></>}>
    <div className="room-data-panel">
      <p>{t(restored ? 'rooms.data.restored' : importing ? 'rooms.data.restoreHint' : roomId ? 'rooms.data.roomBackupHint' : 'rooms.data.backupHint')}</p>
      {!restored && <>
        <label>{t('rooms.data.password')}<input type="password" autoComplete="off" value={password} minLength={12} maxLength={1024} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {!importing && <label>{t('rooms.data.repeatPassword')}<input type="password" autoComplete="off" value={repeat} maxLength={1024} disabled={busy} onChange={event => setRepeat(event.target.value)} aria-invalid={!!repeat && repeat !== password} /></label>}
        <label className="room-data-toggle"><Toggle checked={approved} disabled={busy} onChange={setApproved} ariaLabel={t(importing ? 'rooms.data.restoreConsent' : 'rooms.data.backupConsent')} /><span>{t(importing ? 'rooms.data.restoreConsent' : 'rooms.data.backupConsent')}</span></label>
      </>}
      {error && <div role="alert" className="room-data-error">{error}</div>}
    </div>
  </Modal>, host.document.body);
}
