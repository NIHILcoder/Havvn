import type { Category, Download } from './types';
import type { AutomationInput, AutomationRule } from './automation-rules';
import { validateDownloadDefaults } from './category-defaults';
export interface AutomationDraft { rule: AutomationRule; sample: AutomationInput; origin: string }
export function automationDraft(source: { download: Download } | { category: Category }, id: string): AutomationDraft {
  if ('download' in source) {
    const d = source.download, categoryId = d.category || undefined;
    return { origin: d.name, rule: { id, version: 1, name: d.name.slice(0, 120), enabled: false, event: 'added',
      conditions: { nameContains: d.name.slice(0, 256), sourceType: d.sourceType, categoryId }, actions: { categoryId, defaults: validateDownloadDefaults({ savePath: d.savePath }), notify: true }, overrideExplicit: false },
      sample: { event: 'added', name: d.name, sourceType: d.sourceType, categoryId, explicitCategory: false, explicitDefaults: {} } };
  }
  const c = source.category;
  return { origin: c.name, rule: { id, version: 1, name: c.name.slice(0, 120), enabled: false, event: 'added', conditions: { categoryId: c.id }, actions: { defaults: validateDownloadDefaults(c.downloadDefaults ?? {}), notify: true }, overrideExplicit: false },
    sample: { event: 'added', name: c.name, sourceType: 'magnet', categoryId: c.id, explicitCategory: true, explicitDefaults: {} } };
}
