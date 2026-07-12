/**
 * Countdown modal for a fired on-completion action (sleep / shutdown / quit):
 * shows the live seconds until the deadline and a Cancel button. Driven by the
 * app:completionActionPending push from main; Cancel sets the action back to
 * 'none', which also runs `shutdown /a` when the OS shutdown timer was armed.
 */

import React, { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import type { CompletionPending } from '../../shared/types';

export const CompletionCountdown: React.FC<{
  pending: CompletionPending;
  onCancel: () => void;
}> = ({ pending, onCancel }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const secs = Math.max(0, Math.ceil((pending.deadline - now) / 1000));
  const title =
    pending.action === 'shutdown' ? t('app.onDone.shutdownTitle')
    : pending.action === 'sleep' ? t('app.onDone.sleepTitle')
    : t('app.onDone.quitTitle');

  return (
    <Modal
      size="sm"
      icon="power"
      title={title}
      onClose={onCancel}
      bodyClassName="um-body-plain"
      footer={
        <Button variant="danger" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      }
    >
      <p>{`${t('app.onDone.countdownPrefix')} ${secs} ${t('app.onDone.countdownSuffix')}`}</p>
    </Modal>
  );
};
