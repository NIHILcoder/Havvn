/**
 * Interface settings — appearance (theme, language) and interface behavior
 * (UI scale, reduced motion, compact settings density). The behavior prefs are
 * purely client-side: applied to <html> immediately and persisted in
 * localStorage; App.tsx re-applies them on boot.
 */
import React, { useState } from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow } from '../controls';
import { Select, ThemeSelector, Toggle, Button, Icon } from '../../../components';
import { useThemeEditor } from '../../../components/ThemeEditorContext';
import { useTranslation } from '../../../utils/i18nContext';
import { setSpeedUnits, getSpeedUnits, SpeedUnits } from '../../../utils/format-helpers';
import {
  currentAccent, setAccentPref, hasAccentOverride,
  currentFontId, setFontPref,
} from '../../../utils/theme-prefs';
import { FONT_OPTIONS } from '../../../../shared/theme';

const SCALE_OPTIONS = [90, 100, 110, 125] as const;

/** Safe localStorage read — the prefs are cosmetic, never let them throw. */
const readPref = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writePref = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* cosmetic */ }
};

const readScale = (): number => {
  const v = parseInt(readPref('uiScale') ?? '', 10);
  return (SCALE_OPTIONS as readonly number[]).includes(v) ? v : 100;
};

export const InterfaceSection: React.FC = () => {
  const ctx = useSettings();
  const { t, language, setLanguage } = useTranslation();

  const [uiScale, setUiScale] = useState<number>(readScale);
  const [reduceMotion, setReduceMotion] = useState<boolean>(() => readPref('reduceMotion') === '1');
  const [compact, setCompact] = useState<boolean>(() => readPref('density') === 'compact');
  const [startPage, setStartPage] = useState<string>(() => (readPref('startPage') === 'rooms' ? 'rooms' : 'downloads'));
  const [speedUnits, setSpeedUnitsState] = useState<SpeedUnits>(getSpeedUnits);
  const [accent, setAccent] = useState<string>(currentAccent);
  const [accentOn, setAccentOn] = useState<boolean>(hasAccentOverride);
  const [fontId, setFontId] = useState<string>(currentFontId);
  const { openEditor } = useThemeEditor();

  const applyScale = (scale: number) => {
    setUiScale(scale);
    // webFrame zoom, not CSS zoom: it scales the viewport too, so 100vh/100vw
    // layouts keep filling the window at any factor.
    window.api.setZoomFactor?.(scale / 100);
    writePref('uiScale', String(scale));
  };

  const applyStartPage = (page: string) => {
    setStartPage(page);
    writePref('startPage', page);
  };

  const applySpeedUnits = (units: SpeedUnits) => {
    setSpeedUnitsState(units);
    setSpeedUnits(units); // updates the module pref + persists; live values repaint on the next stats tick
  };

  const applyReduceMotion = (on: boolean) => {
    setReduceMotion(on);
    if (on) document.documentElement.dataset.reduceMotion = 'true';
    else delete document.documentElement.dataset.reduceMotion;
    writePref('reduceMotion', on ? '1' : '0');
  };

  const applyCompact = (on: boolean) => {
    setCompact(on);
    if (on) document.documentElement.dataset.density = 'compact';
    else delete document.documentElement.dataset.density;
    writePref('density', on ? 'compact' : 'normal');
  };

  const handleAccent = (hex: string) => {
    setAccent(hex);
    setAccentOn(true);
    setAccentPref(hex);
  };

  const handleAccentReset = () => {
    setAccentPref(null);
    setAccentOn(false);
    setAccent(currentAccent()); // reads back the base theme's own accent
  };

  const handleFont = (id: string) => {
    setFontId(id);
    setFontPref(id);
  };

  return (
    <>
      <SettingsCard title={t('settings.iface.appearance')} icon="sun">
        <SettingRow
          label={t('settings.theme')}
          description={t('settings.theme.desc')}
          wide
          control={<ThemeSelector currentTheme={ctx.theme} onThemeChange={ctx.handleThemeChange} />}
        />
        <SettingRow
          label={t('settings.iface.accent')}
          description={t('settings.iface.accent.desc')}
          control={
            <div className="accent-picker">
              <input
                type="color"
                className="accent-swatch"
                value={accent}
                onChange={(e) => handleAccent(e.target.value)}
                aria-label={t('settings.iface.accent')}
              />
              {accentOn && (
                <button type="button" className="accent-reset" onClick={handleAccentReset}>
                  {t('settings.iface.accent.reset')}
                </button>
              )}
            </div>
          }
        />
        <SettingRow
          label={t('settings.iface.font')}
          description={t('settings.iface.font.desc')}
          control={
            <div style={{ width: 170 }}>
              <Select
                options={FONT_OPTIONS.map((o) => ({ value: o.id, label: o.label, icon: 'type' }))}
                value={fontId}
                onChange={handleFont}
              />
            </div>
          }
        />
        <SettingRow
          label={t('settings.theme.customThemes')}
          description={t('settings.theme.customThemes.desc')}
          control={
            <Button variant="secondary" size="sm" icon={<Icon name="sun" size={15} />} onClick={openEditor}>
              {t('settings.theme.openEditor')}
            </Button>
          }
        />
        <SettingRow
          label={t('settings.language')}
          description={t('settings.language.desc')}
          control={
            <div style={{ width: 150 }}>
              <Select
                options={[
                  { value: 'en', label: 'English', icon: 'globe' },
                  { value: 'ru', label: 'Русский', icon: 'globe' }
                ]}
                value={language}
                onChange={(val) => setLanguage(val as 'en' | 'ru')}
              />
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard title={t('settings.iface.behavior')} icon="monitor">
        <SettingRow
          label={t('settings.iface.scale')}
          description={t('settings.iface.scale.desc')}
          control={
            <div className="iface-seg" role="group" aria-label={t('settings.iface.scale')}>
              {SCALE_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={uiScale === s ? 'active' : ''}
                  aria-pressed={uiScale === s}
                  onClick={() => applyScale(s)}
                >
                  {s}%
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          label={t('settings.iface.reduceMotion')}
          description={t('settings.iface.reduceMotion.desc')}
          control={
            <Toggle
              checked={reduceMotion}
              onChange={applyReduceMotion}
              ariaLabel={t('settings.iface.reduceMotion')}
            />
          }
        />
        <SettingRow
          label={t('settings.iface.compact')}
          description={t('settings.iface.compact.desc')}
          control={
            <Toggle
              checked={compact}
              onChange={applyCompact}
              ariaLabel={t('settings.iface.compact')}
            />
          }
        />
        <SettingRow
          label={t('settings.iface.startPage')}
          description={t('settings.iface.startPage.desc')}
          control={
            <div style={{ width: 170 }}>
              <Select
                options={[
                  { value: 'downloads', label: t('nav.downloads'), icon: 'download' },
                  { value: 'rooms', label: t('nav.rooms'), icon: 'users' },
                ]}
                value={startPage}
                onChange={applyStartPage}
              />
            </div>
          }
        />
        <SettingRow
          label={t('settings.iface.speedUnits')}
          description={t('settings.iface.speedUnits.desc')}
          control={
            <div style={{ width: 210 }}>
              <Select
                options={[
                  { value: 'binary', label: t('settings.iface.units.binary') },
                  { value: 'si', label: t('settings.iface.units.si') },
                  { value: 'bits', label: t('settings.iface.units.bits') },
                ]}
                value={speedUnits}
                onChange={(v) => applySpeedUnits(v as SpeedUnits)}
              />
            </div>
          }
        />
      </SettingsCard>
    </>
  );
};
