import React, { useId } from 'react';
import { PROFILE_NAME_MAX, publicRoomName } from '../../shared/profile';
import { useTranslation } from '../utils/i18nContext';

export function RoomPublicNameField({ value, memberId, disabled, onChange, onSubmit }: {
  value: string; memberId: string; disabled?: boolean; onChange: (value: string) => void; onSubmit?: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className="rooms-public-name-field">
    <label htmlFor={id}>{t('rooms.publicName')}</label>
    <input id={id} className="rooms-input" autoComplete="nickname" value={value} maxLength={PROFILE_NAME_MAX}
      disabled={disabled} onChange={event => onChange(event.target.value)} aria-describedby={id + '-hint'}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.repeat && !disabled) { event.preventDefault(); onSubmit?.(); } }} />
    <p id={id + '-hint'} className="rooms-modal-desc">{t('rooms.publicNameHint')}
      {!value.trim() && <> {t('rooms.publicNameDefault').replace('{name}', publicRoomName('', memberId))}</>}
    </p>
  </div>;
}
