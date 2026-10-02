import type { GossipMessage } from './room-protocol';
import type { RoomFile } from './types';
/** Shared desktop/browser limits. Paging changes transport, never signed contents. */
export const ROOM_FILE_LIMIT = 5000;
export const ROOM_MANIFEST_BYTES = 16 * 1024 * 1024;
export const ROOM_MANIFEST_ENTRY_BYTES = 64 * 1024;
export const ROOM_FOLDER_LIMIT = 512;
export const ROOM_FOLDER_TOMB_LIMIT = 5000;
export const ROOM_HELLO_BYTES = 96 * 1024;
export const ROOM_HELLO_ENTRIES = 64;
export const ROOM_HELLO_PARTS = 1024;
export interface ManifestPart { id: string; at: number; index: number; total: number }
type Hello = GossipMessage;
const arrays = ['files', 'have', 'tombs', 'folders', 'chatIds'];
const records = ['tombsAt', 'tombSigs', 'folderTombs', 'fileReacts', 'chatReacts', 'chatEdits'];
const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).length; }
export function validManifestPart(value: unknown): value is ManifestPart {
  const p = value as ManifestPart | null;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(p.id)
    && Number.isSafeInteger(p.at) && p.at > 0 && p.at <= Date.now() + 60_000 && Number.isInteger(p.total) && p.total > 0 && p.total <= ROOM_HELLO_PARTS
    && Number.isInteger(p.index) && p.index >= 0 && p.index < p.total;
}

/** O(n) packing; includes UTF-8 and JSON overhead, plus descriptor headroom. */
export function roomHelloParts(hello: Record<string, unknown>, id: string, at: number): Hello[] {
  const count = arrays.reduce((n, k) => n + (Array.isArray(hello[k]) ? hello[k].length : 0), 0)
    + records.reduce((n, k) => n + Object.keys(hello[k] || {}).length, 0);
  if (count <= ROOM_HELLO_ENTRIES && jsonBytes(hello) <= ROOM_HELLO_BYTES) return [hello as Hello];
  const base = { ...hello } as Hello;
  for (const key of [...arrays, ...records]) delete base[key];
  delete base.manifestPart;
  const baseBytes = jsonBytes(base) + 512;
  if (baseBytes > ROOM_HELLO_BYTES) throw new Error('Room HELLO control metadata exceeds its transport budget');
  const result: Hello[] = [];
  let page: Hello = { t: 'hello' }, bytes = 0, entries = 0;
  const next = () => {
    page = { ...base, files: [], have: [], tombs: [] };
    bytes = baseBytes; entries = 0; result.push(page);
  };
  next();
  for (const key of [...arrays, ...records]) {
    const isArray = arrays.includes(key);
    const values: [string, unknown][] = isArray ? ((hello[key] || []) as unknown[]).map(v => ['', v]) : Object.entries(hello[key] || {});
    for (const [entryKey, value] of values) {
      const cost = jsonBytes(value) + jsonBytes(entryKey) + key.length + 8;
      if (baseBytes + cost > ROOM_HELLO_BYTES) throw new Error('Room manifest entry exceeds its transport budget');
      if (entries && (entries >= ROOM_HELLO_ENTRIES || bytes + cost > ROOM_HELLO_BYTES)) next();
      if (isArray) (page![key] ??= []).push(value);
      else (page![key] ??= {})[entryKey] = value;
      entries!++; bytes! += cost;
    }
  }
  if (result.length > ROOM_HELLO_PARTS) throw new Error('Room manifest exceeds its transport budget');
  return result.map((part, index) => ({ ...part, manifestFull: index === result.length - 1,
    manifestPart: { id, at, index, total: result.length },
    ...(hello._g ? { _g: `${id}-${index}` } : {}),
  }));
}

/** Apply pages incrementally; only availability and a small bitmap need assembly. */
export class RoomHelloAssembly {
  private members = new Map<string, { part: ManifestPart; seen: Set<number>; have: Set<string>; bytes: number }>();
  private bytes = 0;
  constructor(private memberLimit = 256, private retainHave = true) {}
  accept(msg: Hello): { accepted: boolean; first: boolean; complete: boolean; have?: string[] } {
    const part = msg.manifestPart;
    if (!part) return { accepted: true, first: true, complete: msg.manifestFull === true };
    if (!validManifestPart(part)) return { accepted: false, first: false, complete: false };
    let state = this.members.get(msg.memberId);
    if (state && state.part.id !== part.id && part.at <= state.part.at) return { accepted: false, first: false, complete: false };
    if (!state || state.part.id !== part.id) {
      if (!state && this.members.size >= this.memberLimit) return { accepted: false, first: false, complete: false };
      if (state) this.bytes -= state.bytes;
      state = { part, seen: new Set(), have: new Set(), bytes: 0 }; this.members.set(msg.memberId, state);
    }
    if (state.part.total !== part.total || state.part.at !== part.at || state.seen.has(part.index)) {
      return { accepted: false, first: false, complete: false };
    }
    const first = state.seen.size === 0;
    state.seen.add(part.index);
    if (this.retainHave) for (const id of msg.have || []) {
      if (state.have.has(id) || state.have.size >= ROOM_FILE_LIMIT) continue;
      const bytes = encoder.encode(id).length;
      if (state.bytes + bytes > 512 * 1024 || this.bytes + bytes > ROOM_MANIFEST_BYTES) continue;
      state.have.add(id); state.bytes += bytes; this.bytes += bytes;
    }
    const complete = state.seen.size === part.total, have = this.retainHave ? [...state.have] : undefined;
    if (complete) { this.bytes -= state.bytes; state.bytes = 0; state.have.clear(); }
    return { accepted: true, first, complete, have };
  }
  clear(): void { this.members.clear(); this.bytes = 0; }
}

