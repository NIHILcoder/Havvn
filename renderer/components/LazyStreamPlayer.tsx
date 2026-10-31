import React, { lazy, Suspense } from 'react';
import { Modal } from './Modal';
import { useTranslation } from '../utils/i18nContext';
import type { StreamPlayerModalProps } from './StreamPlayerModal';

// Keep both the player and its dependent controls outside the downloads entry.
const Player = lazy(() => import('./StreamPlayerModal'));

export const StreamPlayerModal: React.FC<StreamPlayerModalProps> = props => {
  const { t } = useTranslation();
  return <Suspense fallback={<Modal title={props.downloadName} onClose={props.onClose}>
    <p role="status">{t('common.loading')}</p>
  </Modal>}>
    <Player {...props} />
  </Suspense>;
};
