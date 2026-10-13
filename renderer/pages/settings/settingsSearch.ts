type TranslationKey = keyof typeof import('../../i18n/en.json');
export interface SettingSearchEntry {
  section: string;
  labelKey: TranslationKey;
  descriptionKey?: TranslationKey;
  parentKey?: TranslationKey;
  kind: 'row' | 'card' | 'control';
}
export interface SettingSearchResult extends SettingSearchEntry { label: string; description: string; }

export const normalizeSettingsSearch = (text: string): string => text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function searchSettings(entries: readonly SettingSearchEntry[], query: string, t: (key: TranslationKey) => string): SettingSearchResult[] {
  const normalized = normalizeSettingsSearch(query);
  if (!normalized) return [];
  const terms = normalized.split(' ');
  return entries.map((entry, order) => {
    const label = t(entry.labelKey), description = entry.descriptionKey ? t(entry.descriptionKey) : '';
    const title = normalizeSettingsSearch(label), text = title + ' ' + normalizeSettingsSearch(description);
    if (!terms.every(term => text.includes(term))) return null;
    const score = title === normalized ? 100 : title.startsWith(normalized) ? 80 : title.includes(normalized) ? 60 : terms.every(term => title.includes(term)) ? 40 : 20;
    return { ...entry, label, description, score: score + (entry.kind === 'row' ? 2 : 0), order };
  }).filter((result): result is NonNullable<typeof result> => result !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Resolve the actual row/control; a disabled feature may expose only its card. */
export function findSettingTarget(root: HTMLElement, entry: SettingSearchEntry, t: (key: TranslationKey) => string): HTMLElement | null {
  const label = t(entry.labelKey);
  const rows = [...root.querySelectorAll<HTMLElement>('[data-setting-label]')];
  const exact = rows.find(row => row.dataset.settingLabel === label && (entry.kind !== 'row' || !row.classList.contains('stg-card')));
  if (exact) return exact;
  const field = [...root.querySelectorAll<HTMLElement>('[aria-label]')].find(node => node.getAttribute('aria-label') === label);
  if (field) return field.closest<HTMLElement>('.stg-row') ?? field;
  return entry.parentKey ? rows.find(row => row.classList.contains('stg-card') && row.dataset.settingLabel === t(entry.parentKey!)) ?? null : null;
}
