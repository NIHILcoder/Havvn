import React, { useEffect, useState } from 'react';
import type { AppSettings, DownloadDefaults, RSSFeed, RSSRule } from '../../shared/types';
import { resolveDownloadDefaults } from '../../shared/category-defaults';
import { useCategories } from '../utils/useCategories';
import { useTranslation } from '../utils/i18nContext';
import { Select } from './Select';
import './DownloadDefaultsPreview.css';

export function InheritedBooleanSelect({ value, onChange, label, yes, no, disabled }: {
  value: boolean | undefined; onChange(value: boolean | undefined): void; label: string; yes: string; no: string; disabled?: boolean;
}) {
  const { t } = useTranslation();
  return <Select ariaLabel={label} disabled={disabled} value={value === undefined ? 'inherit' : String(value)}
    onChange={choice => onChange(choice === 'inherit' ? undefined : choice === 'true')}
    options={[{ value: 'inherit', label: t('category.defaults.inherit') }, { value: 'false', label: no }, { value: 'true', label: yes }]} />;
}

export function DownloadDefaultsPreview({ categoryId, compact, ...request }: DownloadDefaults & { categoryId?: string; compact?: boolean }) {
  const { t } = useTranslation(), categories = useCategories();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    window.api.getSettings().then(value => { if (active) setSettings(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  if (!settings) return failed ? <p role="status">{t('category.defaults.previewUnavailable')}</p> : null;
  const category = categories.find(item => item.id === categoryId);
  const { values, sources } = resolveDownloadDefaults(request, category, settings);
  const labels: Record<keyof DownloadDefaults, string> = {
    savePath: values.savePath,
    seedRatioLimit: values.seedRatioLimit === 0 ? t('category.defaults.unlimited') : String(values.seedRatioLimit),
    seedTimeLimitMinutes: values.seedTimeLimitMinutes === 0 ? t('category.defaults.unlimited') : `${values.seedTimeLimitMinutes} ${t('category.defaults.minutes')}`,
    paused: t(values.paused ? 'category.defaults.paused' : 'category.defaults.active'),
    sequentialDownload: t(values.sequentialDownload ? 'common.yes' : 'common.no'),
  };
  const content = <>
    {categoryId && !category && <p role="alert">{t('category.defaults.missing')}</p>}
    <dl>{(Object.keys(labels) as Array<keyof DownloadDefaults>).map(key => <div key={key} data-default-field={key} data-default-source={sources[key]}>
      <dt>{t(`category.defaults.${key}`)}</dt><dd title={labels[key]}>{labels[key]} <small>{t(`category.defaults.source.${sources[key]}`)}{sources[key] === 'category' ? `: ${category?.name}` : ''}</small></dd>
    </div>)}</dl>
  </>;
  return compact ? <details className="download-defaults-preview"><summary>{t('category.defaults.preview')}</summary>{content}</details>
    : <div className="download-defaults-preview"><strong>{t('category.defaults.preview')}</strong>{content}</div>;
}

export function RuleDownloadDefaultsPreview({ rule, feeds }: { rule: Partial<RSSRule>; feeds: RSSFeed[] }) {
  const { t } = useTranslation();
  const [feedId, setFeedId] = useState('');
  const eligible = feeds.filter(feed => !rule.feedIds?.length || rule.feedIds.includes(feed.id));
  const feed = eligible.find(item => item.id === feedId) ?? eligible[0];
  return <div>
    {feed && <Select ariaLabel={t('category.defaults.previewFeed')} value={feed.id} onChange={setFeedId}
      options={eligible.map(item => ({ value: item.id, label: item.name }))} />}
    <DownloadDefaultsPreview categoryId={rule.categoryId ?? feed?.categoryId} savePath={rule.savePath || feed?.savePath} paused={rule.addPaused ?? feed?.addPaused} />
  </div>;
}
