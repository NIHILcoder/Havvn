/**
 * Settings UI primitives — the single row/card/field system every settings
 * section is built from. Replaces the old triple pattern (renderSettingItem
 * helper, PrivacySettings' local Row, hand-rolled markup) and the two toggle
 * implementations. Controls carry a min-width and rows stack cleanly at narrow
 * widths, so labels and controls never collide.
 */
import React from 'react';
import { Button, Icon, IconName } from '../../components';
import { NumberInput } from '../../components/NumberInput';
import { useTranslation } from '../../utils/i18nContext';
import './controls.css';

/** A titled group of setting rows. */
export const SettingsCard: React.FC<{
  title: string;
  icon?: IconName;
  description?: string;
  children: React.ReactNode;
}> = ({ title, icon, description, children }) => (
  <section className="stg-card">
    <header className="stg-card-h">
      {icon && <span className="stg-card-ic"><Icon name={icon} size={16} /></span>}
      <div className="stg-card-ht">
        <h3>{title}</h3>
        {description && <p>{description}</p>}
      </div>
    </header>
    <div className="stg-card-b">{children}</div>
  </section>
);

/** One setting: label + optional description on the left, a control on the right. */
export const SettingRow: React.FC<{
  label: string;
  description?: string;
  icon?: IconName;
  control: React.ReactNode;
  /** Widen the control column for multi-field controls (e.g. path + browse). */
  wide?: boolean;
  /**
   * Put the control on its OWN full-width line under the label. For controls
   * that are a layout in their own right (the theme preview cards): the side
   * column is ~300px at most, which is not enough for them, so side-by-side
   * either crushes them or stacks them into a lonely vertical strip.
   */
  stack?: boolean;
}> = ({ label, description, icon, control, wide, stack }) => (
  <div className={`stg-row${stack ? ' stg-row--stack' : ''}`}>
    <div className="stg-row-info">
      <div className="stg-row-label">
        {icon && <Icon name={icon} size={15} />}
        <span>{label}</span>
      </div>
      {description && <p className="stg-row-desc">{description}</p>}
    </div>
    <div className={`stg-row-ctl${wide ? ' wide' : ''}`}>{control}</div>
  </div>
);

/** Number input with an optional unit chip (KB/s, MB, min, …). */
export const NumberField: React.FC<{
  value: number;
  onChange: (n: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  ariaLabel?: string;
}> = ({ value, onChange, unit, min, max, step, width, ariaLabel }) => (
  <span className="stg-num">
    <NumberInput
      value={value}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      style={width ? { width } : undefined}
      onValueChange={(value) => onChange(value === '' ? 0 : parseFloat(value) || 0)}
    />
    {unit && <span className="stg-num-u">{unit}</span>}
  </span>
);

/** Single-line text input (paths, hosts, tokens). */
export const TextField: React.FC<{
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  mono?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, placeholder, mono, ariaLabel }) => (
  <input
    className={`stg-text${mono ? ' mono' : ''}`}
    type="text"
    value={value}
    placeholder={placeholder}
    aria-label={ariaLabel}
    onChange={(e) => onChange(e.target.value)}
  />
);

/**
 * "Change saved — applies after a restart" banner with the relaunch button.
 * The engine-picker restart pattern, shared by every restart-only setting
 * (styles live in SettingsPage.css under .engine-restart).
 */
export const RestartPendingNotice: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  return (
    <div className="engine-restart">
      <Icon name="alert-triangle" size={14} />
      <span>{text}</span>
      <Button variant="primary" size="sm" onClick={() => window.api.relaunchApp()}>
        {t('settings.engine.restartNow')}
      </Button>
    </div>
  );
};

/** Small status pill (olive = good/active, muted = neutral, ember = attention). */
export const StatusPill: React.FC<{
  children: React.ReactNode;
  tone?: 'ok' | 'muted' | 'accent';
}> = ({ children, tone = 'muted' }) => (
  <span className={`stg-pill stg-pill-${tone}`}>{children}</span>
);
