import React from 'react';
import type { RoomActionCheck } from '../../../shared/room-preflight';
import { useTranslation } from '../../utils/i18nContext';
import './RoomActionHint.css';

export function RoomActionHint({ check }: { check: RoomActionCheck }) {
  const { t } = useTranslation();
  if (check.status === 'supported') return null;
  return <p className="room-action-hint" data-room-action-status={check.status} role="status">
    <strong>{t(`rooms.preflight.status.${check.status}`)}</strong>
    <span>{t(`rooms.preflight.reason.${check.reason}`)} {t(`rooms.preflight.next.${check.next}`)}</span>
  </p>;
}
