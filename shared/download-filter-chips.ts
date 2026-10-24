import type { DownloadViewConditions } from './download-views';

export type DownloadConditionKey = keyof DownloadViewConditions;
export function activeDownloadConditions(value: DownloadViewConditions): DownloadConditionKey[] {
  return [value.status !== 'all' && 'status', value.category !== undefined && 'category', value.name !== '' && 'name',
    value.path !== '' && 'path', value.minBytes !== undefined && 'minBytes', value.maxBytes !== undefined && 'maxBytes'].filter(Boolean) as DownloadConditionKey[];
}
/** Edits temporary conditions only. Saved views, sorting and display mode stay with their owner. */
export function clearDownloadCondition(value: DownloadViewConditions, key?: DownloadConditionKey): DownloadViewConditions {
  if (!key) return { status: 'all', name: '', path: '' };
  if (key === 'status') return { ...value, status: 'all' };
  if (key === 'name' || key === 'path') return { ...value, [key]: '' };
  const next = { ...value }; delete next[key]; return next;
}
