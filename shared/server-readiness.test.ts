import { expect, it } from 'vitest';
import crypto from 'node:crypto';
import { validateGossip } from './room-protocol';
import { gossipProofs } from './room-message-auth';
import { buildMirrorPayload, parseMirrorBody, serializeMirrorBody } from '../electron/gameserver/server-mirror';
import { DESKTOP_ROOM_CAPABILITIES, GUEST_ROOM_CAPABILITIES } from './room-capabilities';
import type { RoomServerInstance, RoomState } from './types';
import { ServerPreparationBook, SERVER_PREPARATION_CAPABILITY as CAP, serverPreparationBasis, serverPreparationCanonical, localServerPreparation, serverPreparationRoster, validServerPreparationWire, type ServerPreparationReport } from './server-readiness';

const self = 'a'.repeat(32), host = 'b'.repeat(32), now = 1_000_000;
const instance: RoomServerInstance = { instanceId: 'server-1', moduleId: 'minecraft', name: 'Test', version: '1.21', hostId: host, isHost: false, role: 'viewer', status: 'running', since: 1, autoRestart: false, updatable: false, address: '100.88.0.1:25565', sharedContent: [{ slotId: 'mods', folderId: 'mods', extensions: ['.jar'] }] };
const room = (): RoomState => ({ roomId: 'room', files: [{ fileId: 'f', name: 'mod.jar', folderId: 'mods', infoHash: 'c'.repeat(40) }], transfers: { f: { haveLocally: true } }, members: [{ memberId: self, name: 'Self', isSelf: true, online: true }, { memberId: host, name: 'Host', online: true, capabilities: [CAP] }, { memberId: 'legacy', name: 'Legacy', online: true }, { memberId: 'offline', name: 'Offline', online: false, capabilities: [CAP] }], lan: { available: true, active: true, isHost: false, selfVip: '100.88.0.2', participants: [{ memberId: host, admitted: true, status: 'connected', vip: '100.88.0.1' }] } } as unknown as RoomState);
const report = (patch: Partial<ServerPreparationReport> = {}): ServerPreparationReport => ({ memberId: self, hostId: host, instanceId: instance.instanceId, basis: 'd'.repeat(64), state: 'ready', readyFiles: 1, totalFiles: 1, at: now, ...patch });

it('reports local preparation conservatively and requires explicit user confirmation', () => {
  const r = room();
  expect(localServerPreparation(instance, r, false).state).toBe('confirm');
  expect(localServerPreparation(instance, r, true).state).toBe('ready');
  r.transfers.f.haveLocally = false;
  expect(localServerPreparation(instance, r, true).state).toBe('files');
  r.transfers.f.status = 'downloading';
  expect(localServerPreparation(instance, r, true).state).toBe('receiving');
  r.transfers.f.receivePaused = true;
  expect(localServerPreparation(instance, r, true).state).toBe('files');
  r.transfers.f.haveLocally = true; r.lan!.active = false;
  expect(localServerPreparation(instance, r, true).state).toBe('network');
  expect(localServerPreparation({ ...instance, sharedContent: undefined }, r, true)).toEqual({ state: 'unavailable', readyFiles: null, totalFiles: null });
});

it('invalidates preparation after file, server version, restart or ownership changes', () => {
  const r = room(), basis = serverPreparationBasis(host, instance, r.files);
  expect(serverPreparationBasis(host, { ...instance }, [...r.files].reverse())).toBe(basis);
  for (const patch of [{ version: '1.22' }, { since: 2 }, { status: 'stopped' as const }]) expect(serverPreparationBasis(host, { ...instance, ...patch }, r.files)).not.toBe(basis);
  expect(serverPreparationBasis(self, instance, r.files)).not.toBe(basis);
  expect(serverPreparationBasis(host, instance, [{ ...r.files[0], infoHash: 'e'.repeat(40) }])).not.toBe(basis);
  expect(serverPreparationBasis(host, instance, [...r.files, { ...r.files[0], fileId: 'ignored', folderId: 'elsewhere' }])).toBe(basis);
});

