import type { RoomState } from './types';

/** Desktop IPC only; the peer gossip protocol and public RoomState API stay stable. */
export type StatePatch =
  | { value: unknown }
  | { fields: Record<string, StatePatch>; remove?: string[] }
  | { key: string; entries: Record<string, StatePatch>; remove?: string[]; order?: string[] };
export type RoomStatePacket = { roomId: string; stream: string; revision: number } &
  ({ state: RoomState } | { base: number; patch: StatePatch });

const arrayKeys: Record<string, string> = {
  members: 'memberId', files: 'fileId', folders: 'id', chat: 'id', history: 'id', srvMirrors: 'hostId',
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const put = (value: object, key: string, item: unknown) =>
  Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });

function keyed(values: unknown[], key: string): Map<string, unknown> | undefined {
  const result = new Map<string, unknown>();
  for (const item of values) {
    if (!object(item) || typeof item[key] !== 'string' || result.has(item[key])) return;
    result.set(item[key], item);
  }
  return result;
}

function diff(previous: unknown, next: unknown, arrayKey?: string): StatePatch | undefined {
  if (Object.is(previous, next) && !object(next) && !Array.isArray(next)) return;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const before = arrayKey ? keyed(previous, arrayKey) : undefined;
    const after = arrayKey ? keyed(next, arrayKey) : undefined;
    if (before && after) {
      const entries: Record<string, StatePatch> = {};
      for (const [id, item] of after) {
        const patch = diff(before.get(id), item);
        if (patch) put(entries, id, patch);
      }
      const remove = [...before.keys()].filter(id => !after.has(id));
      const oldOrder = [...before.keys()], order = [...after.keys()];
      const reordered = order.length !== oldOrder.length || order.some((id, i) => id !== oldOrder[i]);
      if (!Object.keys(entries).length && !remove.length && !reordered) return;
      return { key: arrayKey!, entries, ...(remove.length ? { remove } : {}), ...(reordered ? { order } : {}) };
    }
    if (previous.length === next.length && next.every((item, i) => !diff(previous[i], item))) return;
  } else if (object(previous) && object(next)) {
    const fields: Record<string, StatePatch> = {};
    for (const [key, item] of Object.entries(next)) {
      const patch = own(previous, key) ? diff(previous[key], item, arrayKeys[key]) : { value: structuredClone(item) };
      if (patch) put(fields, key, patch);
    }
    const remove = Object.keys(previous).filter(key => !own(next, key));
    if (!Object.keys(fields).length && !remove.length) return;
    return { fields, ...(remove.length ? { remove } : {}) };
  }
  return { value: structuredClone(next) };
}

/** Copy only changed branches; unchanged files/chat retain decoder-local references. */
export function applyStatePatch(previous: unknown, patch: StatePatch): unknown {
  if ('value' in patch) return patch.value;
  if ('fields' in patch) {
    if (!object(previous)) throw new Error('Missing object baseline');
    const next = { ...previous };
    for (const key of patch.remove ?? []) delete next[key];
    for (const [key, item] of Object.entries(patch.fields)) put(next, key, applyStatePatch(previous[key], item));
    return next;
  }
  if (!Array.isArray(previous)) throw new Error('Missing collection baseline');
  const items = keyed(previous, patch.key);
  if (!items) throw new Error('Invalid collection baseline');
  for (const id of patch.remove ?? []) items.delete(id);
  for (const [id, item] of Object.entries(patch.entries)) items.set(id, applyStatePatch(items.get(id), item));
  const order = patch.order ?? [...items.keys()];
  if (order.length !== items.size || new Set(order).size !== order.length || order.some(id => !items.has(id))) throw new Error('Invalid collection order');
  return order.map(id => items.get(id));
}

export class RoomStateEncoder {
  private previous?: RoomState;
  private revision = 0;
  private readonly stream = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  encode(state: RoomState, full = false): RoomStatePacket | undefined {
    if (!this.previous || full) {
      this.previous = structuredClone(state);
      return { roomId: state.roomId, stream: this.stream, revision: ++this.revision, state: this.previous };
    }
    const patch = diff(this.previous, state);
    if (!patch) return;
    this.previous = applyStatePatch(this.previous, patch) as RoomState;
    return { roomId: state.roomId, stream: this.stream, base: this.revision, revision: ++this.revision, patch };
  }
}

export class RoomStateDecoder {
  private rooms = new Map<string, { stream: string; revision: number; state: RoomState }>();

  accept(packet: RoomStatePacket): RoomState | undefined {
    const previous = this.rooms.get(packet.roomId);
    if (!Number.isSafeInteger(packet.revision) || packet.revision < 1) return;
    if ('state' in packet) {
      if (packet.state.roomId !== packet.roomId || previous?.stream === packet.stream && previous.revision >= packet.revision) return;
      this.rooms.set(packet.roomId, { stream: packet.stream, revision: packet.revision, state: packet.state });
      return packet.state;
    }
    if (!previous || previous.stream !== packet.stream || previous.revision !== packet.base || packet.revision !== packet.base + 1) return;
    try {
      const state = applyStatePatch(previous.state, packet.patch) as RoomState;
      if (state.roomId !== packet.roomId) return;
      this.rooms.set(packet.roomId, { stream: packet.stream, revision: packet.revision, state });
      return state;
    } catch { return; }
  }

  delete(roomId: string): void { this.rooms.delete(roomId); }
  clear(): void { this.rooms.clear(); }
}
