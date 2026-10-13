import React, { useState } from 'react';
import { Button, Icon, Select } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import type { ConfigField } from '../../../shared/types';
import { CONFIG_PRESET_IDS, builtinConfigPreset, configPresetChanges, parseConfigPresets, presetValues, type ConfigPresetId } from '../../../shared/server-config-presets';

const KEY = 'serverConfigPresets.v1';
export const ServerConfigPresets: React.FC<{ schema: ConfigField[]; values: Record<string, string>; disabled: boolean; onApply: (values: Record<string, string>) => void }> = ({ schema, values, disabled, onApply }) => {
  const { t } = useTranslation(), toast = useHostToast();
  const [items, setItems] = useState(() => { try { return parseConfigPresets(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return []; } });
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const chosen = CONFIG_PRESET_IDS.includes(selected as ConfigPresetId) ? builtinConfigPreset(selected as ConfigPresetId, schema) : items.find(p => p.id === selected)?.values ?? {};
  const changes = configPresetChanges(values, chosen, schema);
  const persist = (next: typeof items) => {
    try { localStorage.setItem(KEY, JSON.stringify(next)); setItems(next); return true; }
    catch { toast.error(t('rooms.server.presets.saveFailed')); return false; }
  };
  const display = (field: ConfigField, value: string) => field.t === 'bool' ? t(value === 'true' ? 'rooms.server.presets.yes' : 'rooms.server.presets.no')
    : field.t === 'select' ? (() => { const option = field.options.find(o => o.value === value); return option ? t(option.labelKey as never) : value; })() : value;
  return <section className="server-config-presets">
    <strong><Icon name="layout-template" size={13} /> {t('rooms.server.presets.title')}</strong>
    <p>{t('rooms.server.presets.hint')}</p>
    <Select ariaLabel={t('rooms.server.presets.title')} disabled={disabled} value={selected} onChange={setSelected} options={[
      { value: '', label: t('rooms.server.presets.choose') },
      ...CONFIG_PRESET_IDS.map(value => ({ value, label: t(('rooms.server.presets.' + value) as never) })),
      ...items.map(p => ({ value: p.id, label: p.name })),
    ]} />
    {selected === 'modded' && <p>{t('rooms.server.presets.moddedHint')}</p>}
    {!!selected && <div className="server-preset-preview" aria-live="polite">
      {changes.length ? changes.map(({ field, before, after }) => <div key={field.key}><span>{t(field.labelKey as never)}</span><span>{display(field, before)} → <b>{display(field, after)}</b></span></div>) : <p>{t('rooms.server.presets.same')}</p>}
      <Button size="sm" variant="secondary" disabled={disabled || !changes.length} onClick={() => onApply({ ...values, ...presetValues(chosen, schema) })}>{t('rooms.server.presets.apply')}</Button>
    </div>}
    <div className="server-preset-save">
      <input aria-label={t('rooms.server.presets.name')} placeholder={t('rooms.server.presets.name')} maxLength={80} value={name} disabled={disabled} onChange={e => setName(e.target.value)} />
      <Button size="sm" variant="ghost" disabled={disabled || !name.trim() || items.length >= 12} onClick={() => {
        const next = [...items, { id: 'custom-' + Date.now(), name: name.trim(), values: presetValues(values, schema) }];
        if (persist(next)) { setName(''); toast.success(t('rooms.server.presets.saved')); }
      }}>{t('rooms.server.presets.save')}</Button>
      {selected.startsWith('custom-') && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => { if (persist(items.filter(p => p.id !== selected))) setSelected(''); }}>{t('rooms.workspace.delete')}</Button>}
    </div>
  </section>;
};