it('uses the same context on a host and a parsed peer mirror, including stopped servers', () => {
  for (const status of ['running', 'stopped'] as const) {
    const server = { ...instance, status, since: status === 'running' ? 1 : 0, sharedContent: [{ compat: '', extensions: ['.JAR'], folderId: 'mods', slotId: 'mods' }] };
    const mirror = parseMirrorBody(serializeMirrorBody(buildMirrorPayload(host, [server], {})))!;
    expect(serverPreparationBasis(host, server, room().files)).toBe(serverPreparationBasis(host, mirror.instances[0], room().files));
  }
});

it('never treats silence, withdrawn or expired reports, legacy clients or offline peers as ready', () => {
  const r = room(); r.serverPreparation = [report(), report({ memberId: host, state: 'withdrawn' }), report({ memberId: 'legacy' }), report({ memberId: 'offline' })];
  expect(serverPreparationRoster(instance, r, report().basis, now).map(row => row.state)).toEqual(['ready', 'unknown', 'unsupported', 'offline']);
  expect(serverPreparationRoster(instance, r, report().basis, now + 60_001)[0].state).toBe('unknown');
  expect(serverPreparationRoster(instance, r, 'f'.repeat(64), now)[0].state).toBe('unknown');
  expect(serverPreparationRoster(instance, r, report().basis, now - 5001)[0].state).toBe('unknown');
});

it('bounds reports, rejects replay and rapid updates, and permits immediate withdrawal', () => {
  const book = new ServerPreparationBook(), base = report();
  expect(book.accept(base, base.basis, now)).toBe(true);
  expect(book.accept(base, base.basis, now)).toBe(false);
  expect(book.accept(report({ at: now + 1 }), base.basis, now + 1)).toBe(false);
  expect(book.accept(report({ state: 'withdrawn', at: now + 2 }), base.basis, now + 2)).toBe(true);
  expect(book.accept(base, base.basis, now + 3)).toBe(false);
  expect(book.accept(report({ at: now + 3000, basis: 'f'.repeat(64) }), base.basis, now + 3000)).toBe(false);
  expect(book.accept(report({ at: now + 6000 }), base.basis, now)).toBe(false);
  for (let i = 1; i < 8; i++) expect(book.accept(report({ instanceId: 's' + i }), base.basis, now)).toBe(true);
  expect(book.accept(report({ instanceId: 'ninth' }), base.basis, now)).toBe(false);
  const list = book.list(now); list[0].state = 'ready'; expect(book.list(now)[0].state).toBe('withdrawn');
  expect(book.list(now + 60_003)).toEqual([]);
});

it('authenticates readiness in its room and binds every actor, context, count and state field', () => {
  const keys = crypto.generateKeyPairSync('ed25519'), pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const r = report({ memberId: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) });
  const wire = { ...r, t: CAP, pub, sig: crypto.sign(null, serverPreparationCanonical('room-A', r), keys.privateKey).toString('base64') };
  expect(validServerPreparationWire(wire)).toBe(true); expect(validateGossip(wire)).not.toBeNull();
  const verify = (frame: typeof wire, topic = 'room-A') => { const proof = gossipProofs(frame, topic, self)[0]; return crypto.verify(null, proof.bytes, pub, Buffer.from(proof.sig, 'base64')); };
  expect(verify(wire)).toBe(true); expect(verify(wire, 'room-B')).toBe(false);
  for (const patch of [{ memberId: self }, { hostId: self }, { instanceId: 'other' }, { basis: 'e'.repeat(64) }, { state: 'files' as const }, { readyFiles: 0 }, { totalFiles: 2 }, { at: now + 1 }]) expect(verify({ ...wire, ...patch })).toBe(false);
  for (const patch of [{ readyFiles: -1 }, { readyFiles: null }, { readyFiles: 0 }, { totalFiles: 100001 }, { state: 'launch' }, { at: Infinity }, { sig: 'invalid' }]) expect(validateGossip({ ...wire, ...patch })).toBeNull();
  expect(DESKTOP_ROOM_CAPABILITIES).toContain(CAP); expect(GUEST_ROOM_CAPABILITIES).not.toContain(CAP);
});
