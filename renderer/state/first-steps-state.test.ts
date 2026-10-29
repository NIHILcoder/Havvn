import { describe, expect, it, vi } from 'vitest';
import { createFirstStepsState, offerFirstSteps } from './first-steps-state';
import { FIRST_STEPS_KEY, FIRST_STEP_ROUTES, emptyFirstSteps, readFirstSteps } from '../../shared/first-steps';
import type { RoomState } from '../../shared/types';

function fixture(legacy = false) {
  const values = new Map<string, string>(legacy ? [['onboarded', '1']] : []);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
  const store = createFirstStepsState(() => storage);
  return { store, storage, values, progress: (route: typeof FIRST_STEP_ROUTES[number]) => store.getSnapshot().data.routes[route] };
}
const fresh = async () => ({ downloads: [], rooms: [] });
describe('first steps lifecycle', () => {
  it('offers an empty confirmed install once; dismissal completes no steps', async () => {
    const f = fixture();
    expect(await offerFirstSteps(f.store, fresh)).toBe(true);
    expect(await offerFirstSteps(f.store, fresh)).toBe(false);
    const restarted = createFirstStepsState(() => f.storage);
    expect(await offerFirstSteps(restarted, fresh)).toBe(false);
    expect(restarted.getSnapshot().data).toEqual(emptyFirstSteps(true));
  });
  it.each(['downloads', 'rooms'] as const)('suppresses introduction for existing %s', async key => {
    const f = fixture();
    expect(await offerFirstSteps(f.store, async () => ({ downloads: [], rooms: [], [key]: [{}] }))).toBe(false);
    expect(f.store.getSnapshot().data.seen).toBe(true);
  });
  it('preserves old dismissal without inventing progress or fetching user data', async () => {
    const f = fixture(true), load = vi.fn(fresh);
    expect(await offerFirstSteps(f.store, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().data).toEqual(emptyFirstSteps(true));
  });
  it('failed inventory is not an empty profile; a later read may retry', async () => {
    const f = fixture();
    expect(await offerFirstSteps(f.store, async () => { throw Error('offline'); })).toBe(false);
    expect(f.store.getSnapshot().data.seen).toBe(false);
    expect(await offerFirstSteps(f.store, fresh)).toBe(true);
  });
  it('does not reopen when Help already marked seen during inventory loading', async () => {
    const f = fixture();
    const pending = offerFirstSteps(f.store, async () => { f.store.markSeen(); return fresh(); });
    expect(await pending).toBe(false);
  });
  it('unreadable storage suppresses automatic introduction but allows manual guides', async () => {
    const store = createFirstStepsState(() => { throw Error('blocked'); });
    expect(await offerFirstSteps(store, fresh)).toBe(false);
    expect(() => store.begin('watch')).not.toThrow();
    store.mediaPlaying('d1');
    expect(store.getSnapshot().data.routes.watch.done).toBe(true);
    expect(store.getSnapshot().storageError).toBe(true);
  });
  it('progress write failure cannot reject an actual successful action and can recover', () => {
    const f = fixture(); f.store.begin('download');
    f.storage.setItem.mockImplementationOnce(() => { throw Error('quota'); });
    expect(() => f.store.downloadAdded('d1')).not.toThrow();
    expect(f.store.getSnapshot().storageError).toBe(true);
    f.store.observeDownload({ id: 'd1', downloadedBytes: 1, progress: 0 });
    expect(f.store.getSnapshot().storageError).toBe(false);
    expect(createFirstStepsState(() => f.storage).getSnapshot().data.routes.download.done).toBe(true);
  });
  it('restores independent progress and never changes application preferences', () => {
    const f = fixture(); f.values.set('theme', 'light'); f.values.set('startPage', 'rooms');
    f.store.begin('watch'); f.store.mediaPlaying('d1'); f.store.begin('share'); f.store.roomReady('r1');
    const restarted = createFirstStepsState(() => f.storage); restarted.begin('watch');
    expect(restarted.getSnapshot().data.routes.watch.done).toBe(true);
    expect(restarted.getSnapshot().data.routes.share).toEqual({ prepared: true, done: false, target: 'r1' });
    expect(f.values.get('theme')).toBe('light'); expect(f.values.get('startPage')).toBe('rooms');
    expect(f.storage.setItem.mock.calls.every(([key]) => key === FIRST_STEPS_KEY)).toBe(true);
  });
  it('does not publish or rewrite stable snapshots for repeated high-frequency facts', () => {
    const f = fixture(), listener = vi.fn(); f.store.begin('watch'); f.store.mediaPlaying('d1');
    const snapshot = f.store.getSnapshot(), count = f.storage.setItem.mock.calls.length;
    const off = f.store.subscribe(listener); f.store.mediaPlaying('d1'); off();
    expect(listener).not.toHaveBeenCalled(); expect(f.store.getSnapshot()).toBe(snapshot);
    expect(f.storage.setItem).toHaveBeenCalledTimes(count);
  });
});
describe('real result evidence', () => {
  it('does not complete a route just by choosing it or receiving unrelated events', () => {
    const f = fixture(); f.store.begin('download'); f.store.mediaPlaying('d1'); f.store.filePublished('r1', [{ addedBy: 'me' }], 'me');
    expect(f.store.getSnapshot().data.routes).toEqual(emptyFirstSteps().routes);
  });
  it('requires the confirmed target download to actually receive data', () => {
    const f = fixture(); f.store.begin('download'); f.store.downloadAdded('d1');
    expect(f.progress('download').done).toBe(false);
    f.store.observeDownload({ id: 'other', downloadedBytes: 500, progress: 1 });
    f.store.observeDownload({ id: 'd1', downloadedBytes: 0, progress: 0 });
    expect(f.progress('download').done).toBe(false);
    f.store.observeDownload({ id: 'd1', downloadedBytes: 1, progress: 0.001 });
    expect(f.progress('download').done).toBe(true);
  });
  it('media metadata is preparation; playing is the result', () => {
    const f = fixture(); f.store.begin('watch'); f.store.mediaReady('d1');
    expect(f.progress('watch')).toEqual({ prepared: true, done: false, target: 'd1' });
    f.store.mediaPlaying('d1'); expect(f.progress('watch').done).toBe(true);
  });
  it('opening a room or receiving peer files never means the user published a file', () => {
    const f = fixture(); f.store.begin('share'); f.store.roomReady('r1');
    f.store.filePublished('r1', [{ addedBy: 'peer' }], 'me');
    f.store.filePublished('r1', [{ addedBy: 'me' }]);
    expect(f.progress('share').done).toBe(false);
    f.store.filePublished('r1', [{ addedBy: 'me' }], 'me'); expect(f.progress('share').done).toBe(true);
  });
  it('counts only this device’s running game server, with a real room id', () => {
    const f = fixture(); f.store.begin('play');
    f.store.observeServers('r1', [{ isHost: false, status: 'running' }, { isHost: true, status: 'starting' }]);
    f.store.observeServers('', [{ isHost: true, status: 'running' }]);
    expect(f.progress('play').done).toBe(false);
    f.store.observeServers('r1', [{ isHost: true, status: 'running' }]); expect(f.progress('play').done).toBe(true);
  });
  it.each([{ active: false }, { selfVip: '' }, { suspended: true }, { blocked: true }, { available: false }, { kicked: true }])('ignores unavailable or unready LAN: %j', override => {
    const f = fixture(); f.store.begin('play');
    const room = { roomId: 'r1', lan: { available: true, active: true, selfVip: '10.1.1.1', ...override }, ...('kicked' in override ? override : {}) } as RoomState;
    f.store.observeRoom(room); expect(f.progress('play').done).toBe(false);
  });
  it('accepts assigned, active local LAN and stores no address', () => {
    const f = fixture(); f.store.begin('play');
    f.store.observeRoom({ roomId: 'r1', lan: { available: true, active: true, selfVip: '10.1.1.1' } } as RoomState);
    expect(f.progress('play').done).toBe(true); expect(f.values.get(FIRST_STEPS_KEY)).not.toContain('10.1.1.1');
  });
});
describe('bounded local schema', () => {
  it.each(['invalid', '{', 'null', JSON.stringify({ version: 2, seen: true }), 'x'.repeat(4097)])('ignores malformed/unsupported state', raw => {
    expect(readFirstSteps(raw, true)).toEqual(emptyFirstSteps(true));
  });
  it('accepts known booleans and IDs only, drops extra data and invalid targets', () => {
    const state = readFirstSteps(JSON.stringify({ version: 1, active: 'arbitrary', seen: 1,
      routes: { download: { prepared: 'true', target: 'C:/private' }, watch: { done: true, target: 'd_1', url: 'magnet:private' } }, invite: 'secret',
    }));
    expect(state.active).toBeNull(); expect(state.seen).toBe(false);
    expect(state.routes.download).toEqual({ prepared: false, done: false });
    expect(state.routes.watch).toEqual({ prepared: true, done: true, target: 'd_1' });
    expect(JSON.stringify(state)).not.toMatch(/secret|private/);
  });
});
