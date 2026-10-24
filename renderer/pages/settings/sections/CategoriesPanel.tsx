import { ErrorMessage } from '../../../components/ErrorMessage';
import React, { useState } from 'react';
import type { Category, DownloadDefaults } from '../../../../shared/types';
import { validateCategory } from '../../../../shared/category-defaults';
import { useCategories, invalidateCategories } from '../../../utils/useCategories';
import { useTranslation } from '../../../utils/i18nContext';
import { Button, Icon, Select, useConfirm } from '../../../components';
import { NumberInput } from '../../../components/NumberInput';
import { InheritedBooleanSelect } from '../../../components/DownloadDefaultsPreview';
import { SettingsCard, SettingRow, TextField } from '../controls';
import { cleanError } from '../../../utils/format-helpers';
import { AutomationDraftModal } from '../../../components/AutomationDraftModal';
import { automationDraft, type AutomationDraft } from '../../../../shared/automation-draft';

const empty = (): Category => ({ id: 'new', name: '', icon: 'folder', color: '#ff6b2b', downloadDefaults: {} });
export const CategoriesPanel: React.FC = () => {
  const { t } = useTranslation(), { confirm } = useConfirm(), categories = useCategories();
  const [selected, setSelected] = useState('');
  const [automation, setAutomation] = useState<AutomationDraft | null>(null);
  const [draft, setDraft] = useState<Category>(empty);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const defaults = draft.downloadDefaults ?? {};
  const edit = (update: Partial<Category>) => { setDraft(current => ({ ...current, ...update })); setSaved(false); setError(''); };
  const setDefault = <K extends keyof DownloadDefaults>(key: K, value: DownloadDefaults[K]) => edit({ downloadDefaults: { ...defaults, [key]: value } });
  const choose = (id: string) => { setSelected(id); setDraft(structuredClone(categories.find(c => c.id === id) ?? empty())); setError(''); setSaved(false); };
  const save = async () => {
    if (busy) return;
    setError(''); setSaved(false);
    try {
      const validated = validateCategory(draft); setBusy(true);
      const { notificationRule: _notificationRule, ...owned } = validated;
      const result = selected ? await window.api.updateCategory(selected, owned) : await window.api.addCategory(owned);
      setSelected(result.id); setDraft(result); invalidateCategories(); setSaved(true);
    } catch (reason) { setError(cleanError(reason)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || busy || !await confirm({ message: t('category.defaults.deleteConfirm'), danger: true })) return;
    setBusy(true); setError('');
    try { await window.api.deleteCategory(selected); invalidateCategories(); choose(''); }
    catch (reason) { setError(cleanError(reason)); } finally { setBusy(false); }
  };
  return <SettingsCard title={t('category.defaults.title')} description={t('category.defaults.description')} icon="folder">
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <SettingRow label={t('category.defaults.edit')} control={<Select ariaLabel={t('category.defaults.edit')} value={selected} onChange={choose}
        options={[{ value: '', label: t('category.defaults.new') }, ...categories.map(c => ({ value: c.id, label: c.name, icon: c.icon }))]} />} />
      <SettingRow label={t('category.defaults.name')} control={<TextField value={draft.name} onChange={name => edit({ name })} ariaLabel={t('category.defaults.name')} />} />
      <SettingRow label={t('category.defaults.icon')} control={<Select value={draft.icon} onChange={icon => edit({ icon })} ariaLabel={t('category.defaults.icon')}
        options={[...(['folder', 'film', 'music', 'gamepad-2', 'book-open', 'file'] as const).map(icon => ({ value: icon, label: t(`category.defaults.icons.${icon}`), icon })),
          ...(!['folder', 'film', 'music', 'gamepad-2', 'book-open', 'file'].includes(draft.icon) ? [{ value: draft.icon, label: t('category.defaults.icons.current'), icon: draft.icon }] : [])]} />} />
      <SettingRow label={t('category.defaults.color')} control={<input className="category-color-input" type="color" aria-label={t('category.defaults.color')} value={draft.color.length === 4 ? '#' + [...draft.color.slice(1)].map(value => value + value).join('') : draft.color.slice(0, 7)} onChange={e => edit({ color: e.target.value })} />} />
      <SettingRow label={t('category.defaults.savePath')} description={t('category.defaults.pathHint')} wide control={<div className="stg-path">
        <TextField value={defaults.savePath ?? ''} onChange={value => setDefault('savePath', value || undefined)} placeholder={t('category.defaults.inherit')} ariaLabel={t('category.defaults.savePath')} />
        <Button variant="secondary" size="sm" icon={<Icon name="folder-open" size={14} />} onClick={async () => {
          try { const directory = await window.api.selectDirectory(); if (directory) setDefault('savePath', directory); } catch (reason) { setError(cleanError(reason)); }
        }}>{t('settings.choose')}</Button>
      </div>} />
      {(['seedRatioLimit', 'seedTimeLimitMinutes'] as const).map(key => <SettingRow key={key} label={t(`category.defaults.${key}`)} description={t('category.defaults.limitHint')}
        control={<span className="stg-num"><NumberInput style={{ width: 190 }} aria-label={t(`category.defaults.${key}`)} value={defaults[key] ?? ''} placeholder={t('category.defaults.inherit')} min={0} max={key === 'seedRatioLimit' ? 10000 : 52560000} step={key === 'seedRatioLimit' ? .1 : 1}
          onValueChange={value => setDefault(key, value === '' ? undefined : Number(value))} /></span>} />)}
      <SettingRow label={t('category.defaults.paused')} control={<InheritedBooleanSelect label={t('category.defaults.paused')} value={defaults.paused}
        onChange={value => setDefault('paused', value)} yes={t('category.defaults.paused')} no={t('category.defaults.active')} />} />
      <SettingRow label={t('category.defaults.sequentialDownload')} control={<InheritedBooleanSelect label={t('category.defaults.sequentialDownload')} value={defaults.sequentialDownload}
        onChange={value => setDefault('sequentialDownload', value)} yes={t('common.yes')} no={t('common.no')} />} />
      <div className="category-defaults-actions">
        {selected && <Button variant="secondary" onClick={() => { const category = categories.find(c => c.id === selected); if (category) setAutomation(automationDraft({ category }, crypto.randomUUID())); }}>{t('automation.from.category')}</Button>}
        <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
        <Button variant="secondary" onClick={() => edit({ downloadDefaults: {} })}>{t('category.defaults.reset')}</Button>
        {selected && <Button variant="danger" onClick={remove}>{t('common.delete')}</Button>}
      </div>
    </fieldset>
    {automation && <AutomationDraftModal draft={automation} onClose={() => setAutomation(null)} />}
    {error && <p role="alert"><ErrorMessage error={error} /></p>}{saved && <p role="status">{t('category.defaults.saved')}</p>}
  </SettingsCard>;
};
