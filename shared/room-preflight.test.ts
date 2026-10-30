import { expect, it } from 'vitest';
import { checkGuestEntry, checkRoomAction, checkRoomCapability } from './room-preflight';
import { DESKTOP_ROOM_CAPABILITIES, GUEST_ROOM_CAPABILITIES, readRoomCapabilities, validRoomCapabilities } from './room-capabilities';
import type { RoomState } from './types';

const room = (): RoomState => ({ ownerId: 'self', canManage: true, members: [
  { memberId: 'self', isSelf: true, online: true, capabilities: [...DESKTOP_ROOM_CAPABILITIES, 'file-sync-v1', 'room-documents-v2'] },
  { memberId: 'peer', online: true, capabilities: [...DESKTOP_ROOM_CAPABILITIES] },
], lan: { available: true, active: false, participants: [] } } as RoomState);

it('distinguishes missing, explicitly absent and advertised capabilities without a legacy grant', () => {
  expect(checkRoomCapability({}, 'lan')).toMatchObject({ status: 'unknown', canAttempt: false });
  expect(checkRoomCapability({ capabilities: [] }, 'lan')).toMatchObject({ status: 'unsupported', canAttempt: false });
  expect(checkRoomCapability({ capabilities: ['lan'] }, 'lan')).toMatchObject({ status: 'supported', canAttempt: true });
});
it('ignores future advertisements without rejecting a valid older greeting or inferring support', () => {
  const greeting = { protocolVersion: 3, capabilities: ['future-feature', 'watch-v2'] };
  expect(validRoomCapabilities(greeting)).toBe(true);
  expect(checkRoomCapability(readRoomCapabilities(greeting), 'lan').canAttempt).toBe(false);
  expect(checkRoomCapability(readRoomCapabilities(greeting), 'watch-v2').canAttempt).toBe(true);
});
it('allows a connection attempt without inventing a successful route or a NAT failure', () => {
  for (const action of ['watch', 'lan', 'file-sync', 'documents'] as const)
    expect(checkRoomAction(room(), action)).toEqual({ status: 'unknown', reason: 'network-unmeasured', next: 'try-connection', canAttempt: true });
});
it('does not treat room connectivity as a measured LAN path', () => {
  const state = room(); state.connected = true; state.peerCount = 2;
  expect(checkRoomAction(state, 'lan').status).toBe('unknown');
  state.lan.active = true; state.lan.participants = [{ memberId: 'peer', status: 'connected' }] as RoomState['lan']['participants'];
  expect(checkRoomAction(state, 'lan').status).toBe('supported');
});
it.each(['lan', 'file-sync', 'documents'] as const)('explains browser limitations for %s', action => {
  const state = room(); state.members[0].capabilities = [...GUEST_ROOM_CAPABILITIES];
  expect(checkRoomAction(state, action)).toMatchObject({ status: 'unsupported', canAttempt: false });
});
it('rechecks a disappearing or downgraded target and owner authority from current state', () => {
  const state = room();
  expect(checkRoomAction(state, 'watch-host', { targetId: 'peer' }).canAttempt).toBe(true);
  state.members[1].capabilities = undefined;
  expect(checkRoomAction(state, 'watch-host', { targetId: 'peer' })).toMatchObject({ status: 'unknown', canAttempt: false });
  state.members[1].online = false;
  expect(checkRoomAction(state, 'lan', { targetId: 'peer' }).reason).toBe('peer-unavailable');
  state.canManage = false;
  expect(checkRoomAction(state, 'watch-host').reason).toBe('owner-required');
});
it('checks local LAN prerequisites and the current admission', () => {
  const state = room();
  expect(checkRoomAction(state, 'lan', { lanJoin: true }).reason).toBe('lan-invite-required');
  state.lan.blocked = true; expect(checkRoomAction(state, 'lan').reason).toBe('lan-busy');
  state.lan.available = false; expect(checkRoomAction(state, 'lan').reason).toBe('lan-unavailable');
});
it('does not keep trusting an assigned watch host after its host-mode support disappears', () => {
  const state = room(); state.watchPolicy = { hostId: 'peer' } as RoomState['watchPolicy'];
  expect(checkRoomAction(state, 'watch', { targetId: 'peer' }).canAttempt).toBe(true);
  state.members[1].capabilities = ['watch-v2'];
  expect(checkRoomAction(state, 'watch', { targetId: 'peer' })).toMatchObject({ reason: 'capability-missing', canAttempt: false });
});
it('blocks removal, suspension and stopped engines without inspecting remote secrets', () => {
  expect(checkRoomAction(undefined, 'watch').canAttempt).toBe(false);
  const state = room(); state.kicked = true; expect(checkRoomAction(state, 'watch').reason).toBe('removed');
  state.kicked = false; expect(checkRoomAction(state, 'watch', { suspended: true }).reason).toBe('suspended');
  expect(checkRoomAction(state, 'watch', { engineReady: false }).reason).toBe('engine-unavailable');
  state.ownerId = ''; expect(checkRoomAction(state, 'file-sync').reason).toBe('owner-unknown');
});
it('rechecks browser APIs while leaving real connectivity unmeasured', () => {
  expect(checkGuestEntry({ crypto: false, webrtc: true })).toMatchObject({ reason: 'browser-crypto', canAttempt: false });
  expect(checkGuestEntry({ crypto: true, webrtc: false })).toMatchObject({ reason: 'browser-webrtc', canAttempt: false });
  expect(checkGuestEntry({ crypto: true, webrtc: true })).toMatchObject({ status: 'unknown', canAttempt: true });
});
