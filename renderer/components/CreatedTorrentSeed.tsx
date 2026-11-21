import { ErrorMessage } from './ErrorMessage';
import React from 'react';
import type { CreateTorrentResult } from '../../shared/types';
import { useTranslation } from '../utils/i18nContext';
import { Button } from './Button';
import { Icon } from './Icon';
import './CreatedTorrentSeed.css';

export function CreatedTorrentSeed({ result, busy, disabled, onRetry }: {
  result: CreateTorrentResult; busy: boolean; disabled?: boolean; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const error = result.seedingError?.includes('TORRENT_SEED_RETRY_EXPIRED') ? t('create.seedRetryExpired')
    : result.seedingError?.includes('TORRENT_CREATION_BUSY') ? t('create.seedRetryBusy') : result.seedingError;
  if (result.seedingStatus === 'queued') return null;
  return <div className="created-torrent-seed">
    {result.seedingStatus === 'failed' && <div className="created-torrent-seed-warning" role="status">
      <strong>{t('create.savedSeedFailed')}</strong>{error && <span><ErrorMessage error={error} /></span>}
    </div>}
    {result.seedRetryId && <div className="created-torrent-seed-actions">
      <Button variant="secondary" size="sm" disabled={disabled} loading={busy} onClick={onRetry}
        icon={<Icon name={result.seedingStatus === 'failed' ? 'refresh' : 'upload'} size={16} />}>
        {t(busy ? 'create.retryingSeed' : result.seedingStatus === 'failed' ? 'create.retrySeed' : 'create.startSeed')}
      </Button>
    </div>}
    {busy && <p className="created-torrent-seed-progress" role="status">{t('create.verifyingSeed')}</p>}
  </div>;
}
