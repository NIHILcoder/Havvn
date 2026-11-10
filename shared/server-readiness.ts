import type { MirroredServerInstance, RoomServerInstance } from './gameserver-types';
import type { RoomFile, RoomState } from './types';
import { parseServerSharedContent, preparationAddress, preparationFiles, preparationNetwork } from './server-preparation';
export const SERVER_PREPARATION_CAPABILITY = 'server-preparation-v1';
export const SERVER_PREPARATION_TTL = 60_000;
export const SERVER_PREPARATION_STATES = ['ready', 'receiving', 'files', 'network', 'confirm', 'unavailable', 'withdrawn'] as const;
export type ServerPreparationStatus = typeof SERVER_PREPARATION_STATES[number];
export interface ServerPreparationReport { memberId: string; hostId: string; instanceId: string; basis: string; state: ServerPreparationStatus; readyFiles: number | null; totalFiles: number | null; at: number }
export type ServerPreparationInput = Pick<ServerPreparationReport, 'hostId' | 'instanceId' | 'basis' | 'state' | 'readyFiles' | 'totalFiles'>;
export interface ServerPreparationWire extends ServerPreparationReport { t: typeof SERVER_PREPARATION_CAPABILITY; pub: string; sig: string }
const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const count = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000;
export function validServerPreparationInput(value: unknown): value is ServerPreparationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as ServerPreparationInput;
  return id(r.hostId) && id(r.instanceId) && typeof r.basis === 'string' && /^[a-f0-9]{64}$/.test(r.basis) && SERVER_PREPARATION_STATES.includes(r.state)
    && count(r.readyFiles) && count(r.totalFiles) && (r.readyFiles === null) === (r.totalFiles === null)
    && (r.readyFiles === null || r.readyFiles <= r.totalFiles!)
    && (r.state !== 'ready' || r.readyFiles !== null && r.readyFiles === r.totalFiles);
}
export function validServerPreparationWire(value: unknown): value is ServerPreparationWire {
  if (!validServerPreparationInput(value)) return false;
  const r = value as ServerPreparationWire;
  return r.t === SERVER_PREPARATION_CAPABILITY && typeof r.memberId === 'string' && /^[a-f0-9]{32}$/.test(r.memberId) && Number.isSafeInteger(r.at) && r.at >= 0
    && typeof r.pub === 'string' && r.pub.length > 0 && r.pub.length <= 2048 && typeof r.sig === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(r.sig);
}
export const serverPreparationCanonical = (topic: string, r: ServerPreparationReport) => new TextEncoder().encode(JSON.stringify([SERVER_PREPARATION_CAPABILITY, topic, r.memberId, r.hostId, r.instanceId, r.basis, r.state, r.readyFiles, r.totalFiles, r.at]));
export function serverPreparationBasis(hostId: string, instance: Pick<MirroredServerInstance, 'instanceId' | 'moduleId' | 'version' | 'status' | 'since' | 'sharedContent'>, files: Iterable<RoomFile>): string {
  const content = parseServerSharedContent(instance.sharedContent);
  const selected = !content ? [] : [...files].filter(file => content.some(slot => (file.folderId || '') === slot.folderId && slot.extensions.some(extension => file.name.toLowerCase().endsWith(extension))));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const slots = content?.map(slot => [slot.slotId, slot.folderId, [...slot.extensions].sort(compare), slot.compat ?? null]).sort((a, b) => compare(String(a[0]), String(b[0]))) ?? null;
  // Stopped mirrors may normalize a missing start time to their publication time.
  // Only a running process has a meaningful restart identity.
  return JSON.stringify(['havvn-preparation-basis-v1', hostId, instance.instanceId, instance.moduleId, instance.version, instance.status, instance.status === 'running' ? instance.since : 0, slots, selected.map(file => [file.fileId, file.infoHash]).sort((a, b) => compare(a[0], b[0]))]);
}
export function localServerPreparation(instance: RoomServerInstance, room: RoomState | null, confirmed: boolean): Pick<ServerPreparationInput, 'state' | 'readyFiles' | 'totalFiles'> {
  if (!room || instance.local || instance.sharedContent === undefined) return { state: 'unavailable', readyFiles: null, totalFiles: null };
  const files = preparationFiles(instance, room), missing = files.filter(file => !room.transfers[file.fileId]?.haveLocally);
  const counts = { readyFiles: files.length - missing.length, totalFiles: files.length };
  if (instance.status !== 'running') return { state: 'unavailable', ...counts };
  if (missing.length) return { state: missing.some(file => room.transfers[file.fileId]?.status === 'downloading' && !room.transfers[file.fileId]?.receivePaused) ? 'receiving' : 'files', ...counts };
  if (!['ready', 'local'].includes(preparationNetwork(instance, room)) || !preparationAddress(instance)) return { state: 'network', ...counts };
  return { state: confirmed ? 'ready' : 'confirm', ...counts };
}
export function serverPreparationRoster(instance: Pick<RoomServerInstance, 'hostId' | 'instanceId'>, room: RoomState, basis: string, now = Date.now()) {
  const reports = (room.serverPreparation ?? []).filter(report => validServerPreparationInput(report) && report.instanceId === instance.instanceId && report.hostId === instance.hostId && report.basis === basis && report.at <= now + 5000 && now - report.at <= SERVER_PREPARATION_TTL);
  return room.members.map(member => {
    const supported = !!member.isSelf || !member.guest && !!member.capabilities?.includes(SERVER_PREPARATION_CAPABILITY);
    const report = reports.filter(value => value.memberId === member.memberId).sort((a, b) => b.at - a.at)[0];
    const state = !member.online ? 'offline' as const : !supported ? 'unsupported' as const : !report || report.state === 'withdrawn' ? 'unknown' as const : report.state;
    return { member, state, report: state === 'offline' || state === 'unsupported' || state === 'unknown' ? null : report };
  });
}
/** Ephemeral self-reports only. Authentication/membership are checked by the transport. */
export class ServerPreparationBook {
  private records = new Map<string, ServerPreparationReport>();
  private prune(now: number) { for (const [key, value] of this.records) if (now - value.at > SERVER_PREPARATION_TTL) this.records.delete(key); }
  accept(report: ServerPreparationReport, basis: string, now = Date.now()): boolean {
    this.prune(now);
    if (!validServerPreparationInput(report) || !/^[a-f0-9]{32}$/.test(report.memberId) || !Number.isSafeInteger(report.at) || report.at > now + 5000 || now - report.at > SERVER_PREPARATION_TTL || report.basis !== basis) return false;
    const key = `${report.memberId}:${report.hostId}:${report.instanceId}`, previous = this.records.get(key);
    if (previous && (report.at <= previous.at || report.state !== 'withdrawn' && report.at - previous.at < 2000)) return false;
    if (!previous && (this.records.size >= 256 || [...this.records.values()].filter(value => value.memberId === report.memberId).length >= 8)) return false;
    this.records.set(key, { memberId: report.memberId, hostId: report.hostId, instanceId: report.instanceId, basis: report.basis, state: report.state, readyFiles: report.readyFiles, totalFiles: report.totalFiles, at: report.at }); return true;
  }
  list(now = Date.now()): ServerPreparationReport[] { this.prune(now); return [...this.records.values()].map(value => ({ ...value })); }
}
