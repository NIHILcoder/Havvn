import { ErrorMessage } from '../../../components/ErrorMessage';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Select, Toggle } from '../../../components';
import { Modal } from '../../../components/Modal';
import { useConfirm } from '../../../components/ConfirmDialog';
import { SettingRow } from '../controls';
import { useTranslation } from '../../../utils/i18nContext';
import { useDownloadViews } from '../../../utils/download-views';
import { loadAppearanceProfiles, APPEARANCE_PROFILES_EVENT } from '../../../utils/appearance-profiles';
import { APPEARANCE_EVENT } from '../../../utils/appearance';
import { refreshWorkingProfileUi, useWorkingProfiles, workingProfiles } from '../../../utils/working-profiles';
import { captureInterfacePreferences } from '../../../../shared/interface-preferences';
import { captureWorkingState, planWorkingProfile, resolveWorkingAppearance, workingDifferences, type WorkingProfilePlan } from '../../../../shared/working-profiles';
import { WorkingProfileError, WORKING_PROFILES_LIMIT, readProfileNotifications, type WorkingCheckpoint, type WorkingErrorCode } from '../../../../shared/working-profile-schema';
import type { AppSettings } from '../../../../shared/types';
import './WorkingProfilesPanel.css';

export const WorkingProfilesPanel: React.FC<{ settings: AppSettings; locked: boolean; lockReason?: string }> = ({ settings, locked, lockReason }) => {
  const { t } = useTranslation(), { confirm } = useConfirm(), state = useWorkingProfiles(), { catalog: views } = useDownloadViews();
  const [selected, setSelected] = useState(''), [name, setName] = useState(''), [appearanceName, setAppearanceName] = useState(''), [viewId, setViewId] = useState(views.activeId ?? '');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [editorTouched, setEditorTouched] = useState(false);
  const [preview, setPreview] = useState<WorkingProfilePlan | null>(null), [, repaint] = useState(0);
  const running = useRef(false), blocked = useRef(locked); blocked.current = locked;
  useEffect(() => {
    const refresh = () => repaint(value => value + 1);
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === 'havvn.appearance.profiles.v1') refresh(); };
    window.addEventListener(APPEARANCE_EVENT, refresh); window.addEventListener(APPEARANCE_PROFILES_EVENT, refresh); window.addEventListener('storage', storage);
    return () => { window.removeEventListener(APPEARANCE_EVENT, refresh); window.removeEventListener(APPEARANCE_PROFILES_EVENT, refresh); window.removeEventListener('storage', storage); };
  }, []);
  const profile = state.catalog.profiles.find(p => p.id === selected), appearanceProfiles = loadAppearanceProfiles();
  const profileDraft = profile ? name.trim() !== profile.name || (viewId || null) !== profile.values.viewId || (appearanceName || null) !== profile.values.appearanceName : editorTouched;
  const unavailable = state.error || locked || busy;
  const report = (cause: unknown) => {
    const fromIpc = cause instanceof Error ? /Working profile: (invalid|storage|name|duplicate|limit|missing|stale|draft)/.exec(cause.message)?.[1] : undefined;
    const code = cause instanceof WorkingProfileError ? cause.code : (fromIpc ?? 'storage') as WorkingErrorCode;
    setError(t(`working.error.${code}`)); setNotice('');
  };
  const choose = (id: string) => {
    const p = workingProfiles.getSnapshot().catalog.profiles.find(p => p.id === id);
    setSelected(id); setName(p?.name ?? ''); setAppearanceName(p?.values.appearanceName ?? ''); setViewId(p ? p.values.viewId ?? '' : views.activeId ?? '');
    setError(''); setNotice(''); setEditorTouched(false);
  };
  const save = async () => {
    if (running.current || blocked.current) return;
    running.current = true; setBusy(true); setError('');
    try {
      const notifications = readProfileNotifications(await window.api.getSettings());
      if (blocked.current) throw new WorkingProfileError('draft');
      const current = captureWorkingState(captureInterfacePreferences(localStorage), notifications);
      const id = workingProfiles.save(name, { ...current.values, viewId: viewId || null, appearanceName: appearanceName || null }, selected || undefined);
      setSelected(id); setName(name.trim()); setEditorTouched(false); setNotice(t('working.saved'));
    } catch (cause) { report(cause); } finally { running.current = false; setBusy(false); }
  };
  const inspect = async (id: string | null) => {
    if (running.current || blocked.current || profileDraft) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const notifications = readProfileNotifications(await window.api.getSettings());
      if (blocked.current) throw new WorkingProfileError('draft');
      setPreview(planWorkingProfile(captureInterfacePreferences(localStorage), notifications, id, 'work-preview'));
    } catch (cause) { report(cause); } finally { running.current = false; setBusy(false); }
  };
  const apply = async () => {
    if (!preview || running.current) return;
    if (blocked.current || profileDraft) { report(new WorkingProfileError('draft')); return; }
    running.current = true; setBusy(true); setError('');
    try {
      const result = await window.api.applyWorkingProfile(preview.request);
      if (!result.success) throw new WorkingProfileError('storage');
      setPreview(null); refreshWorkingProfileUi(); setNotice(t('working.applied'));
    } catch (cause) { report(cause); window.dispatchEvent(new Event('havvn:settings-transfer')); }
    finally { running.current = false; setBusy(false); }
  };
  let modified = false, currentUnavailable = false;
  const active = state.catalog.profiles.find(p => p.id === state.catalog.activeId);
  if (active) {
    try {
      const preferences = captureInterfacePreferences(localStorage), current = captureWorkingState(preferences, readProfileNotifications(settings));
      modified = workingDifferences(current, active.values, resolveWorkingAppearance(preferences, active.values)).length > 0;
      currentUnavailable = !!active.values.viewId && !views.views.some(view => view.id === active.values.viewId);
    } catch { currentUnavailable = true; }
  }
  const yesNo = (value: boolean) => t(value ? 'common.yes' : 'common.no');
  const format = (key: WorkingProfilePlan['differences'][number], item: WorkingCheckpoint) => {
    const v = item.values;
    if (key === 'startPage') return t(v.startPage === 'rooms' ? 'nav.rooms' : 'nav.downloads');
    if (key === 'viewId') return views.views.find(view => view.id === v.viewId)?.name ?? t(v.viewId ? 'working.missingReference' : 'working.noView');
    if (key === 'panels') return `${t('working.sidebar')}: ${yesNo(v.panels.sidebar)} · ${t('working.statusBar')}: ${yesNo(v.panels.statusBar)}`;
    if (key === 'appearance') return v.appearanceName ?? item.appearance.theme?.name ?? t(`working.mode.${item.appearance.mode}`);
    const n = v.notifications, p = n.notificationPolicy;
    const entries = (value: typeof n): Array<[string, string]> => {
      const policy = value.notificationPolicy;
      return [
        [t('notifications.rule.popups'), yesNo(value.enableNotifications)], [t('notifications.rule.sound'), yesNo(value.enableSounds)],
        [t('settings.notif.complete'), yesNo(value.notifyOnComplete)], [t('settings.notif.error'), yesNo(value.notifyOnError)],
        [t('notifications.showContent'), yesNo(policy.showContent)],
        [t('notifications.quiet'), `${yesNo(policy.quietHours.enabled)} (${policy.quietHours.start}–${policy.quietHours.end})`],
        [t('notifications.summaries'), `${yesNo(policy.summaries.enabled)} (${policy.summaries.windowSeconds} ${t('notifications.seconds')})`],
      ];
    };
    const before = new Map(entries(preview!.before.values.notifications)), after = new Map(entries(preview!.after.values.notifications));
    return entries({ ...n, notificationPolicy: p }).filter(([label]) => before.get(label) !== after.get(label)).map(([label, value]) => `${label}: ${value}`).join('\n');
  };
  const appearanceOptions = [{ value: '', label: t('working.keepAppearance') }, ...appearanceProfiles.map(p => ({ value: p.name, label: p.name }))];
  if (appearanceName && !appearanceProfiles.some(p => p.name === appearanceName)) appearanceOptions.push({ value: appearanceName, label: `${t('working.missingReference')}: ${appearanceName}` });
  const viewOptions = [{ value: '', label: t('working.noView') }, ...views.views.map(p => ({ value: p.id, label: p.name }))];
  const previousViewMissing = !!state.catalog.previous?.values.viewId && !views.views.some(p => p.id === state.catalog.previous!.values.viewId);
  if (viewId && !views.views.some(p => p.id === viewId)) viewOptions.push({ value: viewId, label: t('working.missingReference') });
  return <>
    <p className="working-hint">{t('working.hint')}</p>
    {state.error && <div><p role="alert">{t('working.error.storage')}</p><Button variant="secondary" disabled={locked || busy} onClick={async () => {
      if (!await confirm({ message: t('working.recoverConfirm'), danger: true })) return;
      try { workingProfiles.recover(); setError(''); setNotice(t('working.recovered')); } catch (cause) { report(cause); }
    }}>{t('working.recover')}</Button></div>}
    {locked && <p role="status">{lockReason ?? t('working.error.draft')}</p>}
    <p className="working-current" role="status">{t('working.current')}: {active?.name ?? t('working.custom')}{active && ` · ${t(currentUnavailable ? 'working.missingReference' : modified ? 'working.modified' : 'working.matches')}`}</p>
    <SettingRow label={t('working.sidebar')} control={<Toggle ariaLabel={t('working.sidebar')} disabled={unavailable} checked={state.panels.sidebar} onChange={value => { try { workingProfiles.setPanel('sidebar', value); } catch (cause) { report(cause); } }} />} />
    <SettingRow label={t('working.statusBar')} control={<Toggle ariaLabel={t('working.statusBar')} disabled={unavailable} checked={state.panels.statusBar} onChange={value => { try { workingProfiles.setPanel('statusBar', value); } catch (cause) { report(cause); } }} />} />
    <SettingRow label={t('working.select')} control={<Select ariaLabel={t('working.select')} value={selected} disabled={unavailable} onChange={choose} options={[{ value: '', label: t('working.new') }, ...state.catalog.profiles.map(p => ({ value: p.id, label: p.name }))]} />} />
    <SettingRow label={t('working.name')} control={<input className="stg-text" aria-label={t('working.name')} value={name} onChange={event => { setName(event.target.value); setEditorTouched(true); }} maxLength={60} disabled={unavailable} />} />
    <SettingRow label={t('working.view')} control={<Select ariaLabel={t('working.view')} value={viewId} disabled={unavailable} onChange={value => { setViewId(value); setEditorTouched(true); }} options={viewOptions} />} />
    <SettingRow label={t('working.appearance')} description={t('working.appearanceHint')} control={<Select ariaLabel={t('working.appearance')} value={appearanceName} disabled={unavailable} onChange={value => { setAppearanceName(value); setEditorTouched(true); }} options={appearanceOptions} />} />
    <p className="working-hint">{t('working.captureHint')}</p>
    <div className="working-actions">
      <Button variant="secondary" disabled={unavailable || !name.trim() || !selected && state.catalog.profiles.length >= WORKING_PROFILES_LIMIT} onClick={() => void save()}>{t(selected ? 'working.update' : 'working.save')}</Button>
      <Button variant="secondary" disabled={unavailable || !profile || state.catalog.profiles.length >= WORKING_PROFILES_LIMIT} onClick={() => {
        if (!profile) return;
        try {
          let index = 1, copyName = '';
          do { copyName = `${profile.name.slice(0, 46)} ${t('working.copy')} ${index++}`; } while (state.catalog.profiles.some(p => p.name.toLocaleLowerCase() === copyName.toLocaleLowerCase()));
          const id = workingProfiles.duplicate(profile.id, copyName); choose(id); setNotice(t('working.saved'));
        } catch (cause) { report(cause); }
      }}>{t('working.duplicate')}</Button>
      <Button variant="ghost" disabled={unavailable || !profile} onClick={async () => {
        if (!profile || !await confirm({ message: t('working.deleteConfirm'), danger: true })) return;
        try { workingProfiles.remove(profile.id); choose(''); setNotice(t('working.deleted')); } catch (cause) { report(cause); }
      }}>{t('common.delete')}</Button>
    </div>
    {profileDraft && <div><p className="working-hint" role="status">{t('working.profileDraft')}</p><Button variant="ghost" disabled={busy} onClick={() => choose(selected)}>{t('working.discardDraft')}</Button></div>}
    <div className="working-actions working-apply-actions">
      <Button variant="primary" icon={<Icon name="sliders" size={15} />} disabled={unavailable || profileDraft || !profile} onClick={() => void inspect(profile!.id)}>{t('working.preview')}</Button>
      <Button variant="secondary" disabled={unavailable || profileDraft || !state.catalog.previous} onClick={() => void inspect(null)}>{t('working.previous')}</Button>
    </div>
    {previousViewMissing && <div><p className="working-hint" role="status">{t('working.previousViewMissing')}</p><Button variant="secondary" disabled={unavailable} onClick={() => {
      try { workingProfiles.repairPreviousView(); setError(''); setNotice(t('working.previousRepaired')); } catch (cause) { report(cause); }
    }}>{t('working.repairPrevious')}</Button></div>}
    {error && <p role="alert"><ErrorMessage error={error} /></p>}{notice && <p role="status">{notice}</p>}
    {preview && <Modal className="working-preview" title={t('working.previewTitle')} onClose={() => { if (!busy) setPreview(null); }} busy={busy} size="md">
      <p className="working-hint">{t('working.previewHint')}</p>
      {!preview.differences.length && <p>{t('working.noChanges')}</p>}
      <dl className="working-differences">{preview.differences.map(key => <div key={key} data-working-difference={key}><dt>{t(`working.diff.${key}`)}</dt>
        <dd><span>{t('working.before')}: {format(key, preview.before)}</span><strong>{t('working.after')}: {format(key, preview.after)}</strong></dd></div>)}</dl>
      <div className="working-actions working-apply-actions"><Button variant="secondary" disabled={busy} onClick={() => setPreview(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={locked || profileDraft} loading={busy} onClick={() => void apply()}>{t('working.apply')}</Button></div>
      {error && <p role="alert"><ErrorMessage error={error} /></p>}
    </Modal>}
  </>;
};
