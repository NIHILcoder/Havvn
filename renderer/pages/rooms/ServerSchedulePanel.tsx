/**
 * Per-instance start/stop/restart schedule editor.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Icon, Select, Toggle } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import type { ServerScheduleAction, ServerScheduleRule, ServerScheduleState } from '../../../shared/gameserver-types';
import { useServerError } from './serverErrors';
import './RoomServerPanel.css';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const ACTION_OPTIONS: { value: ServerScheduleAction; labelKey: string }[] = [
  { value: 'start', labelKey: 'rooms.server.schedule.action.start' },
  { value: 'stop', labelKey: 'rooms.server.schedule.action.stop' },
  { value: 'restart', labelKey: 'rooms.server.schedule.action.restart' },
];

interface ServerSchedulePanelProps {
  instanceId: string;
}

const EMPTY: ServerScheduleState = { enabled: false, rules: [] };

function newRule(): ServerScheduleRule {
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    days: [1, 2, 3, 4, 5],
    time: '18:00',
    action: 'start',
    enabled: true,
  };
}

export const ServerSchedulePanel: React.FC<ServerSchedulePanelProps> = ({ instanceId }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();
  const api = window.api.rooms.servers;

  const [state, setState] = useState<ServerScheduleState>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const next = await api.schedule(instanceId);
    setState(next);
    setDirty(false);
  }, [api, instanceId]);

  useEffect(() => {
    void reload().catch(() => { /* instance gone */ });
  }, [reload]);

  const setEnabled = async (enabled: boolean) => {
    try {
      await api.setScheduleEnabled(instanceId, enabled);
      setState((s) => ({ ...s, enabled }));
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  /**
   * Rules main would throw away. `sanitizeScheduleRule` drops anything with a
   * malformed time or no days — and `<input type="time">` yields '' whenever it
   * is cleared — so without this a rule silently vanished on save with no hint
   * that anything had been lost.
   */
  const invalidRules = state.rules.filter(
    (r) => !/^\d{2}:\d{2}$/.test(r.time) || r.days.length === 0,
  );
  const canSave = dirty && invalidRules.length === 0;

  const updateRule = (id: string, patch: Partial<ServerScheduleRule>) => {
    setState((s) => ({
      ...s,
      rules: s.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
    setDirty(true);
  };

  const toggleDay = (id: string, day: number) => {
    setState((s) => ({
      ...s,
      rules: s.rules.map((r) => {
        if (r.id !== id) return r;
        const days = r.days.includes(day) ? r.days.filter((d) => d !== day) : [...r.days, day].sort();
        return { ...r, days };
      }),
    }));
    setDirty(true);
  };

  const removeRule = (id: string) => {
    setState((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveSchedule(instanceId, state.rules);
      await reload();
      toast.success(t('rooms.server.schedule.saved'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="room-server-schedule">
      <p className="room-server-schedule-intro">{t('rooms.server.schedule.intro')}</p>

      <div className="room-server-setting">
        <span className="room-server-setting-text">
          <span className="room-server-setting-title">{t('rooms.server.schedule.enabled')}</span>
          <span className="room-server-setting-hint">{t('rooms.server.schedule.enabledHint')}</span>
        </span>
        {/* Arming is blocked while edits are unsaved — the rules main would act
            on are the SAVED ones, so switching this on mid-edit arms something
            other than what is on screen. Disarming always works. */}
        <Toggle
          checked={state.enabled}
          ariaLabel={t('rooms.server.schedule.enabled')}
          disabled={dirty && !state.enabled}
          onChange={(v) => void setEnabled(v)}
        />
      </div>

      <ul className="room-server-schedule-rules">
        {state.rules.map((rule) => {
          const badTime = !/^\d{2}:\d{2}$/.test(rule.time);
          const noDays = rule.days.length === 0;
          return (
          <li key={rule.id} className={`room-server-schedule-rule${badTime || noDays ? ' is-invalid' : ''}`}>
            <div className="room-server-schedule-rule-top">
              <Select
                value={rule.action}
                options={ACTION_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey as never) }))}
                onChange={(v) => updateRule(rule.id, { action: v as ServerScheduleAction })}
              />
              <input
                type="time"
                className={`room-server-schedule-time${badTime ? ' is-invalid' : ''}`}
                value={rule.time}
                aria-invalid={badTime}
                onChange={(e) => updateRule(rule.id, { time: e.target.value })}
              />
              <Toggle
                checked={rule.enabled}
                ariaLabel={t('rooms.server.schedule.ruleEnabled')}
                onChange={(v) => updateRule(rule.id, { enabled: v })}
              />
              <button type="button" className="room-server-tool is-danger" onClick={() => removeRule(rule.id)}>
                <Icon name="trash" size={12} />
              </button>
            </div>
            <div className="room-server-schedule-days" role="group" aria-label={t('rooms.server.schedule.days')}>
              {DAY_KEYS.map((key, day) => (
                <button
                  key={key}
                  type="button"
                  className={`room-server-schedule-day${rule.days.includes(day) ? ' is-on' : ''}`}
                  onClick={() => toggleDay(rule.id, day)}
                >
                  {t(`rooms.server.schedule.day.${key}` as never)}
                </button>
              ))}
            </div>
            {(badTime || noDays) && (
              <p className="room-server-note is-warn" role="alert">
                {badTime ? t('rooms.server.schedule.invalidTime') : t('rooms.server.schedule.invalidDays')}
              </p>
            )}
          </li>
          );
        })}
      </ul>

      <div className="room-server-schedule-actions">
        <button
          type="button"
          className="room-server-tool"
          onClick={() => { setState((s) => ({ ...s, rules: [...s.rules, newRule()] })); setDirty(true); }}
        >
          <Icon name="plus" size={12} />
          {t('rooms.server.schedule.add')}
        </button>
        {dirty && (
          <button
            type="button"
            className="room-server-primary"
            disabled={saving || !canSave}
            title={canSave ? undefined : t('rooms.server.schedule.fixFirst')}
            onClick={() => void save()}
          >
            {saving ? t('rooms.server.schedule.saving') : t('rooms.server.schedule.save')}
          </button>
        )}
        {dirty && <span className="room-server-muted">{t('rooms.server.schedule.unsaved')}</span>}
      </div>
    </div>
  );
};
