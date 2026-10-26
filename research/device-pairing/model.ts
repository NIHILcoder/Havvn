/** FUN-06 research model only. No network, keys, store, IPC or production imports.
 * The caller represents a verified peer/session and an atomic durable commit.
 * Those prerequisites are NOT implemented or certified by this simulation.
 */
export const SCOPES = ['preferences', 'views', 'playback'] as const;
export type Scope = typeof SCOPES[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Clock = Record<string, number>;
export interface Operation {
  version: 1; pair: string; grant: string; actor: string; scope: Scope; seq: number;
  key: string; context: Clock; value: Json; deleted: boolean;
}
interface Register { clock: Clock; heads: Operation[] }
export interface PairModel {
  version: 1; self: string; peer: string; pair: string; grant: string;
  status: 'pending' | 'active' | 'revoked'; confirmed: { self: boolean; peer: boolean };
  scopes: Scope[]; next: Record<Scope, number>;
  inbox: Record<Scope, { floor: number; pending: Record<string, string> }>;
  records: Record<string, Register>; outbox: Operation[]; queueLimit: number;
}
export interface ModelSession { pair: string; grant: string; peer: string }
const validId = (v: string) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
const count = (v: number) => Number.isSafeInteger(v) && v >= 0;
const keyOf = (scope: Scope, key: string) => `${scope}/${key}`;
const join = (...clocks: Clock[]): Clock => {
  const result: Clock = {};
  for (const clock of clocks) for (const [actor, seq] of Object.entries(clock)) result[actor] = Math.max(result[actor] ?? 0, seq);
  return result;
};
function canonical(value: unknown, depth = 0): string {
  if (depth > 8) throw Error('value-depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value) && value.length <= 128) return '[' + value.map(v => canonical(v,depth+1)).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length <= 128) {
    return '{' + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => {
      if (['__proto__','constructor','prototype'].includes(key)) throw Error('value-key');
      return JSON.stringify(key) + ':' + canonical(v,depth+1);
    }).join(',') + '}';
  }
  throw Error('value');
}
function validate(state: PairModel, op: Operation): string {
  if (!op || op.version !== 1 || op.pair !== state.pair || op.grant !== state.grant) throw Error('generation');
  if (![state.self,state.peer].includes(op.actor) || !SCOPES.includes(op.scope) || !count(op.seq) || op.seq === 0) throw Error('operation');
  if (typeof op.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(op.key) || typeof op.deleted !== 'boolean') throw Error('record');
  if (!op.context || Object.getPrototypeOf(op.context) !== Object.prototype || Object.keys(op.context).length > 2 || Object.entries(op.context).some(([actor,seq]) => ![state.self,state.peer].includes(actor) || !count(seq))) throw Error('context');
  if ((op.context[op.actor] ?? 0) >= op.seq) throw Error('future-context');
  if (op.actor === state.peer && (op.context[state.self] ?? 0) > state.next[op.scope]) throw Error('unissued-local-context');
  if (op.deleted && op.value !== null) throw Error('tombstone-value');
  const encoded = canonical(op);
  if (new TextEncoder().encode(encoded).length > 4096) throw Error('operation-size');
  return encoded;
}
function assertActive(state: PairModel, scope?: Scope): void {
  if (state.status !== 'active') throw Error('not-active');
  if (scope && !state.scopes.includes(scope)) throw Error('scope-denied');
}
function merge(state: PairModel, op: Operation): void {
  const key = keyOf(op.scope,op.key), previous = state.records[key] ?? { clock: {}, heads: [] };
  if ((previous.clock[op.actor] ?? 0) >= op.seq) return;
  if ((op.context[op.actor] ?? 0) < (previous.clock[op.actor] ?? 0)) throw Error('actor-fork');
  const heads = previous.heads.filter(head => (op.context[head.actor] ?? 0) < head.seq);
  heads.push(structuredClone(op));
  if (heads.length > 2) throw Error('conflict-budget');
  // Sort only for deterministic representation; no head is selected as winner.
  heads.sort((a,b) => a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : a.seq-b.seq);
  state.records[key] = { clock: join(previous.clock,op.context,{[op.actor]:op.seq}), heads };
}
export function createPair(self: string, peer: string, pair: string, grant: string, scopes: Scope[], queueLimit=64): PairModel {
  if (![self,peer,pair,grant].every(validId) || self===peer || !scopes.length || scopes.length>3 || new Set(scopes).size!==scopes.length || scopes.some(scope=>!SCOPES.includes(scope)) || !Number.isSafeInteger(queueLimit) || queueLimit<1 || queueLimit>1000) throw Error('pair');
  return {version:1,self,peer,pair,grant,status:'pending',confirmed:{self:false,peer:false},scopes:[...scopes],next:{preferences:0,views:0,playback:0},
    inbox:{preferences:{floor:0,pending:{}},views:{floor:0,pending:{}},playback:{floor:0,pending:{}}},records:{},outbox:[],queueLimit};
}
export function confirm(state: PairModel, side: 'self' | 'peer'): PairModel {
  if (state.status==='revoked' || !['self','peer'].includes(side)) throw Error('confirmation');
  const next=structuredClone(state); next.confirmed[side]=true;
  if (next.confirmed.self && next.confirmed.peer) next.status='active'; return next;
}
export function write(state: PairModel, scope: Scope, key: string, value: Json, deleted=false): { state: PairModel; operation: Operation } {
  assertActive(state,scope);
  if (state.outbox.length>=state.queueLimit) throw Error('outbox-full');
  const next=structuredClone(state), seq=next.next[scope]+1;
  const operation: Operation={version:1,pair:state.pair,grant:state.grant,actor:state.self,scope,seq,key,context:{...state.records[keyOf(scope,key)]?.clock},value,deleted};
  validate(next,operation); next.next[scope]=seq; merge(next,operation); next.outbox.push(structuredClone(operation)); return {state:next,operation};
}
export function session(state: PairModel): ModelSession {
  assertActive(state); return {pair:state.pair,grant:state.grant,peer:state.peer};
}
export function receive(state: PairModel, op: Operation, authenticated: ModelSession): { state: PairModel; duplicate: boolean; ack: number } {
  assertActive(state,op?.scope);
  if (!authenticated || authenticated.pair!==state.pair || authenticated.grant!==state.grant || authenticated.peer!==state.peer || op.actor!==authenticated.peer) throw Error('peer');
  const encoded=validate(state,op), inbox=state.inbox[op.scope];
  if (op.seq<=inbox.floor) return {state:structuredClone(state),duplicate:true,ack:inbox.floor};
  if (op.seq>inbox.floor+64) throw Error('sequence-window');
  if (inbox.pending[String(op.seq)] !== undefined) {
    if (inbox.pending[String(op.seq)]!==encoded) throw Error('equivocation');
    return {state:structuredClone(state),duplicate:true,ack:inbox.floor};
  }
  const next=structuredClone(state); merge(next,op);
  const target=next.inbox[op.scope]; target.pending[String(op.seq)]=encoded;
  while (target.pending[String(target.floor+1)]!==undefined) { target.floor++; delete target.pending[String(target.floor)]; }
  return {state:next,duplicate:false,ack:target.floor};
}
export function acknowledge(state: PairModel, scope: Scope, through: number, authenticated: ModelSession): PairModel {
  assertActive(state,scope);
  if (authenticated.pair!==state.pair || authenticated.grant!==state.grant || authenticated.peer!==state.peer || !count(through) || through>state.next[scope]) throw Error('ack');
  const next=structuredClone(state); next.outbox=next.outbox.filter(op=>op.scope!==scope || op.seq>through); return next;
}
export function dispatch(state: PairModel, operation: Operation): Operation {
  assertActive(state,operation.scope); validate(state,operation);
  if (!state.outbox.some(op=>canonical(op)===canonical(operation))) throw Error('not-queued');
  return structuredClone(operation);
}
export function disableScope(state: PairModel, scope: Scope): PairModel {
  assertActive(state); const next=structuredClone(state); next.scopes=next.scopes.filter(s=>s!==scope); next.outbox=next.outbox.filter(op=>op.scope!==scope); return next;
}
export function revoke(state: PairModel): PairModel {
  const next=structuredClone(state); next.status='revoked'; next.confirmed={self:false,peer:false}; next.scopes=[]; next.outbox=[]; return next;
}
export function heads(state: PairModel, scope: Scope, key: string): Operation[] { return structuredClone(state.records[keyOf(scope,key)]?.heads ?? []); }
