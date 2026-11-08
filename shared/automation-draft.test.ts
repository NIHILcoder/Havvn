import { describe, expect, it } from 'vitest';
import { automationDraft } from './automation-draft';
import { planAutomation, validateAutomationRules } from './automation-rules';
import type { Category, Download } from './types';
describe('automation from a known object', () => {
  it('creates a disabled download draft with a narrow name/source condition, without touching the source', () => {
    const d = { name: 'Show S01E03', sourceType: 'magnet', category: 'series', savePath: 'D:/series', status: 'paused' } as Download;
    const result = automationDraft({ download: d }, 'draft');
    expect(result.rule.enabled).toBe(false); expect(result.rule.conditions).toEqual({ nameContains: d.name, sourceType: 'magnet', categoryId: 'series' });
    expect(result.rule.actions.defaults).toEqual({ savePath: 'D:/series' }); expect(d.status).toBe('paused');
    expect(planAutomation([result.rule], result.sample, [{ id: 'series' }]).trace[0].reasons).toContain('disabled');
  });
  it('uses category membership as a condition and retains inherited defaults', () => {
    const category = { id: 'series', name: 'Series', downloadDefaults: { paused: true, seedRatioLimit: 0 } } as Category;
    const result = automationDraft({ category }, 'draft');
    expect(validateAutomationRules([result.rule])[0].enabled).toBe(false);
    const enabled = { ...result.rule, enabled: true };
    expect(planAutomation([enabled], result.sample, [{ id: category.id }]).defaults).toEqual({ paused: true, seedRatioLimit: 0 });
    expect(planAutomation([enabled], { ...result.sample, categoryId: 'another' }, []).defaults).toEqual({});
  });
  it('previewing an enabled copy respects earlier rules and does not enable the saved draft', () => {
    const draft = automationDraft({ download: { name: 'Film', sourceType: 'torrent_file', savePath: 'D:/films' } as Download }, 'later');
    const first = { ...draft.rule, id: 'first', enabled: true, actions: { defaults: { savePath: 'D:/first' } } };
    const result = planAutomation([first, { ...draft.rule, enabled: true }], draft.sample, []);
    expect(result.defaults.savePath).toBe('D:/first'); expect(result.trace[1].reasons).toContain('earlier-rule'); expect(draft.rule.enabled).toBe(false);
  });
});
