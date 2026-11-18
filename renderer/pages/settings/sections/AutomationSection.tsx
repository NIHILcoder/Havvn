import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Select } from '../../../components/Select';
import { Toggle } from '../../../components/Toggle';
import { NumberInput } from '../../../components/NumberInput';
import { SettingsCard } from '../controls';
import { useTranslation } from '../../../utils/i18nContext';
import { useCategories } from '../../../utils/useCategories';
import { EMPTY_AUTOMATION, type AutomationConfig, type AutomationEvent, type AutomationInput, type AutomationPlan, type AutomationRule, type AutomationSnapshot } from '../../../../shared/automation-rules';
import type { DownloadDefaults, SourceType } from '../../../../shared/types';
import './AutomationSection.css';
import type { AutomationDraft } from '../../../../shared/automation-draft';
type Key = keyof typeof import('../../../i18n/en.json');

export function AutomationSection({ initialDraft, onDirtyChange, onBusyChange }: { initialDraft?: AutomationDraft; onDirtyChange?(dirty: boolean): void; onBusyChange?(busy: boolean): void } = {}) {
  const { t } = useTranslation(), categories = useCategories();
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null), [config, setConfig] = useState<AutomationConfig>(structuredClone(EMPTY_AUTOMATION));
  const [error, setError] = useState<Key | ''>(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [sample, setSample] = useState<AutomationInput>({ event: 'added', name: '', sourceType: 'magnet', explicitCategory: false, explicitDefaults: {} });
  const [preview, setPreview] = useState<AutomationPlan | null>(null);
  const draft = useRef(initialDraft).current;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const accept = (next: AutomationSnapshot) => { setSnapshot(next); setConfig(next.config); setDirty(false); setPreview(null); };
  useEffect(() => { let alive = true; void window.api.automation.get().then(next => { if (!alive) return; accept(next); if (draft) {
    if (next.config.rules.length >= 100) { setError('automation.from.limit'); return; }
    setConfig({ ...next.config, rules: [...next.config.rules, { ...draft.rule, enabled: false }] }); setSample(draft.sample); setDirty(true);
  } }).catch(() => { if (alive) setError('automation.loadError'); }); return () => { alive = false; }; }, [draft]);
  const update = (rules: AutomationRule[]) => { setConfig(previous => ({ ...previous, rules })); setDirty(true); setPreview(null); };
  const change = (index: number, patch: Partial<AutomationRule>) => update(config.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  const move = (index: number, by: number) => { const next = [...config.rules]; [next[index], next[index+by]] = [next[index+by],next[index]]; update(next); };
  const categoryOptions = (key: Key) => [{ value: '', label: t(key) }, ...categories.map(c => ({ value: c.id, label: c.name }))];
  const sourceOptions = [{ value: '', label: t('automation.anySource') }, ...(['magnet','torrent_file','catalog'] as const).map(value => ({ value, label: t(`automation.source.${value}`) }))];
  const events = (['added','completed'] as const).map(value => ({ value, label: t(`automation.event.${value}`) }));
  const defaults = (index: number, key: keyof DownloadDefaults, value: string) => {
    const current = { ...config.rules[index].actions.defaults };
    if (value === '') delete current[key];
    else Object.assign(current, { [key]: key === 'savePath' ? value : key === 'paused' || key === 'sequentialDownload' ? value === 'true' : Number(value) });
    change(index, { actions: { ...config.rules[index].actions, defaults: current } });
  };
  const perform = async (action: () => Promise<void>, failure: Key = 'automation.saveError') => { setBusy(true); setError(''); try { await action(); } catch { setError(failure); } finally { setBusy(false); } };
  return <div className="automation-section" data-automation-section>
    {error && <p role="alert">{t(error)}</p>}
    {!snapshot ? <SettingsCard title={t('automation.title')} icon="sliders" description={t('automation.description')}><p role="status">{t(error ? 'automation.unavailable' : 'common.loading')}</p></SettingsCard> : <>
      <SettingsCard title={t('automation.title')} icon="sliders" description={t('automation.description')}>
        <p className="automation-note">{t('automation.policy')}</p>
        {draft && <p className="automation-note" data-automation-draft>{t('automation.from.scope')}</p>}
        {snapshot.storage !== 'ready' && <p role="alert">{t('automation.unavailable')}</p>}
        <fieldset disabled={busy || snapshot.storage !== 'ready'}>
          <div className="automation-actions"><Button variant={config.rules.length ? 'secondary' : 'primary'} disabled={config.rules.length >= 100} onClick={() => update([...config.rules, { id: crypto.randomUUID(), version: 1, name: t('automation.newName'), enabled: false, event: 'added', conditions: {}, actions: { notify: true }, overrideExplicit: false }])}>{t('automation.add')}</Button></div>
          {config.rules.map((rule, index) => <details key={rule.id} className="automation-rule" data-rule-id={rule.id} open={config.rules.length === 1 ? true : undefined}>
            <summary><span>{index + 1}. {rule.name}</span><small>{t(rule.enabled ? 'automation.enabled' : 'automation.disabled')} · {t(`automation.event.${rule.event}`)}</small></summary>
            <div className="automation-grid">
              <label>{t('automation.ruleName')}<input className="stg-text" value={rule.name} maxLength={120} onChange={e => change(index, { name: e.target.value })} /></label>
              <label>{t('automation.eventLabel')}<Select ariaLabel={t('automation.eventLabel')} value={rule.event} options={events} onChange={value => change(index, { event: value as AutomationEvent, actions: { ...rule.actions, defaults: value === 'added' ? rule.actions.defaults : undefined } })} /></label>
              <label>{t('automation.nameContains')}<input className="stg-text" value={rule.conditions.nameContains ?? ''} maxLength={256} onChange={e => change(index, { conditions: { ...rule.conditions, nameContains: e.target.value || undefined } })} /></label>
              <label>{t('automation.sourceLabel')}<Select ariaLabel={t('automation.sourceLabel')} value={rule.conditions.sourceType ?? ''} options={sourceOptions} onChange={value => change(index, { conditions: { ...rule.conditions, sourceType: value as SourceType || undefined } })} /></label>
              <label>{t('automation.conditionCategory')}<Select ariaLabel={t('automation.conditionCategory')} value={rule.conditions.categoryId ?? ''} options={categoryOptions('automation.anyCategory')} onChange={value => change(index, { conditions: { ...rule.conditions, categoryId: value || undefined } })} /></label>
              <label>{t('automation.assignCategory')}<Select ariaLabel={t('automation.assignCategory')} value={rule.actions.categoryId ?? ''} options={categoryOptions('automation.keepCategory')} onChange={value => change(index, { actions: { ...rule.actions, categoryId: value || undefined } })} /></label>
            </div>
            <div className="automation-switches">
              <Toggle checked={rule.enabled} label={t('automation.enableRule')} onChange={enabled => change(index, { enabled })} />
              <Toggle checked={rule.actions.notify === true} label={t('automation.notify')} onChange={notify => change(index, { actions: { ...rule.actions, notify } })} />
              <Toggle checked={rule.overrideExplicit} label={t('automation.override')} onChange={overrideExplicit => change(index, { overrideExplicit })} />
            </div>
            {rule.event === 'added' && <div className="automation-grid automation-defaults">
              <p className="automation-wide automation-note">{t('automation.defaultsHint')}</p>
              <label className="automation-wide">{t('automation.field.savePath')}<input className="stg-text" value={rule.actions.defaults?.savePath ?? ''} placeholder={t('automation.inherit')} onChange={e => defaults(index, 'savePath', e.target.value)} /></label>
              {(['seedRatioLimit','seedTimeLimitMinutes'] as const).map(key => <label key={key}>{t(`automation.field.${key}`)}<NumberInput className="stg-text" aria-label={t(`automation.field.${key}`)} min={0} step={key === 'seedRatioLimit' ? 'any' : 1} value={rule.actions.defaults?.[key] ?? ''} placeholder={t('automation.inherit')} onValueChange={value => defaults(index, key, value)} /></label>)}
              {(['paused','sequentialDownload'] as const).map(key => <label key={key}>{t(`automation.field.${key}`)}<Select ariaLabel={t(`automation.field.${key}`)} value={String(rule.actions.defaults?.[key] ?? '')} options={[{value:'',label:t('automation.inherit')},{value:'true',label:t('automation.yes')},{value:'false',label:t('automation.no')}]} onChange={value => defaults(index,key,value)} /></label>)}
            </div>}
            <div className="automation-actions automation-rule-actions">
              <Button variant="secondary" size="sm" disabled={index === 0} onClick={() => move(index,-1)}>{t('automation.up')}</Button>
              <Button variant="secondary" size="sm" disabled={index === config.rules.length-1} onClick={() => move(index,1)}>{t('automation.down')}</Button>
              <Button variant="ghost" size="sm" onClick={() => update(config.rules.filter(r => r.id !== rule.id))}>{t('automation.remove')}</Button>
            </div>
          </details>)}
          <div className="automation-actions automation-footer">
            <Button disabled={!dirty} onClick={() => void perform(async () => accept(await window.api.automation.save(config)))}>{t('automation.save')}</Button>
            <Button variant="secondary" onClick={() => void perform(async () => accept(await window.api.automation.get()))}>{t('automation.reload')}</Button>
          </div>
        </fieldset>
      </SettingsCard>
      <SettingsCard title={t('automation.previewTitle')} icon="search" description={t('automation.previewHint')}>
        <fieldset disabled={busy || snapshot.storage !== 'ready'}>
          <div className="automation-grid">
            <label>{t('automation.sampleName')}<input className="stg-text" value={sample.name} maxLength={4096} onChange={e => {setSample({...sample,name:e.target.value});setPreview(null);}} /></label>
            <label>{t('automation.eventLabel')}<Select ariaLabel={t('automation.sampleEvent')} value={sample.event} options={events} onChange={value => {setSample({...sample,event:value as AutomationEvent});setPreview(null);}} /></label>
            <label>{t('automation.sourceLabel')}<Select ariaLabel={t('automation.sampleSource')} value={sample.sourceType} options={sourceOptions.filter(o => o.value)} onChange={value => {setSample({...sample,sourceType:value as SourceType});setPreview(null);}} /></label>
            <label>{t('automation.sampleCategory')}<Select ariaLabel={t('automation.sampleCategory')} value={sample.categoryId ?? ''} options={categoryOptions('automation.noCategory')} onChange={value => {setSample({...sample,categoryId:value||undefined,explicitCategory:!!value});setPreview(null);}} /></label>
          </div>
          {draft && <p className="automation-note">{t('automation.from.previewHint')}</p>}
          <div className="automation-actions automation-footer"><Button variant="secondary" onClick={() => void perform(async () => setPreview(await window.api.automation.preview(sample,config.rules.map(rule => rule.id === draft?.rule.id ? { ...rule, enabled: true } : rule))), 'automation.previewError')}>{t('automation.preview')}</Button></div>
        </fieldset>
        {preview && <div className="automation-result" role="status" data-automation-preview>
          <p>{t('automation.resultCategory')}: {categories.find(c=>c.id===preview.categoryId)?.name ?? t('automation.keepCategory')}</p>
          {Object.entries(preview.defaults).map(([key,value]) => <p key={key}>{t(`automation.field.${key}` as Key)}: {typeof value === 'boolean' ? t(value ? 'automation.yes' : 'automation.no') : String(value)}</p>)}
          <p>{t('automation.notificationRequests')}: {preview.notifyRules.length ? 1 : 0}</p>
          <ol>{preview.trace.map(trace => <li key={trace.ruleId}><strong>{trace.name}</strong><span>{trace.reasons.map(reason=>t(`automation.reason.${reason}`)).join(' · ')}</span>{trace.applied.length > 0 && <small>{t('automation.appliedFields')}: {trace.applied.map(key=>t(`automation.field.${key}` as Key)).join(', ')}</small>}</li>)}</ol>
        </div>}
      </SettingsCard>
      {snapshot.history.length > 0 && <SettingsCard title={t('automation.history')} icon="clock" description={t('automation.historyHint')}>
        <ol className="automation-history">{snapshot.history.map(({downloadId,receipt}) => <li key={receipt.id}>
          <p>{new Date(receipt.at).toLocaleString()} · {t(`automation.event.${receipt.event}`)} · {downloadId.slice(0,8)}</p>
          {receipt.runs.length === 0 && <span>{t('automation.noMatches')}</span>}
          {receipt.runs.map(run => <p key={run.key}><strong>{run.name} · v{run.version}</strong> — {t(`automation.state.${run.status}`)}{run.reason && ` · ${t(`automation.runReason.${run.reason}`)}`}</p>)}
          <details><summary>{t('automation.explanation')}</summary><ol>{receipt.plan.trace.map(trace=><li key={trace.ruleId}>{trace.name}: {trace.reasons.map(reason=>t(`automation.reason.${reason}`)).join(' · ')}</li>)}</ol></details>
          {receipt.runs.some(run=>run.status==='failed') && <div className="automation-actions"><Button variant="secondary" size="sm" disabled={busy} onClick={()=>void perform(async()=>{const next=await window.api.automation.retry(downloadId,receipt.event);setSnapshot(next);})}>{t('automation.retry')}</Button></div>}
        </li>)}</ol>
      </SettingsCard>}
    </>}
  </div>;
}
