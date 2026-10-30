/* eslint-disable @typescript-eslint/no-explicit-any -- Production engine handlers run without hardware/network bootstrap. */
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ServerPreparationBook, SERVER_PREPARATION_CAPABILITY, serverPreparationBasis, serverPreparationCanonical, validServerPreparationInput } from '../../shared/server-readiness';
import { parseMirrorBody, serializeMirrorBody, buildMirrorPayload } from '../gameserver/server-mirror';
import { deriveMemberId } from './room-crypto';
import type { RoomServerInstance } from '../../shared/types';

const source = readFileSync(new URL('./room-engine.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error('Engine fixture boundary missing');
  return source.slice(a, b);
}
const fn = (name: string) => extract('function ' + name + '(', '\n}\n') + '\n}';
const helpers = extract('const preparationBooks =', '\n\n/** Our signed');
const commandStart = "    else if (type === 'serverPreparation') {";
const command = extract(commandStart, "\n    else if (type === 'documentsSend')").slice(commandStart.length).replace(/}\s*$/, '');
const receive = extract('    case SERVER_PREPARATION_CAPABILITY: {', '    case DOCUMENT_CAPABILITY:');
const identities = Array.from({ length: 2 }, () => { const keys = crypto.generateKeyPairSync('ed25519'); const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(); return { pub, priv: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), memberId: deriveMemberId(pub) }; });
const server: RoomServerInstance = { instanceId: 'test-server', moduleId: 'minecraft', name: 'Test', version: '1.21', hostId: identities[0].memberId, isHost: true, role: 'host', status: 'running', since: 1, autoRestart: false, updatable: false, sharedContent: [] };
const mirror = buildMirrorPayload(server.hostId, [server], {});
const basis = crypto.createHash('sha256').update(serverPreparationBasis(server.hostId, server, [])).digest('hex');
function fixture(index = 0) {
  const room = { roomId: 'room', topic: 'same-room-topic', self: identities[index], identities: new Map(), members: new Map(identities.map(i => [i.memberId, { capabilities: [SERVER_PREPARATION_CAPABILITY], guest: false }])), files: new Map(), bans: new Set(), srvMirrors: new Map([[mirror.hostId, mirror]]), kicked: false };
  const ctx: any = { room, rooms: new Map([['room', room]]), crypto, Buffer, Date, WeakMap, Map, ServerPreparationBook, SERVER_PREPARATION_CAPABILITY, serverPreparationBasis, serverPreparationCanonical, validServerPreparationInput, parseMirrorBody, deriveMemberId, ROOM_IDENTITY_LIMIT: 2048, netSuspended: false, broadcast: vi.fn(), pushState: vi.fn(), log: vi.fn(), ipcRenderer: { send: vi.fn() } };
  const code = helpers + [fn('signBytes'), fn('bindIdentity'), fn('idMatchesPub'), fn('verifySignedBy')].join('\n') + `\nasync function submit(msg){let data;${command}return data;}\nfunction receive(msg){switch(msg.t){${receive}}}\nfunction reports(room){return preparationBook(room).list();}`;
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, ctx);
  const input = { hostId: mirror.hostId, instanceId: server.instanceId, basis, state: 'ready', readyFiles: 0, totalFiles: 0 };
  return { ctx, room, input, submit: (patch = {}) => ctx.submit({ roomId: 'room', input, ownMirror: serializeMirrorBody(mirror), ...patch }), reports: () => ctx.reports(room) };
}

it('sends a signed self-report through the real command handler and accepts it at another engine', async () => {
  const a = fixture(), b = fixture(1);
  expect(await a.submit()).toEqual({ ok: true });
  const frame = a.ctx.broadcast.mock.calls[0][1];
  expect(frame.memberId).toBe(identities[0].memberId);
  b.ctx.receive(frame);
  expect(b.reports()).toHaveLength(1); expect(b.reports()[0].state).toBe('ready');
  expect(a.ctx.pushState).toHaveBeenCalledOnce(); expect(b.ctx.pushState).toHaveBeenCalledOnce();
});
it('rejects changed contexts, malformed commands and suspended or kicked rooms before publication', async () => {
  const f = fixture();
  await expect(f.submit({ input: { ...f.input, basis: 'f'.repeat(64) } })).rejects.toThrow('changed');
  await expect(f.submit({ input: { ...f.input, readyFiles: null } })).rejects.toThrow('unavailable');
  f.ctx.netSuspended = true; await expect(f.submit()).rejects.toThrow('unavailable'); f.ctx.netSuspended = false;
  f.room.kicked = true; await expect(f.submit()).rejects.toThrow('unavailable');
  expect(f.ctx.broadcast).not.toHaveBeenCalled();
});
it('does not admit an unknown, banned, guest, unsupported or impersonating sender', async () => {
  const a = fixture(); await a.submit(); const frame = a.ctx.broadcast.mock.calls[0][1];
  for (const kind of ['unknown', 'banned', 'guest', 'unsupported', 'impersonated']) {
    const b = fixture(1), member = b.room.members.get(frame.memberId)!;
    if (kind === 'unknown') b.room.members.delete(frame.memberId);
    if (kind === 'banned') b.room.bans.add(frame.memberId);
    if (kind === 'guest') member.guest = true;
    if (kind === 'unsupported') member.capabilities = [];
    b.ctx.receive(kind === 'impersonated' ? { ...frame, memberId: identities[1].memberId } : frame);
    expect(b.reports(), kind).toHaveLength(0); expect(b.ctx.pushState).not.toHaveBeenCalled();
  }
});
it('allows immediate withdrawal, rejects replay and requires a compatible server host', async () => {
  const a = fixture(), b = fixture(1); await a.submit(); const first = a.ctx.broadcast.mock.calls[0][1]; b.ctx.receive(first);
  await a.submit({ input: { ...a.input, state: 'withdrawn' } }); const withdrawal = a.ctx.broadcast.mock.calls[1][1]; b.ctx.receive(withdrawal); b.ctx.receive(first);
  expect(b.reports()[0].state).toBe('withdrawn');
  const c = fixture(1); c.room.members.get(mirror.hostId)!.capabilities = [];
  await expect(c.submit()).rejects.toThrow('compatible host'); expect(c.ctx.broadcast).not.toHaveBeenCalled();
});
