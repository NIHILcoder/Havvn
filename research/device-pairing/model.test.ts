import { expect, it } from 'vitest';
import { acknowledge, confirm, createPair, disableScope, dispatch, heads, receive, revoke, session, write, type Operation, type PairModel } from './model';
const active=(self='a',peer='b',grant='grant-1',limit=64)=>confirm(confirm(createPair(self,peer,'pair-1',grant,['preferences','views','playback'],limit),'self'),'peer');
const inbound=(state:PairModel,op:Operation)=>receive(state,op,session(state));
const restart=(state:PairModel):PairModel=>JSON.parse(JSON.stringify(state));
it('requires both explicit confirmations before syncing',()=>{
  const pending=createPair('a','b','pair-1','grant-1',['preferences']);
  expect(()=>write(pending,'preferences','language','ru')).toThrow('not-active');
  const one=confirm(pending,'self');expect(one.status).toBe('pending');expect(confirm(one,'peer').status).toBe('active');
});
it('rejects a cloned device identity and invalid grants/scopes',()=>{
  expect(()=>createPair('a','a','pair','grant',['views'])).toThrow();expect(()=>createPair('a','b','pair','grant',[])).toThrow();
  expect(()=>createPair('a','b','pair','grant',['views','views'])).toThrow();
});
it('keeps concurrent edits instead of selecting a device or wall-clock winner',()=>{
  const a=write(active(),'preferences','language','ru'),b=write(active('b','a'),'preferences','language','en');
  const atA=inbound(a.state,b.operation).state,atB=inbound(b.state,a.operation).state;
  expect(heads(atA,'preferences','language')).toEqual(heads(atB,'preferences','language'));expect(heads(atA,'preferences','language').map(h=>h.value)).toEqual(['ru','en']);
});
it('causal writes replace the old value on both replicas',()=>{
  const a=write(active(),'preferences','language','ru');const b1=inbound(active('b','a'),a.operation).state;
  const b2=write(b1,'preferences','language','en'),a2=inbound(a.state,b2.operation).state;
  expect(heads(a2,'preferences','language').map(h=>h.value)).toEqual(['en']);
});
it('explicit conflict resolution covers both heads',()=>{
  const a=write(active(),'views','view-1',{name:'A'}),b=write(active('b','a'),'views','view-1',{name:'B'});
  const conflict=inbound(a.state,b.operation).state,resolved=write(conflict,'views','view-1',{name:'Chosen'});
  const peer=inbound(inbound(b.state,a.operation).state,resolved.operation).state;
  expect(heads(peer,'views','view-1')).toHaveLength(1);expect(heads(peer,'views','view-1')[0].value).toEqual({name:'Chosen'});
});
it('does not assume a larger playback position is more recent',()=>{
  const rewatch=write(active(),'playback','media-1',{position:10}),old=write(active('b','a'),'playback','media-1',{position:900});
  const conflict=inbound(rewatch.state,old.operation).state;expect(heads(conflict,'playback','media-1')).toHaveLength(2);
  const selected=write(conflict,'playback','media-1',{position:10});expect(heads(selected.state,'playback','media-1')[0].value).toEqual({position:10});
});
it('keeps a delete/edit conflict visible',()=>{
  const a=write(active(),'views','view-1',null,true),b=write(active('b','a'),'views','view-1',{name:'Edited'});
  expect(heads(inbound(a.state,b.operation).state,'views','view-1').map(h=>h.deleted)).toEqual([true,false]);
});
it('a causal tombstone prevents a delayed old edit from resurrecting a record',()=>{
  const old=write(active(),'views','view-1',{name:'Old'}),removed=write(old.state,'views','view-1',null,true);
  const first=inbound(active('b','a'),removed.operation),second=inbound(first.state,old.operation);
  expect(heads(second.state,'views','view-1')).toHaveLength(1);expect(heads(second.state,'views','view-1')[0].deleted).toBe(true);expect(second.ack).toBe(2);
});
it('persists an offline outbox and counters in a simulated restart snapshot',()=>{
  const one=write(active(),'preferences','language','en'),restored=restart(one.state),two=write(restored,'preferences','language','ru');
  expect(two.operation.seq).toBe(2);expect(two.state.outbox).toHaveLength(2);expect(one.state.outbox).toHaveLength(1);
});
it('replayed operations are harmless after a simulated receiver restart',()=>{
  const op=write(active(),'preferences','language','ru').operation,once=inbound(active('b','a'),op),again=inbound(restart(once.state),op);
  expect(again.duplicate).toBe(true);expect(again.ack).toBe(1);expect(heads(again.state,'preferences','language')).toHaveLength(1);
});
it('acknowledges only a contiguous prefix when delivery is reordered',()=>{
  const one=write(active(),'preferences','language','en'),two=write(one.state,'preferences','density','compact');
  const gap=inbound(active('b','a'),two.operation);expect(gap.ack).toBe(0);
  expect(acknowledge(two.state,'preferences',gap.ack,session(two.state)).outbox).toHaveLength(2);
  const filled=inbound(gap.state,one.operation);expect(filled.ack).toBe(2);expect(acknowledge(two.state,'preferences',2,session(two.state)).outbox).toHaveLength(0);
});
it('rejects equivocation inside the pending delivery window',()=>{
  const one=write(active(),'preferences','language','en'),two=write(one.state,'preferences','density','compact'),gap=inbound(active('b','a'),two.operation);
  expect(()=>inbound(gap.state,{...two.operation,value:'other'})).toThrow('equivocation');
});
it('binds incoming operations to a verified peer and grant',()=>{
  const op=write(active(),'preferences','language','en').operation,b=active('b','a');
  expect(()=>receive(b,op,{...session(b),peer:'intruder'})).toThrow('peer');expect(()=>inbound(b,{...op,grant:'other'})).toThrow('generation');
});
it('denies unapproved scopes and invalid schema before changing state',()=>{
  const b=confirm(confirm(createPair('b','a','pair-1','grant-1',['views']),'self'),'peer'),op=write(active(),'preferences','language','en').operation;
  expect(()=>inbound(b,op)).toThrow('scope-denied');expect(()=>inbound(active('b','a'),{...op,version:2} as never)).toThrow('generation');
});
it('rechecks consent at dispatch rather than when a packet was selected',()=>{
  const original=write(active(),'playback','media-1',{position:30}),selected=original.operation,next=disableScope(original.state,'playback');
  expect(next.outbox).toHaveLength(0);expect(()=>dispatch(next,selected)).toThrow('scope-denied');
});
it('revocation blocks both existing-session receives and previously selected sends',()=>{
  const original=write(active(),'preferences','language','en'),oldSession=session(original.state),revoked=revoke(original.state),incoming=write(active('b','a'),'preferences','language','ru').operation;
  expect(()=>dispatch(revoked,original.operation)).toThrow('not-active');expect(()=>receive(revoked,incoming,oldSession)).toThrow('not-active');expect(revoked.outbox).toHaveLength(0);
});
it('revocation retains local values and survives simulated restart',()=>{
  const original=write(active(),'preferences','language','en'),restored=restart(revoke(original.state));
  expect(heads(restored,'preferences','language')[0].value).toBe('en');expect(()=>confirm(restored,'peer')).toThrow();expect(()=>session(restored)).toThrow('not-active');
});
it('re-pairing under a new grant cannot accept old operations or acknowledgments',()=>{
  const old=write(active(),'preferences','language','en'),fresh=active('b','a','grant-2');
  expect(()=>inbound(fresh,old.operation)).toThrow('generation');expect(()=>acknowledge(old.state,'preferences',1,{...session(old.state),grant:'grant-2'})).toThrow('ack');
});
it('outbox overflow leaves the caller state unchanged and cannot claim success',()=>{
  const full=write(active('a','b','grant-1',1),'preferences','language','en').state,before=JSON.stringify(full);
  expect(()=>write(full,'preferences','language','ru')).toThrow('outbox-full');expect(JSON.stringify(full)).toBe(before);
});
it('rejects large payloads, third-party clocks, forged future context and large sequence gaps',()=>{
  expect(()=>write(active(),'preferences','language','x'.repeat(5000))).toThrow('operation-size');
  const op=write(active(),'preferences','language','en').operation,b=active('b','a');
  expect(()=>inbound(b,{...op,context:{intruder:1}})).toThrow('context');expect(()=>inbound(b,{...op,context:{a:1}})).toThrow('future-context');expect(()=>inbound(b,{...op,seq:65})).toThrow('sequence-window');
});
it('rejects a same-actor fork which omits its own earlier record context',()=>{
  const op=write(active(),'preferences','language','en').operation,b=inbound(active('b','a'),op).state;
  expect(()=>inbound(b,{...op,seq:2,value:'ru',context:{}})).toThrow('actor-fork');
});
it('a peer cannot claim to have observed a local operation that was never issued',()=>{
  const op=write(active(),'preferences','language','en').operation,b=active('b','a');
  expect(()=>inbound(b,{...op,context:{b:100}})).toThrow('unissued-local-context');
});