/** One replaceable snapshot per wire. Round-robin pacing keeps control traffic free. */
export class RoomHelloOutbox {
  private jobs = new Map<object, { pages: Hello[]; next: number; send: (msg: Hello) => void; ready: () => boolean | null }>();
  private relays: { msg: Hello; bytes: number; send: (msg: Hello) => void; ready: () => boolean | null }[] = [];
  private relayBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  enqueue(wire: object, pages: Hello[], send: (msg: Hello) => void, ready: () => boolean | null): void {
    if (this.closed || !this.jobs.has(wire) && this.jobs.size >= 64) return;
    this.jobs.set(wire, { pages, next: 0, send, ready });
    this.schedule(0);
  }
  relay(msg: Hello, send: (msg: Hello) => void, ready: () => boolean | null): boolean {
    const bytes = jsonBytes(msg);
    if (this.closed || this.relays.length >= 256 || this.relayBytes + bytes > 4_000_000) return false;
    this.relays.push({ msg, bytes, send, ready }); this.relayBytes += bytes; this.schedule(0);
    return true;
  }
  private schedule(delay: number): void {
    if (!this.timer && (this.jobs.size || this.relays.length) && !this.closed) this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, delay);
  }
  private tick(): void {
    // Relay gets every other turn while local snapshots are pending.
    if (this.relays.length && (!this.jobs.size || this.relayTurn)) {
      this.relayTurn = false;
      for (let i = 0, n = this.relays.length; i < n; i++) {
        const job = this.relays.shift()!, ready = job.ready();
        if (ready === false) { this.relays.push(job); continue; }
        this.relayBytes -= job.bytes;
        if (ready === null) continue;
        job.send(job.msg); this.schedule(this.delay(job.msg)); return;
      }
    }
    this.relayTurn = true;
    for (const [wire, job] of this.jobs) {
      const ready = job.ready();
      if (ready === null) { this.jobs.delete(wire); continue; }
      if (!ready) continue;
      const page = job.pages[job.next++];
      this.jobs.delete(wire);
      if (job.next < job.pages.length) this.jobs.set(wire, job);
      job.send(page);
      // Account for expensive signed entry verification at the receiver as well.
      this.schedule(this.delay(page));
      return;
    }
    this.schedule(100);
  }
  private relayTurn = true;
  private delay(page: Hello): number {
    const proofs = Object.keys(page.tombSigs || {}).length + Object.keys(page.chatEdits || {}).length
      + (page.files || []).filter((f: { revSig?: unknown }) => f.revSig).length + (page.transferChain?.length || 0)
      + (page.cfg ? 3 : 0) + (page.topicMsg ? 1 : 0) + (page.banState ? 1 : 0) + 2;
    return Math.max(20, proofs * 12, jsonBytes(page) / 250);
  }
  stop(): void {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.jobs.clear(); this.relays = []; this.relayBytes = 0;
  }
}

/** simple-peer's private channel is used only for backpressure, never identity. */
export function roomChannelHasCapacity(peer: unknown): boolean {
  const amount = (peer as { _channel?: { bufferedAmount?: number } } | null)?._channel?.bufferedAmount;
  return amount === undefined || Number.isFinite(amount) && amount < 512 * 1024;
}

const manifestBudgets = new WeakMap<object, { sizes: Map<string, number>; bytes: number }>();
function manifestBudget(files: ReadonlyMap<string, RoomFile>) {
  let budget = manifestBudgets.get(files);
  // Deletions release their budget. Normal additions update it incrementally.
  if (!budget || budget.sizes.size !== files.size) {
    const sizes = new Map([...files].map(([id, file]) => [id, jsonBytes(file)]));
    budget = { sizes, bytes: [...sizes.values()].reduce((a, b) => a + b, 0) };
    manifestBudgets.set(files, budget);
  }
  return budget;
}
export function roomManifestCanFit(files: ReadonlyMap<string, RoomFile>, file: RoomFile): boolean {
  const budget = manifestBudget(files);
  const bytes = jsonBytes(file);
  return bytes <= ROOM_MANIFEST_ENTRY_BYTES && (files.has(file.fileId) || files.size < ROOM_FILE_LIMIT)
    && budget.bytes - (budget.sizes.get(file.fileId) || 0) + bytes <= ROOM_MANIFEST_BYTES;
}
export function storeRoomManifestFile<T extends RoomFile>(files: Map<string, T>, file: T): boolean {
  if (!roomManifestCanFit(files, file)) return false;
  const budget = manifestBudget(files), bytes = jsonBytes(file);
  budget.bytes += bytes - (budget.sizes.get(file.fileId) || 0); budget.sizes.set(file.fileId, bytes);
  files.set(file.fileId, file); return true;
}
