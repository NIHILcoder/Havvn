import { ErrorMessage } from '../../../components/ErrorMessage';
import React, { useEffect, useState } from 'react';
import type { AppSettings, RoomSummary } from '../../../../shared/types';
import { DEFAULT_NOTIFICATION_POLICY, resolveNotificationPolicy, validateNotificationPolicy, type NotificationKind, type NotificationRule } from '../../../../shared/notification-policy';
import { Button, Select, Toggle } from '../../../components';
import { InheritedBooleanSelect } from '../../../components/DownloadDefaultsPreview';
import { useCategories, invalidateCategories } from '../../../utils/useCategories';
import { useTranslation } from '../../../utils/i18nContext';
import { cleanError } from '../../../utils/format-helpers';
import { SettingsCard, SettingRow, NumberField } from '../controls';
import './NotificationPolicyPanel.css';

export const NotificationPolicyPanel: React.FC<{ settings: AppSettings; onSaved(settings: AppSettings): void }> = ({ settings, onSaved }) => {
  const { t } = useTranslation(), categories = useCategories();
  const [policy, setPolicy] = useState(() => structuredClone(settings.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY));
  const [rooms, setRooms] = useState<RoomSummary[]>([]), [roomsFailed, setRoomsFailed] = useState(false);
  const [scope, setScope] = useState('global'), [categoryId, setCategoryId] = useState(''), [roomId, setRoomId] = useState('');
  const [rule, setRule] = useState<NotificationRule>({}), [mode, setMode] = useState<'all' | 'mentions' | 'off'>('all');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<'policy' | 'rule' | null>(null);
  const [now, setNow] = useState(() => new Date());
  const category = categories.find(item => item.id === categoryId), room = rooms.find(item => item.roomId === roomId);
  useEffect(() => setPolicy(structuredClone(settings.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY)), [settings.notificationPolicy]);
  useEffect(() => {
    let active = true;
    window.api.rooms.list().then(value => { if (active) setRooms(value); }).catch(() => { if (active) setRoomsFailed(true); });
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    setRule(structuredClone(scope === 'room' ? room?.notificationRule ?? {} : category?.notificationRule ?? {}));
    setMode(room?.notifyMode ?? (room?.notifyMuted ? 'off' : 'all')); setError('');
  }, [scope, category, room]);
  let validPolicy: ReturnType<typeof validateNotificationPolicy> | undefined;
  try { validPolicy = validateNotificationPolicy(policy); } catch { /* Draft may contain an unfinished time. */ }
  const [sample, setSample] = useState<NotificationKind>('download-complete');
  const kind = scope === 'room' ? 'room-message' : sample;
  const decision = validPolicy ? resolveNotificationPolicy({ kind, ...(scope === 'room' ? { roomId } : {}) }, {
    settings: { ...settings, notificationPolicy: validPolicy }, categoryRule: scope === 'category' ? rule : undefined,
    roomRule: scope === 'room' ? rule : undefined, roomMode: scope === 'room' ? mode : undefined,
  }, now) : null;
  const policyDirty = JSON.stringify(policy) !== JSON.stringify(settings.notificationPolicy ?? DEFAULT_NOTIFICATION_POLICY);
  const dirty = () => { setSaved(null); setError(''); };
  const save = async () => {
    if (busy) return;
    setBusy(true); setSaved(null); setError('');
    try {
      const result = await window.api.updateSettings({ notificationPolicy: validateNotificationPolicy(policy) });
      onSaved(result); setSaved('policy');
    } catch (reason) { setError(cleanError(reason)); } finally { setBusy(false); }
  };
  const saveRule = async () => {
    if (busy) return;
    setBusy(true); setSaved(null); setError('');
    try {
      if (scope === 'category' && category) { await window.api.updateCategory(category.id, { notificationRule: rule }); invalidateCategories(); }
      else if (scope === 'room' && room) {
        await window.api.rooms.setNotificationRule(room.roomId, rule, mode);
        setRooms(current => current.map(item => item.roomId === room.roomId ? { ...item, notificationRule: rule, notifyMode: mode, notifyMuted: mode === 'off' } : item));
      } else throw new Error(t('notifications.chooseTarget'));
      setSaved('rule');
    } catch (reason) { setError(cleanError(reason)); } finally { setBusy(false); }
  };
  return <>
    <SettingsCard title={t('notifications.policyTitle')} icon="bell" description={t('notifications.policyHint')}>
      <fieldset disabled={busy} className="notification-fields">
        <SettingRow label={t('notifications.showContent')} description={t('notifications.showContentHint')} control={<Toggle ariaLabel={t('notifications.showContent')} checked={policy.showContent} onChange={value => { setPolicy({ ...policy, showContent: value }); dirty(); }} />} />
        <SettingRow label={t('notifications.quiet')} description={t('notifications.quietHint')} control={<Toggle ariaLabel={t('notifications.quiet')} checked={policy.quietHours.enabled}
          onChange={enabled => { setPolicy({ ...policy, quietHours: { ...policy.quietHours, enabled } }); dirty(); }} />} />
        <SettingRow label={t('notifications.quietTimes')} wide control={<div className="notification-times">
          <label>{t('notifications.from')}<input className="stg-text" type="time" aria-label={t('notifications.from')} value={policy.quietHours.start} onChange={event => { setPolicy({ ...policy, quietHours: { ...policy.quietHours, start: event.target.value } }); dirty(); }} /></label>
          <label>{t('notifications.to')}<input className="stg-text" type="time" aria-label={t('notifications.to')} value={policy.quietHours.end} onChange={event => { setPolicy({ ...policy, quietHours: { ...policy.quietHours, end: event.target.value } }); dirty(); }} /></label>
        </div>} />
        <SettingRow label={t('notifications.summaries')} description={t('notifications.summariesHint')} control={<Toggle ariaLabel={t('notifications.summaries')} checked={policy.summaries.enabled}
          onChange={enabled => { setPolicy({ ...policy, summaries: { ...policy.summaries, enabled } }); dirty(); }} />} />
        <SettingRow label={t('notifications.window')} control={<NumberField ariaLabel={t('notifications.window')} value={policy.summaries.windowSeconds} min={2} max={30} unit={t('notifications.seconds')}
          onChange={windowSeconds => { setPolicy({ ...policy, summaries: { ...policy.summaries, windowSeconds } }); dirty(); }} />} />
        <div className="category-defaults-actions"><Button variant="primary" disabled={!validPolicy} loading={busy} onClick={save}>{t('notifications.savePolicy')}</Button></div>
        {policyDirty && <p role="status">{t('notifications.unsavedPolicy')}</p>}
      </fieldset>
    </SettingsCard>
    <SettingsCard title={t('notifications.rulesTitle')} icon="sliders" description={t('notifications.rulesHint')}>
      <fieldset disabled={busy} className="notification-fields">
        <SettingRow label={t('notifications.scope')} control={<Select ariaLabel={t('notifications.scope')} value={scope} onChange={value => { setScope(value); dirty(); }}
          options={(['global', 'category', 'room'] as const).map(value => ({ value, label: t(`notifications.scope.${value}`) }))} />} />
        {scope === 'category' && <SettingRow label={t('notifications.target')} control={<Select ariaLabel={t('notifications.target')} value={categoryId} onChange={value => { setCategoryId(value); dirty(); }}
          options={[{ value: '', label: t('notifications.chooseTarget') }, ...categories.map(item => ({ value: item.id, label: item.name, icon: item.icon }))]} />} />}
        {scope === 'room' && <>
          <SettingRow label={t('notifications.target')} control={<Select ariaLabel={t('notifications.target')} value={roomId} onChange={value => { setRoomId(value); dirty(); }}
            options={[{ value: '', label: t('notifications.chooseTarget') }, ...rooms.map(item => ({ value: item.roomId, label: item.name }))]} />} />
          {roomsFailed && <p role="status">{t('notifications.roomsUnavailable')}</p>}
          <SettingRow label={t('notifications.roomMode')} control={<Select ariaLabel={t('notifications.roomMode')} value={mode} onChange={value => { setMode(value as typeof mode); dirty(); }}
            options={(['all', 'mentions', 'off'] as const).map(value => ({ value, label: t(`notifications.roomMode.${value}`) }))} />} />
        </>}
        {scope !== 'global' && <>
          {(['popups', 'sound', 'showContent'] as const).map(key => <SettingRow key={key} label={t(`notifications.rule.${key}`)} control={<InheritedBooleanSelect label={t(`notifications.rule.${key}`)} value={rule[key]}
            onChange={value => { setRule({ ...rule, [key]: value }); dirty(); }} yes={t('common.yes')} no={t('common.no')} />} />)}
          <div className="category-defaults-actions"><Button variant="primary" loading={busy} disabled={scope === 'category' ? !category : !room} onClick={saveRule}>{t('notifications.saveRule')}</Button>
            <Button variant="secondary" onClick={() => { setRule({}); dirty(); }}>{t('notifications.resetRule')}</Button></div>
        </>}
      </fieldset>
    </SettingsCard>
    <SettingsCard title={t('notifications.previewTitle')} icon="eye" description={t('notifications.previewHint')}>
      {scope !== 'room' && <SettingRow label={t('notifications.sample')} control={<Select ariaLabel={t('notifications.sample')} value={sample} onChange={value => setSample(value as NotificationKind)}
        options={(['download-complete', 'download-error', 'rss', 'system'] as const).map(value => ({ value, label: t(`notifications.kind.${value}`) }))} />} />}
      <p>{t('notifications.localTime')}: {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      {decision ? <>
        <p role="status" data-notification-popup={decision.popups} data-notification-sound={decision.sound} data-notification-content={decision.showContent}>
          {t('notifications.rule.popups')}: {t(decision.popups ? 'common.yes' : 'common.no')} · {t('notifications.rule.sound')}: {t(decision.sound ? 'common.yes' : 'common.no')}
          {decision.reason ? ` · ${t(`notifications.reason.${decision.reason}`)}` : ''}
        </p>
        <div className="notification-preview" aria-label={t('notifications.previewTitle')}>
          <strong>{decision.showContent ? t(`notifications.kind.${kind}`) : 'Havvn'}</strong>
          <p>{decision.showContent ? policy.summaries.enabled ? t('notifications.sampleSummary') : t('notifications.sampleBody') : t('notifications.privateBody')}</p>
        </div>
      </> : <p role="alert">{t('notifications.invalid')}</p>}
    </SettingsCard>
    {error && <p role="alert"><ErrorMessage error={error} /></p>}{saved && <p role="status">{t(saved === 'policy' ? 'notifications.policySaved' : 'notifications.ruleSaved')}</p>}
  </>;
};
