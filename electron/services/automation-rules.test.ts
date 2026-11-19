import { expect, it, vi } from 'vitest';
import { AutomationRules, type AutomationAdapter } from './automation-rules';
import { automationReceipt, planAutomation, type AutomationConfig, type AutomationInput, type AutomationRule } from '../../shared/automation-rules';
import type { Download } from '../../shared/types';
const rule=(patch:Partial<AutomationRule>={}):AutomationRule=>({id:'r',version:1,name:'Rule',enabled:true,event:'added',conditions:{},actions:{notify:true},overrideExplicit:false,...patch});
function fixture(rules=[rule()]) {
  let config:AutomationConfig|null={schema:1,revision:1,rules};const rows=new Map<string,Download>();
  const adapter:AutomationAdapter={readConfig:()=>structuredClone(config),writeConfig:vi.fn(next=>{config=structuredClone(next);}),categories:async()=>[{id:'movies',name:'Movies',icon:'film',color:'#fff'}],downloads:async()=>structuredClone([...rows.values()]),download:async id=>structuredClone(rows.get(id)??null),
    persist:vi.fn(async(id,event,receipt)=>{const row=rows.get(id)!;row.automation={...row.automation,[event]:structuredClone(receipt)};}),category:vi.fn(async(id,category)=>{rows.get(id)!.category=category;}),notify:vi.fn(async()=>{}),history:vi.fn()};
  const service=()=>new AutomationRules(adapter,()=> 'evt-1',()=>1);
  const add=async(s:AutomationRules)=>{const prepared=await s.prepare({sourceType:'magnet',sourceUri:'magnet:test',name:'Series'});rows.set('d',{id:'d',name:'Series',sourceType:'magnet',category:prepared.request.categoryId??null,status:'paused',automation:{added:prepared.receipt}} as Download);return prepared;};
  return {adapter,rows,service,add};
}
it('dry run makes no writes, notifications or download mutations',async()=>{
  const f=fixture(),s=f.service();const input:AutomationInput={event:'added',name:'Series',sourceType:'magnet',explicitCategory:false,explicitDefaults:{}};
  expect((await s.preview(input,[rule()])).notifyRules).toEqual(['r']);expect(f.adapter.persist).not.toHaveBeenCalled();expect(f.adapter.writeConfig).not.toHaveBeenCalled();expect(f.adapter.notify).not.toHaveBeenCalled();expect(f.rows.size).toBe(0);
});
it('increments versions on edits and rejects stale saves without replacing the config',async()=>{
  const f=fixture(),s=f.service();const first=await s.snapshot();const next=await s.save({...first.config,rules:[rule({name:'Changed'})]});expect(next.config.rules[0].version).toBe(2);
  await expect(s.save(first.config)).rejects.toThrow('changed');expect((await s.snapshot()).config.rules[0].name).toBe('Changed');
});
it('failed config writes retain the previous working rules',async()=>{
  const f=fixture(),s=f.service();vi.mocked(f.adapter.writeConfig).mockImplementation(()=>{throw Error('disk');});await expect(s.save({schema:1,revision:1,rules:[]})).rejects.toThrow();expect((await s.snapshot()).config.rules).toHaveLength(1);
});
it('processes duplicate events and restarts without creating downloads or repeating notifications',async()=>{
  const f=fixture(),s=f.service();await f.add(s);await Promise.all([s.process('d'),s.process('d')]);await f.service().recover();expect(f.adapter.notify).toHaveBeenCalledTimes(1);expect(f.rows.size).toBe(1);expect(f.rows.get('d')!.automation!.added!.runs[0].status).toBe('completed');
});
it('recovers a durable started receipt without using a newer rule version',async()=>{
  const f=fixture(),s=f.service();await f.add(s);await s.save({schema:1,revision:1,rules:[rule({name:'New version'})]});await f.service().recover();expect(f.rows.get('d')!.automation!.added!.runs[0].version).toBe(1);expect(f.adapter.notify).toHaveBeenCalledTimes(1);
});
it('does not replay a notification claimed before a crash',async()=>{
  const f=fixture(),s=f.service();await f.add(s);const receipt=f.rows.get('d')!.automation!.added!;receipt.runs[0].notify='claimed';await f.service().recover();expect(f.adapter.notify).not.toHaveBeenCalled();expect(receipt.runs[0].status).toBe('started');const saved=f.rows.get('d')!.automation!.added!.runs[0];expect(saved.status).toBe('completed');expect(saved.reason).toBe('notification-uncertain');
});
it('reconciles a category effect applied before a crash and preserves a later manual edit',async()=>{
  const f=fixture(),s=f.service();const download={id:'d',name:'Series',sourceType:'magnet',category:null,status:'seeding'} as Download;
  const input:AutomationInput={event:'completed',name:'Series',sourceType:'magnet',explicitCategory:false,explicitDefaults:{}};
  const receipt=automationReceipt(planAutomation([rule({event:'completed',actions:{categoryId:'movies'}})],input,[{id:'movies'}]),input,'evt-1',1);
  f.rows.set('d',{...download,category:'movies',automation:{completed:structuredClone(receipt)}});await s.process('d');expect(f.adapter.category).not.toHaveBeenCalled();
  f.rows.set('d',{...download,category:'manual',automation:{completed:structuredClone(receipt)}});await s.process('d');expect(f.rows.get('d')!.category).toBe('manual');expect(f.rows.get('d')!.automation!.completed!.runs[0].reason).toBe('user-changed');
});
it('retries failed category work without synthesizing a new event',async()=>{
  const f=fixture([rule({event:'completed',actions:{categoryId:'movies'}})]),s=f.service();const download={id:'d',name:'Series',sourceType:'magnet',category:null,status:'seeding'} as Download;
  f.rows.set('d',{...download,automation:{completed:s.completion(download,await f.adapter.categories())}});
  vi.mocked(f.adapter.category).mockRejectedValueOnce(Error('disk'));await s.process('d');expect(f.rows.get('d')!.automation!.completed!.runs[0].status).toBe('failed');await s.process('d');expect(f.adapter.category).toHaveBeenCalledTimes(1);await s.process('d',true);expect(f.rows.get('d')!.category).toBe('movies');expect(f.rows.size).toBe(1);expect(f.rows.get('d')!.automation!.completed!.id).toBe('evt-1');
});
it('strips caller receipts and fails closed on unavailable config and malformed receipts',async()=>{
  const f=fixture();f.adapter.readConfig=()=>{throw Error('encrypted storage unavailable');};const s=f.service();const p=await s.prepare({sourceType:'magnet',sourceUri:'x',automation:{added:{} as never}});expect(p.request.automation).toBeUndefined();expect((await s.snapshot()).storage).toBe('unavailable');await expect(s.save({schema:1,revision:0,rules:[]})).rejects.toThrow();
  const valid=fixture(),service=valid.service();valid.rows.set('d',{id:'d',status:'paused',automation:{added:{schema:2} as never}} as Download);await service.recover();expect(valid.adapter.notify).not.toHaveBeenCalled();expect((await service.snapshot()).history).toEqual([]);
});
it('does not request another notification after an uncertain output failure',async()=>{
  const f=fixture(),s=f.service();await f.add(s);vi.mocked(f.adapter.notify).mockRejectedValueOnce(Error('output unknown'));await s.process('d');
  expect(f.rows.get('d')!.automation!.added!.runs[0].status).toBe('failed');await s.process('d',true);expect(f.adapter.notify).toHaveBeenCalledTimes(1);expect(f.rows.get('d')!.automation!.added!.runs[0].reason).toBe('notification-uncertain');
});
it('preserves user categories but treats an automated category as a baseline on completion',async()=>{
  const f=fixture([rule({event:'completed',actions:{categoryId:'movies'}})]),s=f.service();const d={id:'d',name:'Series',sourceType:'magnet',category:'movies',categoryOrigin:'user'} as Download;
  expect(s.completion(d,await f.adapter.categories())!.plan.categoryId).toBeUndefined();expect(s.completion({...d,categoryOrigin:'automation'},await f.adapter.categories())!.plan.categoryId).toBe('movies');
});
