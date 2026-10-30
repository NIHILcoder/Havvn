import { ErrorMessage } from '../../components/ErrorMessage';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RoomState } from '../../../shared/types';
import { validKeyRotationPlan } from '../../../shared/room-key-rotation';
import { Button, Modal } from '../../components';
import { NumberInput } from '../../components/NumberInput';
import { useTranslation } from '../../utils/i18nContext';
import { useHostWindow } from '../../utils/hostWindow';
import './RoomKeyRotationModal.css';

export function RoomKeyRotationModal({ room, onClose }: { room: RoomState; onClose: () => void }) {
  const { t } = useTranslation(), host = useHostWindow();
  const [intervalDraft, setIntervalDraft] = useState(String(room.keyRotation?.intervalMinutes ?? 60));
  const [repetitions, setRepetitions] = useState(String(room.keyRotation ? room.keyRotation.remaining ?? 0 : 1));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [current, setCurrent] = useState(room), operation = useRef(false);
  // A command's confirmed result stays useful until the corresponding live push arrives.
  useEffect(() => setCurrent(room), [room]);
  const schedule = current.keyRotation;
  const plan = { intervalMinutes: Number(intervalDraft), repetitions: Number(repetitions) };
  const disabled = busy || !room.canManage || !!room.kicked;
  async function run(action: 'now' | 'start' | 'stop') {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const state = action === 'now' ? await window.api.rooms.rotateKey(room.roomId)
        : await window.api.rooms.setKeyRotation(room.roomId, action === 'stop' ? null : plan);
      setCurrent(state);
      setNotice(t(action === 'now' ? 'rooms.keys.rotated' : action === 'stop' ? 'rooms.keys.stopped' : 'rooms.keys.scheduled'));
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { operation.current = false; setBusy(false); }
  }
  return createPortal(<Modal title={t('rooms.keys.title')} icon="lock" size="md" onClose={onClose} busy={busy}
    footer={<Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.close')}</Button>}>
    <div className="room-key-rotation">
      <p>{t('rooms.keys.explanation')}</p>
      <p className="room-key-rotation-note">{t('rooms.keys.voiceNote')}</p>
      <Button onClick={() => void run('now')} disabled={disabled}>{t('rooms.keys.now')}</Button>
      <fieldset disabled={disabled}>
        <legend>{t('rooms.keys.automatic')}</legend>
        <label>{t('rooms.keys.interval')}<NumberInput min={1} max={1440} step={1} value={intervalDraft} onValueChange={setIntervalDraft} aria-label={t('rooms.keys.interval')} /></label>
        <label>{t('rooms.keys.repetitions')}<NumberInput min={0} max={1000} step={1} value={repetitions} onValueChange={setRepetitions} aria-label={t('rooms.keys.repetitions')} /></label>
        <small>{t('rooms.keys.repeatHint')}</small>
        <Button variant="secondary" disabled={disabled || !intervalDraft || !repetitions || !validKeyRotationPlan(plan)} onClick={() => void run('start')}>{t('rooms.keys.start')}</Button>
      </fieldset>
      {schedule && <div className="room-key-rotation-status" role="status">
        <p>{schedule.error ? t('rooms.keys.paused') : t('rooms.keys.next').replace('{time}', new Date(schedule.nextAt).toLocaleString())}</p>
        <p>{t('rooms.keys.remaining').replace('{n}', schedule.remaining === null ? '∞' : String(schedule.remaining))}</p>
        {schedule.error && <p className="room-key-rotation-error"><ErrorMessage error={schedule.error} /></p>}
        <Button variant="secondary" disabled={disabled} onClick={() => void run('stop')}>{t('rooms.keys.stop')}</Button>
      </div>}
      <small>{t('rooms.keys.runtime')}</small>
      {notice && <p role="status">{notice}</p>}
      {error && <p className="room-key-rotation-error" role="alert"><ErrorMessage error={error} /></p>}
    </div>
  </Modal>, host.document.body);
}
