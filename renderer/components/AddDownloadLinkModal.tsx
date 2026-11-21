import React, { useId, useRef, useState } from 'react';
import { parseDownloadLink, type DownloadLink } from '../../shared/download-link';
import { Button } from './Button';
import { Modal } from './Modal';
import { useTranslation } from '../utils/i18nContext';
import './AddDownloadLinkModal.css';

export function AddDownloadLinkModal({ onConfirm, onClose }: { onConfirm: (link: DownloadLink) => void; onClose: () => void }) {
  const { t } = useTranslation(), id = useId();
  const [value, setValue] = useState(''), [error, setError] = useState(false);
  const submitted = useRef(false);
  return <Modal title={t('downloads.addLink')} icon="link" onClose={onClose}
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" type="submit" form={id + '-form'} disabled={!value.trim()}>{t('downloads.linkContinue')}</Button>
    </>}>
    <form id={id + '-form'} className="add-download-link" onSubmit={event => {
      event.preventDefault();
      if (submitted.current) return;
      const link = parseDownloadLink(value);
      if (!link) { setError(true); return; }
      submitted.current = true; onConfirm(link);
    }}>
      <p id={id + '-hint'}>{t('downloads.linkHint')}</p>
      <label htmlFor={id + '-input'}>{t('downloads.linkLabel')}</label>
      <input id={id + '-input'} className="input" type="text" inputMode="url" autoComplete="off" spellCheck={false}
        data-autofocus value={value} maxLength={10_000} placeholder="magnet:?xt=urn:btih:…"
        aria-invalid={error || undefined} aria-describedby={id + '-hint' + (error ? ' ' + id + '-error' : '')}
        onChange={event => { setValue(event.target.value); setError(false); }}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (!event.nativeEvent.isComposing && !event.repeat) event.currentTarget.form?.requestSubmit();
        }} />
      {error && <p id={id + '-error'} className="add-download-link-error" role="alert">{t('downloads.linkInvalid')}</p>}
    </form>
  </Modal>;
}
