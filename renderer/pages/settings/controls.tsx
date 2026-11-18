/**
 * Settings UI primitives — the single row/card/field system every settings
 * section is built from. Replaces the old triple pattern (renderSettingItem
 * helper, PrivacySettings' local Row, hand-rolled markup) and the two toggle
 * implementations. Controls carry a min-width and rows stack cleanly at narrow
 * widths, so labels and controls never collide.
 */
import React, { useEffect, useId, useState } from 'react';
import { FieldLabelContext, useFieldLabel } from '../../utils/fieldLabel';
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
  <section className="stg-card" data-setting-label={title}>
    <header className="stg-card-h">
      {icon && <span className="stg-card-ic"><Icon name={icon} size={16} /></span>}
      <div className="stg-card-ht">
        <h2>{title}</h2>
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
}> = ({ label, description, icon, control, wide, stack }) => {
  const labelId = useId(), descriptionId = useId();
  return (
  <div className={`stg-row${stack ? ' stg-row--stack' : ''}`} data-setting-label={label}>
    <div className="stg-row-info">
      <div className="stg-row-label">
        {icon && <Icon name={icon} size={15} />}
        <span id={labelId}>{label}</span>
      </div>
      {description && <p id={descriptionId} className="stg-row-desc">{description}</p>}
    </div>
    <FieldLabelContext.Provider value={{ labelId, descriptionId: description ? descriptionId : undefined }}>
      <div className={`stg-row-ctl${wide ? ' wide' : ''}`} role="group" aria-labelledby={labelId} aria-describedby={description ? descriptionId : undefined}>{control}</div>
    </FieldLabelContext.Provider>
  </div>
  );
};

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
}> = ({ value, onChange, unit, min, max, step, width, ariaLabel }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
  <span className="stg-num">
    <NumberInput
      value={draft}
      aria-invalid={draft !== '' && (!Number.isFinite(Number(draft)) || Number(draft) < (min ?? -Infinity) || Number(draft) > (max ?? Infinity)) || undefined}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      style={width ? { width } : undefined}
      onValueChange={raw => {
        setDraft(raw);
        if (raw !== '' && Number.isFinite(Number(raw))) onChange(Number(raw));
      }}
      onBlur={() => {
        const n = draft.trim() === '' ? value : Number(draft);
        const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number.isFinite(n) ? n : value));
        setDraft(String(next));
        onChange(next);
      }}
    />
    {unit && <span className="stg-num-u">{unit}</span>}
  </span>
  );
};

/** Single-line text input (paths, hosts, tokens). */
export const TextField: React.FC<{
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  mono?: boolean;
  ariaLabel?: string;
}> = ({ value, onChange, placeholder, mono, ariaLabel }) => {
  const field = useFieldLabel();
  return (
  <input
    className={`stg-text${mono ? ' mono' : ''}`}
    type="text"
    value={value}
    placeholder={placeholder}
    aria-label={ariaLabel}
    aria-labelledby={ariaLabel ? undefined : field?.labelId}
    aria-describedby={field?.descriptionId}
    onChange={(e) => onChange(e.target.value)}
  />
  );
};

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
