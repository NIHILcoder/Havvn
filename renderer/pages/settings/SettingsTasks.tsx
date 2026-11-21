import React, { useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useTranslation } from '../../utils/i18nContext';
import { WorkingProfilesPanel } from './sections/WorkingProfilesPanel';
import type { AppSettings } from '../../../shared/types';
import './SettingsTasks.css';
const tasks = ['watch', 'download', 'room'] as const;
type Task = typeof tasks[number];
const routes = { watch: ['general', 'connection', 'notifications'], download: ['downloads', 'connection', 'seeding'], room: ['sharing', 'privacy', 'general'] } as const;
export function SettingsTasks({ settings, locked, onNavigate }: { settings: AppSettings; locked: boolean; onNavigate(section: string): void }) {
  const { t } = useTranslation(), [task, setTask] = useState<Task | null>(null);
  return <section className="settings-tasks" aria-label={t('settings.tasks.title')}>
    <h2>{t('settings.tasks.title')}</h2>
    <div className="settings-task-grid">
      {tasks.map(id => (
        <button type="button" key={id} onClick={() => setTask(id)}>
          <Icon name={id === 'watch' ? 'play' : id === 'download' ? 'download' : 'users'} size={20} />
          <span>
            <strong>{t(`settings.tasks.${id}`)}</strong>
            <small>{t(`settings.tasks.${id}Hint`)}</small>
          </span>
          <Icon name="chevron-right" size={15} />
        </button>
      ))}
    </div>
    {task && <Modal title={t(`settings.tasks.${task}`)} icon="settings" size="lg" onClose={() => setTask(null)}>
      <p>{t(`settings.tasks.${task}Steps`)}</p><p className="settings-task-note">{t('settings.tasks.noImplicit')}</p>
      <div className="settings-task-routes">{routes[task].map(section => <Button key={section} variant="secondary" onClick={() => { setTask(null); onNavigate(section); }}>{t(`settings.${section}`)}</Button>)}</div>
      <details className="settings-task-profiles"><summary>{t('settings.tasks.profiles')}</summary><p>{t('settings.tasks.previewHint')}</p><WorkingProfilesPanel settings={settings} locked={locked} lockReason={t('settings.tasks.finishDraft')} /></details>
    </Modal>}
  </section>;
}
