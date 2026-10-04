/** Console acceptance is an stdin acknowledgement, never a game-level result. */
export type ServerCommandResult = { ok: true; command?: string } | { ok: false; reason: string };
export interface ServerCommandRequest {
  commandId: string; hostId: string; by: string; instanceId: string;
  command: string; at: number; expiresAt: number;
}
export interface ServerCommandReply {
  commandId: string; hostId: string; to: string; instanceId: string;
  ok: boolean; reason?: string; at: number;
}
export const SERVER_COMMAND_TTL = 30_000;
export const SERVER_COMMAND_TIMEOUT = 8_000;
export const validCommandId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(id);
export function validCommandRequest(r: ServerCommandRequest, now = Date.now()): boolean {
  return validCommandId(r.commandId) && typeof r.hostId === 'string' && !!r.hostId && r.hostId.length <= 128
    && typeof r.by === 'string' && !!r.by && r.by.length <= 128 && typeof r.instanceId === 'string' && !!r.instanceId && r.instanceId.length <= 128
    && typeof r.command === 'string' && !!r.command.trim() && r.command.length <= 512 && !/[\r\n\0]/.test(r.command)
    && Number.isSafeInteger(r.at) && Number.isSafeInteger(r.expiresAt) && r.at <= now + 5000
    && r.expiresAt > now && r.expiresAt > r.at && r.expiresAt - r.at <= SERVER_COMMAND_TTL;
}
export const commandCanonical = (topic: string, r: ServerCommandRequest): string =>
  JSON.stringify(['srv-cmd-v2', topic, r.by, r.hostId, r.instanceId, r.commandId, r.command, r.at, r.expiresAt]);
export const commandReplyCanonical = (topic: string, r: ServerCommandReply): string =>
  JSON.stringify(['srv-result-v2', topic, r.hostId, r.to, r.instanceId, r.commandId, r.ok, r.reason ?? '', r.at]);

/** A full cache refuses new work instead of evicting a still-replayable command.
 * It outlives room networking and server restarts within the main process. */
export class ServerCommandLedger {
  private readonly entries = new Map<string, { request: string; expiresAt: number; result: ServerCommandResult }>();
  constructor(private readonly capacity = 1024, private readonly now: () => number = Date.now) {}
  execute(roomId: string, r: ServerCommandRequest, run: () => ServerCommandResult): ServerCommandResult {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key);
    if (!validCommandRequest(r, now)) return { ok: false, reason: 'command-expired' };
    const key = JSON.stringify([roomId, r.by, r.commandId]);
    const fingerprint = JSON.stringify([r.hostId, r.instanceId, r.command, r.expiresAt]);
    const previous = this.entries.get(key);
    if (previous) return previous.request === fingerprint ? previous.result : { ok: false, reason: 'command-conflict' };
    if (this.entries.size >= this.capacity) return { ok: false, reason: 'command-busy' };
    // Reserve BEFORE touching stdin, including when the process rejects it.
    const entry = { request: fingerprint, expiresAt: r.expiresAt, result: { ok: false, reason: 'command-unknown' } as ServerCommandResult };
    this.entries.set(key, entry);
    try { entry.result = run(); } catch { /* cannot safely repeat a possibly written command */ }
    return entry.result;
  }
}

/** Bounded pending requests. Wrong host/recipient/instance cannot settle one. */
export class PendingServerCommands {
  private readonly entries = new Map<string, { request: ServerCommandRequest; timer: ReturnType<typeof setTimeout>; resolve: (r: ServerCommandResult) => void }>();
  wait(request: ServerCommandRequest): Promise<ServerCommandResult> {
    if (this.entries.size >= 32 || this.entries.has(request.commandId)) throw new Error('command-busy');
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.entries.delete(request.commandId); resolve({ ok: false, reason: 'command-unknown' }); }, Math.min(SERVER_COMMAND_TIMEOUT, request.expiresAt - Date.now()));
      this.entries.set(request.commandId, { request, timer, resolve });
    });
  }
  accept(reply: ServerCommandReply): boolean {
    const p = this.entries.get(reply.commandId);
    if (!p || reply.hostId !== p.request.hostId || reply.to !== p.request.by || reply.instanceId !== p.request.instanceId
      || !Number.isSafeInteger(reply.at) || reply.at < p.request.at - 5000 || reply.at > Date.now() + 5000 || p.request.expiresAt <= Date.now()) return false;
    this.entries.delete(reply.commandId); clearTimeout(p.timer);
    p.resolve(reply.ok ? { ok: true } : { ok: false, reason: reply.reason || 'command-unknown' });
    return true;
  }
  cancel(): void {
    for (const p of this.entries.values()) { clearTimeout(p.timer); p.resolve({ ok: false, reason: 'command-unknown' }); }
    this.entries.clear();
  }
}
