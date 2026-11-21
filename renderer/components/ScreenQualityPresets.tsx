import React from 'react';
import { Button } from './Button';
import { useTranslation } from '../utils/i18nContext';
import { matchingScreenSharePreset, type ScreenShareSettings, type ScreenSharePreset } from '../../shared/screen-share';
import './ScreenQualityPresets.css';
export function ScreenQualityPresets({ settings, onChoose, disabled }: { settings: ScreenShareSettings; onChoose(id: ScreenSharePreset | 'manual'): void; disabled?: boolean }) {
  const { t } = useTranslation(), selected = matchingScreenSharePreset(settings);
  return <div className="screen-quality-presets" role="group" aria-label={t('rooms.screen.presets')}>
    {(['text', 'video', 'economy', 'manual'] as const).map(id => <Button key={id} size="sm" variant={id === selected ? 'primary' : 'secondary'} disabled={disabled} aria-pressed={id === selected} onClick={() => onChoose(id)}>{t(`rooms.screen.preset.${id}`)}</Button>)}
    <p>{t('rooms.screen.presetHint')}</p>
    <p role="status" data-screen-quality-summary>{settings.height}p · {settings.fps} FPS · {settings.bitrateKbps ? `${settings.bitrateKbps} ${t('rooms.screen.kbps')}` : t('rooms.screen.bitrateAuto')}</p>
  </div>;
}
