import { describe, expect, it } from 'vitest';
import { parseServerSharedContent, preparationAddress, preparationFiles, preparationNetwork } from './server-preparation';
import { parseMirrorBody, serializeMirrorBody, buildMirrorPayload } from '../electron/gameserver/server-mirror';
import type { RoomServerInstance } from './gameserver-types';
import type { RoomState } from './types';

const instance = (patch: Partial<RoomServerInstance> = {}): RoomServerInstance => ({ instanceId: 's', moduleId: 'minecraft', name: 'server', version: 'Fabric 1.21', hostId: 'host', isHost: false, role: 'viewer', status: 'running', since: 0, autoRestart: false, updatable: false, ...patch });
const room = (patch: Partial<RoomState['lan']> = {}): RoomState => ({ files: [], transfers: {}, lan: { available: true, active: true, isHost: false, selfVip: '100.88.0.2', participants: [{ memberId: 'host', admitted: true, status: 'connected', vip: '100.88.0.1' }], ...patch } } as unknown as RoomState);
describe('server preparation', () => {
  it('never substitutes the viewer’s localhost for a remote server', () => {
    expect(preparationAddress(instance({ port: 25565 }))).toBeNull();
    expect(preparationAddress(instance({ isHost: true, port: 25565 }))).toBe('127.0.0.1:25565');
    expect(preparationAddress(instance({ status: 'stopped', address: '100.88.0.1:25565' }))).toBeNull();
  });
  it('requires a connected or relayed, admitted LAN route and a published address', () => {
    const server = instance({ address: '100.88.0.1:25565' });
    expect(preparationNetwork(server, null)).toBe('unknown');
    expect(preparationNetwork(server, room({ active: false, selfAdmitted: true }))).toBe('join');
    expect(preparationNetwork(server, room({ suspended: true }))).toBe('suspended');
    expect(preparationNetwork(server, room())).toBe('ready');
    expect(preparationNetwork(server, room({ participants: [] }))).toBe('host-missing');
    expect(preparationNetwork(server, room({ participants: [{ memberId: 'host', admitted: true, vip: '100.88.0.1', status: 'failed', relayVia: 'relay' }] }))).toBe('ready');
  });
  it('matches only the host’s published folder and supported extensions', () => {
    const state = room();
    state.files = [{ fileId: 'a', name: 'mod.jar', folderId: 'mods' }, { fileId: 'b', name: 'other.jar', folderId: 'other' }, { fileId: 'c', name: 'readme.txt', folderId: 'mods' }] as RoomState['files'];
    expect(preparationFiles(instance({ sharedContent: [{ slotId: 'mods', folderId: 'mods', extensions: ['.jar'] }] }), state).map(f => f.fileId)).toEqual(['a']);
    expect(preparationFiles(instance(), state)).toEqual([]);
  });
  it('drops malformed or oversized metadata without rejecting a legacy server mirror', () => {
    expect(parseServerSharedContent([{ slotId: 'mods', folderId: '', extensions: ['../exe'] }])).toBeUndefined();
    expect(parseServerSharedContent(Array(17).fill({ slotId: 'mods', folderId: '', extensions: ['.jar'] }))).toBeUndefined();
    expect(parseServerSharedContent(null)).toBeUndefined();
    const content = [{ slotId: 'mods', folderId: 'folder', extensions: ['.jar'], compat: 'fabric:1.21' }];
    const state = buildMirrorPayload('host', [instance({ sharedContent: content })], {});
    expect(parseMirrorBody(serializeMirrorBody(state))?.instances[0].sharedContent).toEqual(content);
    delete state.instances[0].sharedContent;
    expect(parseMirrorBody(serializeMirrorBody(state))?.instances[0].sharedContent).toBeUndefined();
  });
});
