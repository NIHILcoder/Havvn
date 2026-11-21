import React from 'react';
import { useTranslation } from '../utils/i18nContext';
import { Icon } from './Icon';

export function PlayerTrackCatalogState({ status, empty, kind, onRetry }: {
  status: 'idle' | 'loading' | 'ready' | 'error'; empty: boolean; kind: 'audio' | 'subtitles'; onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status === 'ready' && !empty) return null;
  const loading = status === 'idle' || status === 'loading';
  return <div className="player-track-notice" role={status === 'error' ? 'alert' : 'status'}>
    <p>{t(loading ? 'player.tracksLoading' : status === 'error'
      ? kind === 'audio' ? 'player.audioLoadFailed' : 'player.subLoadFailed'
      : kind === 'audio' ? 'player.audioNone' : 'player.subNone')}</p>
    {!loading && <button type="button" className="player-sub-item" onClick={onRetry}><Icon name="refresh" size={13} />{t('common.retry')}</button>}
  </div>;
}
