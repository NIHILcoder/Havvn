import { ErrorMessage } from '../components/ErrorMessage';
import React, { useState } from 'react';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';
import { Select } from '../components/Select';
import { Input } from '../components/Input';
import { useTranslation } from '../utils/i18nContext';
import { MEDIA_LIBRARY_KINDS, normalizeMediaClassification, type MediaLibraryItem, type MediaLibraryKind, type MediaClassification } from '../../shared/media-library';

export function MediaLibraryEditor({ item, onSave, onClose }: { item: MediaLibraryItem; onSave: (value: MediaClassification | null) => boolean; onClose: () => void }) {
  const { t } = useTranslation(), initial = item.manual ?? item.inferred;
  const [kind, setKind] = useState<MediaLibraryKind>(initial.kind), [title, setTitle] = useState(initial.title);
  const [season, setSeason] = useState(initial.season === undefined ? '' : String(initial.season));
  const [episode, setEpisode] = useState(initial.episode === undefined ? '' : String(initial.episode));
  const [error, setError] = useState('');
  const save = (automatic = false) => {
    if (!automatic && kind === 'series' && [season, episode].some(value => value !== '' && !/^\d{1,4}$/.test(value))) { setError(t('library.invalid')); return; }
    const value = automatic ? null : normalizeMediaClassification({ kind, title, ...(kind === 'series' && season !== '' ? { season: Number(season) } : {}), ...(kind === 'series' && episode !== '' ? { episode: Number(episode) } : {}) });
    if (!automatic && !value) { setError(t('library.invalid')); return; }
    if (onSave(value)) onClose(); else setError(t('library.storageFailed'));
  };
  return <Modal title={t('library.edit')} onClose={onClose} size="md" footer={<>
    <Button variant="ghost" onClick={() => save(true)}>{t('library.automatic')}</Button>
    <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" onClick={() => save()}>{t('common.save')}</Button>
  </>}>
    <div className="media-library-editor">
      <label>{t('library.kind')}<Select value={kind} ariaLabel={t('library.kind')} options={MEDIA_LIBRARY_KINDS.map(value => ({ value, label: t(`library.kind.${value}`) }))} onChange={value => setKind(value as MediaLibraryKind)} /></label>
      <Input label={t('library.name')} value={title} maxLength={160} onChange={event => setTitle(event.target.value)} />
      {kind === 'series' && <div className="media-library-episode-fields">
        <Input label={t('library.season')} value={season} inputMode="numeric" maxLength={2} onChange={event => setSeason(event.target.value)} />
        <Input label={t('library.episode')} value={episode} inputMode="numeric" maxLength={4} onChange={event => setEpisode(event.target.value)} />
      </div>}
      <p>{t('library.editHint')}</p>
      {error && <p role="alert"><ErrorMessage error={error} /></p>}
    </div>
  </Modal>;
}
