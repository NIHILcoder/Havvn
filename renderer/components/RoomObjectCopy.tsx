import React from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { roomObjectLink, type RoomObjectLink } from '../../shared/room-object-links';
import { useTranslation } from '../utils/i18nContext';
import { useHostWindow } from '../utils/hostWindow';
import { useHostToast } from '../utils/hostToast';
export function RoomObjectCopy({ target }: { target: RoomObjectLink }) {
  const { t } = useTranslation(), host = useHostWindow(), toast = useHostToast();
  return <Button variant="ghost" size="sm" icon={<Icon name="link" size={13} />} onClick={() => {
    void (async () => { await host.window.navigator.clipboard.writeText(roomObjectLink(target)); })().then(() => toast.success(t('rooms.objects.copied'))).catch(() => toast.error(t('common.copyFailed')));
  }}>{t('rooms.objects.copy')}</Button>;
}
