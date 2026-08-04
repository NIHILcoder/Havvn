/**
 * One settings control, generated from a module's ConfigField descriptor.
 *
 * Shared by the settings tab and the create form, which is the point: the create
 * form now asks for the four settings that are annoying to change after the first
 * boot, and those have to be the SAME controls with the same validation ranges and
 * the same translations as the settings tab. A second hand-rolled copy would drift
 * the first time a field grew a `warnKey`.
 *
 * EVERY STRING IS A TRANSLATION KEY. The module returns `labelKey` / `helpKey` /
 * `warnKey` / `placeholderKey` — never English prose — because it runs in the main
 * process, where there is no dictionary.
 *
 * `warn` renders a visible banner rather than a tooltip. It exists for settings
 * with a security consequence — Minecraft's `online-mode`, which turns off account
 * verification — and the user has to see WHY before flipping it, not afterwards
 * when someone has joined as them.
 */
import React from 'react';
import { Icon, Select, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import type { ConfigField } from '../../../shared/types';

interface ServerConfigFieldProps {
  field: ConfigField;
  value: string;
  disabled?: boolean;
  /** Namespaces the input id, so the same field can appear in two forms on one
   *  page without their labels pointing at each other's control. */
  idPrefix: string;
  onChange: (value: string) => void;
}

export const ServerConfigField: React.FC<ServerConfigFieldProps> = ({
  field, value, disabled = false, idPrefix, onChange,
}) => {
  const { t } = useTranslation();
  const id = `${idPrefix}-${field.key}`;

  return (
    // A boolean is a ROW — label left, switch right — because a switch sitting
    // under its own label reads as an unlabelled control with a heading.
    <div className={`server-config-field${field.t === 'bool' ? ' is-bool' : ''}`}>
      <label className="server-config-label" htmlFor={id}>
        {t(field.labelKey as never)}
      </label>

      {field.t === 'bool' ? (
        <Toggle
          checked={value === 'true'}
          disabled={disabled}
          ariaLabel={t(field.labelKey as never)}
          onChange={(checked) => onChange(checked ? 'true' : 'false')}
        />
      ) : field.t === 'select' ? (
        <Select
          value={value}
          disabled={disabled}
          options={field.options.map((o) => ({ value: o.value, label: t(o.labelKey as never) }))}
          onChange={onChange}
        />
      ) : field.t === 'int' ? (
        <input
          id={id}
          type="number"
          value={value}
          disabled={disabled}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          {...(field.placeholderKey ? { placeholder: t(field.placeholderKey as never) } : {})}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.helpKey && <p className="server-config-help">{t(field.helpKey as never)}</p>}
      {field.warnKey && (
        <p className="server-config-warn">
          <Icon name="alert-triangle" size={12} />
          {t(field.warnKey as never)}
        </p>
      )}
    </div>
  );
};
