import { expect, it } from 'vitest';
import { applyDownloadDefaults } from './category-defaults';
import { applyAutomationPlan, automationInput, automationReceipt, isAutomationReceipt, planAutomation, validateAutomationInput, validateAutomationRules, type AutomationRule } from './automation-rules';
const categories = [{ id:'movies',name:'Movies',icon:'film',color:'#fff',downloadDefaults:{paused:true} },{id:'series'}];
const rule = (patch: Partial<AutomationRule> = {}): AutomationRule => ({ id:'a',version:1,name:'Series',enabled:true,event:'added',conditions:{nameContains:'series'},actions:{categoryId:'movies',defaults:{paused:true,seedRatioLimit:2}},overrideExplicit:false,...patch });
const input = () => automationInput({ sourceType:'magnet',sourceUri:'magnet:test',name:'SERIES S01' });
it('uses the first effective assignment and explains conflicting rules',()=>{
  const a=rule(),b=rule({id:'b',actions:{categoryId:'series',defaults:{paused:false}}});
  const result=planAutomation([a,b],input(),categories);
  expect(result.categoryId).toBe('movies');expect(result.defaults.paused).toBe(true);
  expect(result.trace[1].reasons).toContain('earlier-rule');
  expect(planAutomation([b,a],input(),categories).categoryId).toBe('series');
});
it('preserves explicit false and zero and category unless replacement was selected',()=>{
  const i={...input(),categoryId:'series',explicitCategory:true,explicitDefaults:{paused:false,seedRatioLimit:0}};
  const result=planAutomation([rule()],i,categories);expect(result.categoryId).toBeUndefined();expect(result.defaults).toEqual({});expect(result.trace[0].reasons).toContain('explicit');
  expect(planAutomation([rule({overrideExplicit:true})],i,categories).defaults).toEqual({paused:true,seedRatioLimit:2});
});
it('resolves the assigned category as a baseline before final explicit/rule fields',()=>{
  const request={sourceType:'magnet' as const,sourceUri:'magnet:test',name:'series'};
  const plan=planAutomation([rule({actions:{categoryId:'movies',defaults:{seedRatioLimit:3}}})],input(),categories);
  const final=applyDownloadDefaults(applyAutomationPlan(request,plan),categories[0],{defaultDownloadDir:'D:/downloads'});
  expect(final.paused).toBe(true);expect(final.seedRatioLimit).toBe(3);
});
it('evaluates all conditions against the original event and treats names as literal text',()=>{
  const result=planAutomation([rule(),rule({id:'b',conditions:{categoryId:'movies'}})],input(),categories);
  expect(result.trace[1].matched).toBe(false);
  expect(planAutomation([rule({conditions:{nameContains:'.*'}})],input(),categories).trace[0].matched).toBe(false);
});
it('explains disabled rules, events, source, missing category and unavailable name',()=>{
  expect(planAutomation([rule({enabled:false,event:'completed',conditions:{sourceType:'torrent_file'},actions:{categoryId:'gone'}})],input(),categories).trace[0].reasons).toEqual(['disabled','event','source']);
  expect(planAutomation([rule({actions:{categoryId:'gone'}})],input(),categories).trace[0].reasons).toContain('missing-category');
  expect(planAutomation([rule()],{...input(),name:''},categories).trace[0].reasons).toContain('name');
});
it('rejects unsupported speed, shell, delete actions and completion defaults',()=>{
  for(const actions of [{shell:'cmd'}, {delete:true}, {defaults:{maxDownloadSpeed:100}}, {defaults:{seedRatioLimit:-1}}, {defaults:{paused:'yes'}}]) expect(()=>validateAutomationRules([rule({actions:actions as AutomationRule['actions']})])).toThrow();
  expect(()=>validateAutomationRules([rule({event:'completed'})])).toThrow();
});
it('validates bounded rules, duplicate identity and event payloads',()=>{
  expect(()=>validateAutomationRules([rule(),rule()])).toThrow();
  expect(()=>validateAutomationRules(Array(101).fill(rule()))).toThrow();
  expect(()=>validateAutomationRules([rule({conditions:{regex:'expensive'} as never})])).toThrow();
  expect(()=>validateAutomationInput({...input(),event:'delete'})).toThrow();
  expect(validateAutomationInput({...input(),sourceType:'catalog'}).sourceType).toBe('catalog');
});
it('ties execution keys to rule version and event and rejects future receipts',()=>{
  const r=automationReceipt(planAutomation([rule()],input(),categories),input(),'evt-1',1);
  expect(r.runs[0].key).toBe('a:1:evt-1');expect(isAutomationReceipt(r)).toBe(true);
  expect(isAutomationReceipt({...r,schema:2})).toBe(false);expect(isAutomationReceipt({...r,runs:[{...r.runs[0],key:'wrong'}]})).toBe(false);
});
it('uses known metadata names and magnet dn without a network lookup or a filename guess',()=>{
  expect(automationInput({sourceType:'magnet',sourceUri:'magnet:?xt=x&dn=Series%20S01'}).name).toBe('Series S01');
  expect(automationInput({sourceType:'magnet',sourceUri:'magnet:?dn=other',name:'Explicit'}).name).toBe('Explicit');
  expect(automationInput({sourceType:'torrent_file',sourceUri:'D:/Series.torrent'}).name).toBe('');
});
