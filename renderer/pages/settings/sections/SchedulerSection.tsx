/**
 * Settings → Scheduler section, reworked to be actually useful.
 *
 * Schedule limits are combined with the other policies by effective-settings.
 * The live status and week strip use the same start-day convention as the engine.
 *
 * Day mapping: ScheduleEntry.days uses JS getDay() numbering (0=Sunday), which
 * is what the engine checks against. dayNames from context is Monday-first, so
 * chip index i maps to engine day (i + 1) % 7.
 */
import React, { useEffect, useState } from 'react';
import { useSettings } from '../SettingsContext';
import { SettingsCard, SettingRow, NumberField, StatusPill } from '../controls';
import { Button, Icon, Toggle } from '../../../components';
import { useTranslation } from '../../../utils/i18nContext';
import { scheduleDayTimeline, scheduleMatches } from '../../../../shared/effective-settings';

const showTime = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export const SchedulerSection: React.FC = () => {
  const { t } = useTranslation();
  const ctx = useSettings();
  const {
    schedulerEnabled,
    schedules,
    dayNames,
    handleSchedulerToggle,
    handleAddSchedule,
    handleRemoveSchedule,
    handleUpdateSchedule,
  } = ctx;

  // Tick every 30s so the "right now" pill and the today marker stay honest
  // while the page sits open (the engine itself polls every 60s).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const activeWindows = schedules.filter(s => scheduleMatches(s, now));
  const limits = activeWindows.map(s => s.speedLimit ?? 0).filter(limit => Number.isFinite(limit) && limit > 0);
  const activeLimit = limits.length ? Math.min(...limits) : 0;
  const limitLabel = (limit: number) => t('settings.sched.limitValue').replace('{limit}', String(limit));

  const renderStatusPill = () => {
    if (!activeWindows.length) return <StatusPill tone="muted">{t('settings.sched.idleNow')}</StatusPill>;
    if (activeLimit > 0) {
      return <StatusPill tone="ok">{`${t('settings.sched.limitedNow')} · ${limitLabel(activeLimit)}`}</StatusPill>;
    }
    return <StatusPill tone="accent">{t('settings.sched.windowNoLimit')}</StatusPill>;
  };

  const renderDayTrack = (engineDay: number) => {
    const timeline = scheduleDayTimeline(schedules, engineDay);
    return (
      <div className="sched-week-track">
        {timeline.map(({ start, end, limit }, index) => {
          const gap = start - (timeline[index - 1]?.end ?? 0);
          const label = `${showTime(start)}–${showTime(end)} · ${limit > 0 ? limitLabel(limit) : t('settings.sched.noEffect')}`;
          return (
            <span
              key={start}
              className={`sched-week-seg${limit === 0 ? ' noop' : ''}`}
              style={{ marginInlineStart: `${gap / 14.4}%`, width: `${(end - start) / 14.4}%` }}
              role="img"
              aria-label={label}
              title={label}
            />
          );
        })}
      </div>
    );
  };

  return (
    <>
      <SettingsCard
        title={t('settings.scheduler')}
        icon="clock"
        description={t('settings.scheduler.sub')}
      >
        <SettingRow
          label={t('settings.schedEnable')}
          description={t('settings.sched.enable.desc')}
          control={
            <Toggle
              checked={schedulerEnabled}
              disabled={ctx.schedulerSaving}
              onChange={() => handleSchedulerToggle()}
              ariaLabel={t('settings.schedEnable')}
            />
          }
        />
        {schedulerEnabled && (
          <SettingRow
            label={t('settings.sched.status')}
            description={t('settings.sched.status.desc')}
            control={renderStatusPill()}
          />
        )}
      </SettingsCard>

      {schedulerEnabled && (
        <SettingsCard title={t('settings.card.schedules')} icon="calendar">
          {schedules.length > 0 && (
            <div className="stg-sub">
              <div className="stg-row-label">
                <Icon name="activity" size={15} />
                <span>{t('settings.sched.week')}</span>
              </div>
              <div className="sched-week">
                {dayNames.map((name, idx) => {
                  const engineDay = (idx + 1) % 7;
                  return (
                    <div key={idx} className="sched-week-row">
                      <span className={`sched-week-day${engineDay === now.getDay() ? ' today' : ''}`}>
                        {name}
                      </span>
                      {renderDayTrack(engineDay)}
                    </div>
                  );
                })}
                <div className="sched-week-scale" aria-hidden="true">
                  <span>00:00</span>
                  <span>12:00</span>
                  <span>24:00</span>
                </div>
                <div className="sched-week-legend">
                  <span><i className="sched-week-seg" aria-hidden="true" />{t('settings.sched.limit')}</span>
                  <span><i className="sched-week-seg noop" aria-hidden="true" />{t('settings.sched.noEffect')}</span>
                </div>
              </div>
            </div>
          )}

          {schedules.length === 0 ? (
            <div className="empty-state-compact">
              <Icon name="calendar" size={24} />
              <p>{t('settings.noSchedules')}</p>
            </div>
          ) : (
            <div className="sched-list">
              {schedules.map((schedule) => {
                const hasLimit = !!schedule.speedLimit && schedule.speedLimit > 0;
                return (
                  <div key={schedule.id} className="sched-entry">
                    <div className="sched-entry-top">
                      <div className="sched-days" role="group" aria-label={t('settings.card.schedules')}>
                        {dayNames.map((day, idx) => {
                          const engineDay = (idx + 1) % 7; // Mon-first labels → getDay() numbering
                          const active = schedule.days.includes(engineDay);
                          return (
                            <button
                              key={idx}
                              type="button"
                              className={`sched-day${active ? ' active' : ''}`}
                              aria-pressed={active}
                              onClick={() => {
                                const newDays = active
                                  ? schedule.days.filter((d) => d !== engineDay)
                                  : [...schedule.days, engineDay].sort((a, b) => a - b);
                                handleUpdateSchedule(schedule.id, { days: newDays });
                              }}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        className="sched-del"
                        onClick={() => handleRemoveSchedule(schedule.id)}
                        aria-label={t('context.delete')}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>

                    <div className="sched-entry-fields">
                      <span className="sched-timepair">
                        <input
                          type="time"
                          className="sched-time"
                          value={schedule.startTime}
                          aria-label={t('settings.sched.start')}
                          onChange={(e) => handleUpdateSchedule(schedule.id, { startTime: e.target.value })}
                        />
                        <span className="sched-time-sep">—</span>
                        <input
                          type="time"
                          className="sched-time"
                          value={schedule.endTime}
                          aria-label={t('settings.sched.end')}
                          onChange={(e) => handleUpdateSchedule(schedule.id, { endTime: e.target.value })}
                        />
                      </span>
                      <NumberField
                        value={schedule.speedLimit ?? 0}
                        onChange={(v) => handleUpdateSchedule(schedule.id, { speedLimit: Math.max(0, Math.round(v)) })}
                        unit="KB/s"
                        min={0}
                        ariaLabel={t('settings.sched.limit')}
                      />
                      {!hasLimit && <StatusPill tone="accent">{t('settings.sched.noEffect')}</StatusPill>}
                    </div>
                    {!hasLimit && <p className="sched-hint">{t('settings.sched.limit.hint')}</p>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="sched-add">
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="plus" size={14} />}
              onClick={handleAddSchedule}
            >
              {t('settings.add')}
            </Button>
          </div>

          <div className="settings-notice-compact">
            <Icon name="info" size={14} />
            <span>{t('settings.sched.saveNote')}</span>
          </div>
        </SettingsCard>
      )}
    </>
  );
};
