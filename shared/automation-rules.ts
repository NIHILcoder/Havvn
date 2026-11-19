import type { AddDownloadRequest, Category, DownloadDefaults, SourceType } from './types';
import { validateDownloadDefaults } from './category-defaults';
export type AutomationEvent = 'added' | 'completed';
export interface AutomationRule {
  id: string; version: number; name: string; enabled: boolean; event: AutomationEvent;
  conditions: { nameContains?: string; sourceType?: SourceType; categoryId?: string };
  actions: { categoryId?: string; notify?: boolean; defaults?: DownloadDefaults };
  overrideExplicit: boolean;
}
export interface AutomationConfig { schema: 1; revision: number; rules: AutomationRule[] }
export type AutomationReason = 'disabled' | 'event' | 'name' | 'source' | 'category' | 'matched' | 'explicit' | 'earlier-rule' | 'missing-category';
export interface AutomationTrace { ruleId: string; version: number; name: string; matched: boolean; reasons: AutomationReason[]; applied: string[] }
export interface AutomationInput { event: AutomationEvent; name: string; sourceType: SourceType; categoryId?: string; explicitCategory: boolean; explicitDefaults: DownloadDefaults }
export interface AutomationPlan { categoryId?: string; defaults: DownloadDefaults; notifyRules: string[]; trace: AutomationTrace[] }
export interface AutomationRun {
  key: string; ruleId: string; version: number; name: string; status: 'started' | 'completed' | 'failed';
  notify: 'none' | 'pending' | 'claimed' | 'requested'; reason?: 'effect-failed' | 'notification-uncertain' | 'user-changed';
}
export interface AutomationReceipt {
  schema: 1; id: string; event: AutomationEvent; at: number; plan: AutomationPlan; runs: AutomationRun[];
  expectedCategory: string | null; categoryApplied: boolean;
}
export interface DownloadAutomation { added?: AutomationReceipt; completed?: AutomationReceipt }
export interface AutomationSnapshot { config: AutomationConfig; storage: 'ready' | 'unavailable'; history: { downloadId: string; receipt: AutomationReceipt }[] }
export interface AutomationApi {
  get(): Promise<AutomationSnapshot>;
  save(config: AutomationConfig): Promise<AutomationSnapshot>;
  preview(input: AutomationInput, rules: AutomationRule[]): Promise<AutomationPlan>;
  retry(downloadId: string, event: AutomationEvent): Promise<AutomationSnapshot>;
}
export const EMPTY_AUTOMATION: AutomationConfig = { schema: 1, revision: 0, rules: [] };
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Invalid automation object');
  return value as Record<string, unknown>;
};
function text(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw Error('Invalid automation text');
  return value.trim();
}
export function validateAutomationRules(raw: unknown): AutomationRule[] {
  if (!Array.isArray(raw) || raw.length > 100) throw Error('At most 100 automation rules');
  const rules = raw.map(value => {
    const r = object(value), c = object(r.conditions), a = object(r.actions);
    if (!id(r.id) || !Number.isSafeInteger(r.version) || (r.version as number) < 1 || typeof r.enabled !== 'boolean' || typeof r.overrideExplicit !== 'boolean' || !['added','completed'].includes(r.event as string)) throw Error('Invalid automation rule');
    const conditions: AutomationRule['conditions'] = {}, actions: AutomationRule['actions'] = {};
    if (c.nameContains !== undefined) conditions.nameContains = text(c.nameContains, 256);
    if (Object.keys(c).some(key => !['nameContains','sourceType','categoryId'].includes(key))) throw Error('Unsupported automation condition');
    if (c.sourceType !== undefined) { if (!['magnet','torrent_file','catalog'].includes(c.sourceType as string)) throw Error('Invalid automation source'); conditions.sourceType = c.sourceType as SourceType; }
    for (const [source, target] of [[c, conditions], [a, actions]] as const) if (source.categoryId !== undefined) { if (!id(source.categoryId)) throw Error('Invalid automation category'); target.categoryId = source.categoryId; }
    if (a.notify !== undefined) { if (typeof a.notify !== 'boolean') throw Error('Invalid automation notification'); actions.notify = a.notify; }
    if (a.defaults !== undefined) {
      const defaults = object(a.defaults);
      if (Object.keys(defaults).some(key => !['savePath','paused','seedRatioLimit','seedTimeLimitMinutes','sequentialDownload'].includes(key))) throw Error('Unsupported automation parameter');
      actions.defaults = validateDownloadDefaults(defaults);
      if (r.event !== 'added' && Object.keys(actions.defaults).length) throw Error('Defaults only apply to new downloads');
    }
    if (Object.keys(a).some(key => !['categoryId','notify','defaults'].includes(key)) || (!actions.categoryId && !actions.notify && !Object.keys(actions.defaults ?? {}).length)) throw Error('Automation rule needs a supported action');
    return { id: r.id, version: r.version as number, name: text(r.name, 120), enabled: r.enabled, event: r.event as AutomationEvent, conditions, actions, overrideExplicit: r.overrideExplicit };
  });
  if (new Set(rules.map(r => r.id)).size !== rules.length) throw Error('Duplicate automation rule');
  return rules;
}
export function validateAutomationInput(raw: unknown): AutomationInput {
  const v = object(raw);
  if (!['added','completed'].includes(v.event as string) || !['magnet','torrent_file','catalog'].includes(v.sourceType as string) || typeof v.explicitCategory !== 'boolean') throw Error('Invalid automation input');
  if (v.categoryId !== undefined && !id(v.categoryId)) throw Error('Invalid automation category');
  return { event: v.event as AutomationEvent, name: typeof v.name === 'string' && v.name.length <= 4096 ? v.name : '', sourceType: v.sourceType as SourceType, categoryId: v.categoryId as string | undefined,
    explicitCategory: v.explicitCategory, explicitDefaults: validateDownloadDefaults(v.explicitDefaults) };
}
/** All conditions see the original event. First effective assignment wins; no chaining. */
export function planAutomation(rules: AutomationRule[], input: AutomationInput, categories: Pick<Category, 'id'>[]): AutomationPlan {
  const plan: AutomationPlan = { defaults: {}, notifyRules: [], trace: [] }, assigned = new Set<string>();
  for (const rule of rules) {
    const reasons: AutomationReason[] = [], c = rule.conditions;
    if (!rule.enabled) reasons.push('disabled');
    if (rule.event !== input.event) reasons.push('event');
    if (c.nameContains && !input.name.toLocaleLowerCase().includes(c.nameContains.toLocaleLowerCase())) reasons.push('name');
    if (c.sourceType && c.sourceType !== input.sourceType) reasons.push('source');
    if (c.categoryId && c.categoryId !== input.categoryId) reasons.push('category');
    const trace: AutomationTrace = { ruleId: rule.id, version: rule.version, name: rule.name, matched: !reasons.length, reasons, applied: [] }; plan.trace.push(trace);
    if (!trace.matched) continue;
    reasons.push('matched');
    const assign = (key: string, explicit: boolean, apply: () => void) => {
      if (assigned.has(key)) { reasons.push('earlier-rule'); return; }
      if (explicit && !rule.overrideExplicit) { reasons.push('explicit'); return; }
      assigned.add(key); apply(); trace.applied.push(key);
    };
    if (rule.actions.categoryId) {
      if (!categories.some(c => c.id === rule.actions.categoryId)) reasons.push('missing-category');
      else assign('category', input.explicitCategory, () => { plan.categoryId = rule.actions.categoryId; });
    }
    if (input.event === 'added') for (const key of Object.keys(rule.actions.defaults ?? {}) as (keyof DownloadDefaults)[]) {
      assign(key, input.explicitDefaults[key] !== undefined, () => Object.assign(plan.defaults, { [key]: rule.actions.defaults![key] }));
    }
    if (rule.actions.notify) { plan.notifyRules.push(rule.id); trace.applied.push('notify'); }
  }
  return plan;
}
export function applyAutomationPlan(request: AddDownloadRequest, plan: AutomationPlan): AddDownloadRequest {
  return { ...request, ...plan.defaults, ...(plan.categoryId ? { categoryId: plan.categoryId } : {}) };
}
export function automationInput(request: AddDownloadRequest): AutomationInput {
  let name = request.name ?? '';
  if (!name && request.sourceType === 'magnet') { try { name = new URL(request.sourceUri).searchParams.get('dn')?.slice(0,4096) ?? ''; } catch { /* Unknown metadata stays unknown. */ } }
  return { event: 'added', name, sourceType: request.sourceType, categoryId: request.categoryId, explicitCategory: request.categoryId !== undefined, explicitDefaults: validateDownloadDefaults(request) };
}
export function automationReceipt(plan: AutomationPlan, input: AutomationInput, eventId: string, at: number): AutomationReceipt {
  return { schema: 1, id: eventId, event: input.event, at, plan, expectedCategory: input.categoryId ?? null,
    categoryApplied: input.event === 'added' || plan.categoryId === undefined,
    runs: plan.trace.filter(t => t.matched).map(t => ({ key: `${t.ruleId}:${t.version}:${eventId}`, ruleId: t.ruleId, version: t.version, name: t.name,
      status: 'started', notify: plan.notifyRules.includes(t.ruleId) ? 'pending' : 'none' })) };
}
/** Future or damaged receipts never authorize effects or crash the history UI. */
export function isAutomationReceipt(raw: unknown): raw is AutomationReceipt {
  try {
    const r = object(raw), p = object(r.plan);
    if (r.schema !== 1 || !id(r.id) || !['added','completed'].includes(r.event as string) || !Number.isSafeInteger(r.at) || (r.at as number) < 0 || typeof r.categoryApplied !== 'boolean' || r.expectedCategory !== null && !id(r.expectedCategory)) return false;
    if (p.categoryId !== undefined && !id(p.categoryId)) return false;
    validateDownloadDefaults(p.defaults);
    if (!Array.isArray(p.trace) || p.trace.length > 100 || !Array.isArray(p.notifyRules) || p.notifyRules.length > 100 || !p.notifyRules.every(id) || !Array.isArray(r.runs) || r.runs.length > 100) return false;
    const traceValid = p.trace.every(value => { const t = object(value); return id(t.ruleId) && Number.isSafeInteger(t.version) && (t.version as number)>0 && text(t.name,120) && typeof t.matched === 'boolean' && Array.isArray(t.reasons) && t.reasons.every(reason=>['disabled','event','name','source','category','matched','explicit','earlier-rule','missing-category'].includes(reason)) && Array.isArray(t.applied) && t.applied.every(key=>['category','notify','savePath','seedRatioLimit','seedTimeLimitMinutes','paused','sequentialDownload'].includes(key)); });
    return !!traceValid && r.runs.every(value => { const run=object(value); return id(run.ruleId) && Number.isSafeInteger(run.version) && (run.version as number)>0 && text(run.name,120) && run.key===`${run.ruleId}:${run.version}:${r.id}` && ['started','completed','failed'].includes(run.status as string) && ['none','pending','claimed','requested'].includes(run.notify as string) && (run.reason===undefined || ['effect-failed','notification-uncertain','user-changed'].includes(run.reason as string)); });
  } catch { return false; }
}
