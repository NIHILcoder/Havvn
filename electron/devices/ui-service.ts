import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  DeviceError,
  deviceScopes,
  deviceHex,
  validateDeviceInvite,
  type DeviceScope,
  type DeviceJson,
} from "../../shared/device-pairing";
import {
  validateDeviceValue,
  deviceDataCanonical,
} from "../../shared/device-data";
import type {
  DeviceCapture,
  DeviceUiConfig,
  DeviceUiState,
  DeviceUiRequest,
  DeviceUiResult,
} from "../../shared/device-ui";
import {
  emptyDeviceUiConfig,
  validateDeviceUiConfig,
  type DeviceUiConfigIo,
} from "./ui-config";
import { DeviceVault } from "./vault";
import { DeviceReplicator, type DeviceDataTarget } from "./replicator";
import { replicaHeads, replicaKey } from "./replica-state";
import {
  openDeviceBootstrap,
  pairDevice,
  type DeviceConsent,
} from "./bootstrap";
import {
  openDeviceSessionServer,
  connectDeviceSession,
  type DeviceSession,
} from "./session";
import type { DeviceDataSnapshot } from "./replica-state";
import type {
  DeviceSnapshotDecision,
  DeviceEndpoint,
} from "../../shared/device-ui";
export interface DeviceUiEnvironment {
  config: DeviceUiConfigIo;
  hasVault(): boolean;
  open(initialize: boolean): Promise<DeviceVault>;
  archive(): Promise<void>;
  renderer(vault: DeviceVault): DeviceDataTarget & {
    capture(scopes: DeviceScope[]): Promise<DeviceCapture>;
    close(): void;
  };
  refresh(): Promise<void>;
  addresses(): string[];
  changed(): void;
}
export class DeviceUiService {
  private config: DeviceUiConfig = emptyDeviceUiConfig();
  private error: string | null = null;
  private vault: DeviceVault | null = null;
  private target: ReturnType<DeviceUiEnvironment["renderer"]> | null = null;
  private replica: DeviceReplicator | null = null;
  private opening: Promise<void> | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private recovering = false;
  private bootstrap: Awaited<ReturnType<typeof openDeviceBootstrap>> | null =
    null;
  private server: Awaited<ReturnType<typeof openDeviceSessionServer>> | null =
    null;
  private session: DeviceSession | null = null;
  private generation = 0;
  private pairTask: Promise<void> | null = null;
  private confirmation: DeviceUiState["confirmation"] = null;
  private confirmResolve: ((accept: boolean) => void) | null = null;
  private observed: Map<string, string> | null = null;
  private capture: DeviceCapture = { records: [], issues: [] };
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private closed = false;
  private sent = new Set<string>();
  private outgoing: Promise<void> = Promise.resolve();
  private offers = new Map<
    DeviceScope,
    { id: string; snapshot: DeviceDataSnapshot }
  >();
  configuration() {
    return structuredClone(this.config);
  }
  constructor(private env: DeviceUiEnvironment) {
    try {
      this.config = env.config.read();
    } catch {
      this.error = "config";
    }
  }
  toJSON() {
    return { enabled: this.config.enabled, status: this.state().status };
  }
  [inspect.custom]() {
    return this.toJSON();
  }
  private notify() {
    if (!this.closed) this.env.changed();
  }
  private fail(error: unknown) {
    this.error = error instanceof DeviceError ? error.code : "storage";
    this.notify();
  }
  state(): DeviceUiState {
    const v = this.vault,
      s = v?.snapshot(),
      active = s?.status === "active",
      records = active && v ? v.replicaState().records : {};
    let status: DeviceUiState["status"] = !this.config.enabled
      ? "off"
      : this.opening
        ? "opening"
        : this.error
          ? "error"
          : this.confirmation
            ? "confirming"
            : this.bootstrap
              ? "inviting"
              : this.session
                ? "online"
                : this.connecting
                  ? "connecting"
                  : s?.status === "active"
                    ? "offline"
                    : s?.status === "prepared"
                      ? "prepared"
                      : s?.status === "pending"
                        ? "pending"
                        : s?.status === "revoked"
                          ? "revoked"
                          : "unpaired";
    if (s?.status === "paused-error") status = "error";
    const summary = this.replica && active ? this.replica.status() : null;
    return {
      enabled: this.config.enabled,
      lastApplied: summary?.lastApplied ?? null,
      status,
      error: this.error,
      self: s?.deviceId ?? null,
      peer: s?.peerId ?? null,
      grant: s?.grantId ?? null,
      scopes: s?.scopes ?? this.config.scopes,
      approved: active && v ? v.dataApproved() : false,
      config: structuredClone(this.config),
      addresses: this.env.addresses(),
      confirmation: this.confirmation
        ? structuredClone(this.confirmation)
        : null,
      outbox: s?.outbox ?? 0,
      pending: summary?.pending ?? 0,
      conflicts: summary?.conflicts ?? 0,
      recovering: this.recovering,
      records: Object.values(records)
        .filter((r) => r.issue !== null || r.heads.length > 1)
        .slice(0, 256)
        .map((r) => ({
          scope: r.heads[0].scope,
          recordId: r.heads[0].recordId,
          heads: replicaHeads(r.heads),
          issue: r.issue,
          variants: r.heads.map((h) => ({
            author: h.from,
            sequence: h.sequence,
            deleted: h.deleted,
            value: structuredClone(h.value),
          })),
        })),
      inventory: {
        preferences: this.capture.records.filter(
          (r) => r.scope === "preferences",
        ).length,
        views: this.capture.records.filter(
          (r) => r.scope === "views" && r.recordId !== "order",
        ).length,
        playback: this.capture.records.filter((r) => r.scope === "playback")
          .length,
      },
      issues: structuredClone(this.capture.issues),
      localRecords: structuredClone(this.capture.records),
      snapshotOffer: (() => {
        const offer = this.offers.values().next().value;
        return offer
          ? {
              id: offer.id,
              scope: offer.snapshot.scope,
              records: offer.snapshot.records.length,
              watermark: offer.snapshot.watermark,
            }
          : null;
      })(),
    };
  }
  private save(next: DeviceUiConfig) {
    this.env.config.write(next);
    this.config = next;
  }
  async start() {
    if (this.closed) throw new DeviceError("state");
    if (!this.config.enabled || this.error === "config") return this.state();
    if (this.opening) {
      await this.opening;
      return this.state();
    }
    if (this.vault) {
      await this.run(async () => {
        if (this.vault?.dataApproved()) await this.replica?.recover();
        await this.collect(true);
      });
      return this.state();
    }
    this.opening = (async () => {
      try {
        this.vault = await this.env.open(false);
        await this.attach();
      } catch (error) {
        this.fail(error);
      } finally {
        this.opening = null;
        this.notify();
      }
    })();
    this.notify();
    await this.opening;
    return this.state();
  }
  private async attach() {
    if (!this.vault) throw new DeviceError("state");
    this.target = this.env.renderer(this.vault);
    this.replica = new DeviceReplicator(this.vault, this.target);
    if (["active", "prepared"].includes(this.vault.snapshot().status)) {
      this.recovering = true;
      this.notify();
      try {
        await this.env.refresh();
        if (this.vault.snapshot().status === "active") {
          if (this.vault.dataApproved()) await this.replica.recover();
          await this.collect(true);
        }
      } finally {
        this.recovering = false;
      }
      await this.startTransport();
    }
  }
  private consent(endpoint: DeviceEndpoint | null): DeviceConsent {
    return async (preview) => {
      if (this.confirmation) throw new DeviceError("state");
      const id = randomUUID(),
        expiresAt = Date.now() + 600000;
      this.confirmation = {
        id,
        self: preview.self.deviceId,
        peer: preview.peer.deviceId,
        scopes: preview.scopes,
        endpoint,
        expiresAt,
      };
      this.notify();
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (this.confirmation?.id === id) {
            this.confirmation = null;
            this.confirmResolve = null;
            this.notify();
          }
          resolve(false);
        }, 600000);
        this.confirmResolve = (value) => {
          clearTimeout(timer);
          this.confirmation = null;
          this.confirmResolve = null;
          this.notify();
          resolve(value);
        };
      });
    };
  }
  private async collect(initial = false) {
    if (
      !this.vault ||
      !this.target ||
      !this.replica ||
      this.vault.snapshot().status !== "active"
    )
      return;
    await this.env.refresh();
    const raw = await this.target.capture(this.vault.sessionAccess().scopes),
      seen = new Set<string>();
    const records = raw.records.map((r) => {
      if (
        !this.vault!.sessionAccess().scopes.includes(r.scope) ||
        typeof r.recordId !== "string" ||
        r.deleted
      )
        throw new DeviceError("invalid");
      const value = validateDeviceValue(r.scope, r.recordId, r.value),
        key = replicaKey(r.scope, r.recordId);
      if (seen.has(key)) throw new DeviceError("invalid");
      seen.add(key);
      return { ...r, value };
    });
    this.capture = { records, issues: raw.issues.slice(0, 256) };
    // A journal inherited from the backend prototype is not new UI consent.
    // publish() can recover an older job, so defer seeding until approval too.
    if (!this.vault.dataApproved() && this.vault.pendingDataJob()) {
      this.observed = null;
      this.notify();
      return;
    }
    const current = new Map(
        records.map((r) => [
          replicaKey(r.scope, r.recordId),
          deviceDataCanonical(r.value),
        ]),
      ),
      state = this.vault.replicaState(),
      failed = new Set<string>();
    for (const r of records) {
      const key = replicaKey(r.scope, r.recordId),
        known = state.records[key];
      if ((!this.observed || initial) && known) continue;
      if (this.observed?.get(key) === current.get(key)) continue;
      if (
        known?.heads.length === 1 &&
        !known.heads[0].deleted &&
        deviceDataCanonical(known.heads[0].value) === current.get(key)
      )
        continue;
      try {
        await this.replica.publish(r.scope, r.recordId, r.value);
      } catch (error) {
        failed.add(key);
        this.capture.issues.push({
          scope: r.scope,
          recordId: r.recordId,
          code: error instanceof DeviceError ? error.code : "storage",
        });
        this.fail(error);
      }
    }
    if (this.observed && !initial) {
      for (const [key] of this.observed) {
        if (current.has(key)) continue;
        const slash = key.indexOf("/"),
          scope = key.slice(0, slash) as DeviceScope,
          id = key.slice(slash + 1),
          known = state.records[key];
        if (
          !this.vault.sessionAccess().scopes.includes(scope) ||
          id === "order" ||
          !known ||
          known.heads.every((h) => h.deleted) ||
          raw.issues.some(
            (i) =>
              i.scope === scope && (i.recordId === id || scope === "playback"),
          )
        )
          continue;
        try {
          await this.replica.publish(scope, id, null, true);
        } catch (error) {
          failed.add(key);
          this.capture.issues.push({
            scope,
            recordId: id,
            code: error instanceof DeviceError ? error.code : "storage",
          });
          this.fail(error);
        }
      }
    }
    for (const key of failed) {
      const old = this.observed?.get(key);
      if (old !== undefined) current.set(key, old);
      else current.delete(key);
    }
    this.observed = current;
    if (!failed.size && this.error === "quota") this.error = null;
    this.notify();
    await this.flush();
  }
  localChanged() {
    if (!this.config.enabled || !this.replica || this.captureTimer) return;
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      void this.run(() => this.collect()).catch((error) => this.fail(error));
    }, 650);
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action);
    this.serial = next.catch(() => {});
    return next;
  }
  private async startTransport() {
    if (
      !this.config.enabled ||
      !this.vault ||
      !["active", "prepared"].includes(this.vault.snapshot().status) ||
      this.closed
    )
      return;
    this.error = null;
    if (this.config.remote) {
      void this.connect();
      return;
    }
    if (this.server) return;
    const generation = this.generation;
    this.server = await openDeviceSessionServer(
      this.vault,
      async (session) => {
        if (generation !== this.generation || this.session) {
          session.close();
          return;
        }
        await this.serveSession(session, generation);
      },
      () => {},
      this.config.listen,
    );
    if (this.config.listen.port !== this.server.port)
      this.save({
        ...this.config,
        listen: { ...this.config.listen, port: this.server.port },
      });
    this.notify();
  }
  private async connect() {
    if (
      this.connecting ||
      this.session ||
      !this.config.remote ||
      !this.vault ||
      this.closed
    )
      return;
    this.connecting = true;
    this.notify();
    const generation = this.generation;
    try {
      const session = await connectDeviceSession(
        this.vault,
        this.config.remote.port,
        this.config.remote.host,
      );
      if (generation !== this.generation) {
        session.close();
        return;
      }
      await this.serveSession(session, generation);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      this.connecting = false;
      if (
        generation === this.generation &&
        !this.closed &&
        this.config.enabled &&
        this.vault &&
        ["active", "prepared"].includes(this.vault.snapshot().status)
      ) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.connect();
        }, 5000);
      }
      this.notify();
    }
  }
  private async serveSession(session: DeviceSession, generation: number) {
    this.session = session;
    this.sent.clear();
    this.error = null;
    this.notify();
    const heartbeat = setInterval(() => {
      if (performance.now() - session.lastSeen() > 25000) {
        session.close();
        return;
      }
      void this.write(() => session.heartbeat()).catch(() => session.close());
    }, 5000);
    try {
      if (this.vault!.snapshot().status === "active" && !this.observed)
        await this.run(() => this.collect(true));
      await this.flush();
      await this.ackAll();
      while (generation === this.generation && this.session === session) {
        const message = await session.receive();
        if (message.kind === "ack") {
          const keys = new Set(
            this.vault!.outbound().map((op) => op.scope + ":" + op.sequence),
          );
          for (const key of this.sent)
            if (!keys.has(key)) this.sent.delete(key);
          await this.flush();
          if (this.error === "quota") this.localChanged();
          this.notify();
          continue;
        }
        if (message.kind === "snapshot") {
          this.offers.set(message.scope, {
            id: randomUUID(),
            snapshot: message,
          });
          this.notify();
          continue;
        }
        if (!this.vault!.dataApproved()) {
          await this.run(async () => {
            await this.vault!.receiveDataOperation(message);
            if (this.vault!.dataApproved()) {
              const ack = await this.replica!.retry(
                message.scope,
                message.recordId,
              );
              if (ack) await this.write(() => session.send(ack));
            }
          });
          this.notify();
          continue;
        }
        const ack = await this.run(() => this.replica!.receive(message));
        if (ack) await this.write(() => session.send(ack));
        this.notify();
      }
    } catch (error) {
      if (generation === this.generation && this.config.enabled)
        this.fail(error);
    } finally {
      clearInterval(heartbeat);
      session.close();
      if (this.session === session) {
        this.session = null;
        this.sent.clear();
      }
      this.notify();
    }
  }
  private write(action: () => Promise<void>) {
    const next = this.outgoing.then(action);
    this.outgoing = next.catch(() => {});
    return next;
  }
  private async flush() {
    if (!this.session || !this.vault || !this.vault.dataApproved()) return;
    const session = this.session,
      state = this.vault.replicaState();
    const outbound = this.vault.outbound(),
      floors: Partial<Record<DeviceScope, number>> = {};
    for (const op of outbound)
      floors[op.scope] = Math.min(floors[op.scope] ?? op.sequence, op.sequence);
    for (const op of outbound) {
      const key = op.scope + ":" + op.sequence;
      if (
        this.sent.has(key) ||
        op.sequence > (floors[op.scope] ?? op.sequence) + 63
      )
        continue;
      const r = state.records[replicaKey(op.scope, op.recordId)];
      if (
        r?.issue &&
        r.heads.some((h) => h.from === op.from && h.sequence === op.sequence)
      )
        continue;
      await this.write(async () => {
        if (this.session !== session) return;
        await session.send(op);
        this.sent.add(key);
      });
    }
  }
  private async ackAll() {
    if (!this.session || !this.vault || !this.vault.dataApproved()) return;
    const session = this.session,
      a = this.vault.sessionAccess(),
      state = this.vault.replicaState();
    for (const scope of a.scopes) {
      const through = state.inbox[scope].floor;
      if (through)
        await this.write(() =>
          session.send({
            version: 1,
            kind: "ack",
            pairId: a.pairId,
            grantId: a.grantId,
            from: this.vault!.publicIdentity().deviceId,
            to: a.peer.deviceId,
            scope,
            through,
          }),
        );
    }
  }
  private async stopTransport() {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connecting = false;
    this.session?.close();
    this.session = null;
    this.sent.clear();
    this.offers.clear();
    await this.bootstrap?.close();
    this.bootstrap = null;
    await this.server?.close();
    this.server = null;
  }
  private async selected(
    request: Extract<DeviceUiRequest, { kind: "preview" | "resolve" }>,
  ) {
    if (!this.vault || !this.replica || !this.target)
      throw new DeviceError("state");
    const record =
      this.vault.replicaState().records[
        replicaKey(request.scope, request.recordId)
      ];
    if (!record) throw new DeviceError("missing");
    let value: DeviceJson, deleted: boolean;
    if (request.local) {
      await this.collect(true);
      const found = this.capture.records.find(
        (r) => r.scope === request.scope && r.recordId === request.recordId,
      );
      if (found) {
        value = found.value;
        deleted = false;
      } else {
        if (this.capture.issues.some((i) => i.scope === request.scope))
          throw new DeviceError("state");
        value = null;
        deleted = true;
      }
    } else {
      const head = record.heads.find(
        (h) => h.from === request.author && h.sequence === request.sequence,
      );
      if (!head) throw new DeviceError("stale");
      value = head.value;
      deleted = head.deleted;
    }
    const draft = this.vault.buildDataOperation(
        request.scope,
        request.recordId,
        value,
        deleted,
      ),
      plan = await this.target.plan(draft);
    return { record, value, deleted, plan };
  }
  command(
    request: DeviceUiRequest | DeviceSnapshotDecision,
  ): Promise<DeviceUiResult> {
    const revoking =
      request.kind === "revoke" ||
      request.kind === "cancel" ||
      (request.kind === "enable" && request.enabled === false) ||
      (request.kind === "reset" && request.confirmation === "RESET");
    const eager = revoking
      ? (async () => {
          this.confirmResolve?.(false);
          const stopping = this.stopTransport();
          if (this.vault) await this.vault.revoke();
          await stopping;
        })()
      : null;
    void eager?.catch(() => {});
    return this.run(async () => {
      if (this.closed) throw new DeviceError("state");
      this.error = null;
      try {
        if (request.kind === "enable") {
          if (typeof request.enabled !== "boolean")
            throw new DeviceError("invalid");
          if (request.enabled) {
            if (!this.vault) {
              this.vault = await this.env.open(!this.env.hasVault());
              await this.attach();
            }
            this.save({ ...this.config, enabled: true });
            await this.startTransport();
          } else {
            await eager;
            this.save({ ...this.config, enabled: false });
            await this.disposeBackend();
          }
        } else if (request.kind === "configure") {
          const next = validateDeviceUiConfig({
            ...this.config,
            listen: request.listen,
            remote: request.remote,
            scopes: request.scopes,
          });
          if (!this.env.addresses().includes(next.listen.host))
            throw new DeviceError("invalid");
          if (this.vault?.snapshot().status === "active") {
            const allowed = this.vault.sessionAccess().scopes;
            if (next.scopes.some((s) => !allowed.includes(s)))
              throw new DeviceError("invalid");
            if (JSON.stringify(next.scopes) !== JSON.stringify(allowed))
              await this.vault.narrowScopes(next.scopes);
          }
          await this.stopTransport();
          this.save(next);
          await this.startTransport();
        } else if (request.kind === "invite") {
          const v = this.requireVault();
          if (v.invitationStatus()?.status === "open")
            await v.cancelInvitation();
          await this.stopTransport();
          this.save({ ...this.config, remote: null });
          this.bootstrap = await openDeviceBootstrap(
            v,
            this.config.scopes,
            this.consent(null),
            () => {},
            this.config.listen,
          );
          this.save({
            ...this.config,
            listen: this.bootstrap.invitation.endpoint,
          });
          const current = this.bootstrap;
          void current.completed
            .then(async (success) => {
              if (this.bootstrap !== current) return;
              await this.run(async () => {
                if (this.bootstrap !== current) return;
                await current.close();
                this.bootstrap = null;
                if (success) {
                  await this.collect(true);
                  await this.startTransport();
                } else this.error = "expired";
                this.notify();
              });
            })
            .catch((error) => this.fail(error));
          this.notify();
          return {
            state: this.state(),
            invitation: JSON.stringify(current.invitation),
            invitationExpiresAt: current.invitation.expiresAt,
          };
        } else if (request.kind === "join") {
          const v = this.requireVault();
          if (this.pairTask) throw new DeviceError("state");
          if (typeof request.text !== "string" || request.text.length > 20000)
            throw new DeviceError("size");
          const invite = validateDeviceInvite(JSON.parse(request.text));
          this.save({
            ...this.config,
            remote: invite.endpoint,
            scopes: invite.scopes,
          });
          this.pairTask = pairDevice(v, invite, this.consent(invite.endpoint))
            .then(() =>
              this.run(async () => {
                await this.collect(true);
                await this.startTransport();
              }),
            )
            .catch((error) => this.fail(error))
            .finally(() => {
              this.pairTask = null;
              this.notify();
            });
        } else if (request.kind === "confirm") {
          if (
            request.id !== this.confirmation?.id ||
            typeof request.accept !== "boolean"
          )
            throw new DeviceError("stale");
          this.confirmResolve?.(request.accept);
        } else if (request.kind === "approve") {
          const v = this.requireVault();
          await v.approveDataExchange(deviceHex(request.grant));
          await this.replica!.recover();
          await this.collect(true);
          for (const r of Object.values(v.replicaState().records))
            if (r.heads.length === 1)
              await this.replica!.retry(r.heads[0].scope, r.heads[0].recordId);
          this.sent.clear();
          await this.flush();
          await this.ackAll();
        } else if (request.kind === "revoke" || request.kind === "cancel") {
          await eager;
          this.requireVault();
          this.observed = null;
          this.capture = { records: [], issues: [] };
        } else if (request.kind === "reconnect") {
          await this.stopTransport();
          await this.disposeBackend();
          await this.start();
        } else if (request.kind === "narrow") {
          await this.requireVault().narrowScopes(deviceScopes(request.scopes));
          this.save({
            ...this.config,
            scopes: this.requireVault().sessionAccess().scopes,
          });
          await this.stopTransport();
          this.observed = null;
          await this.collect(true);
          await this.startTransport();
        } else if (request.kind === "map-category") {
          if (
            typeof request.source !== "string" ||
            typeof request.target !== "string"
          )
            throw new DeviceError("invalid");
          this.save(
            validateDeviceUiConfig({
              ...this.config,
              categories: {
                ...this.config.categories,
                [request.source]: request.target,
              },
            }),
          );
          await this.env.refresh();
          if (this.requireVault().dataApproved())
            for (const r of Object.values(this.vault!.replicaState().records))
              if (r.issue === "category")
                await this.replica!.retry(
                  r.heads[0].scope,
                  r.heads[0].recordId,
                );
          await this.ackAll();
        } else if (request.kind === "preview" || request.kind === "resolve") {
          const { record, value, deleted, plan } = await this.selected(request),
            heads = replicaHeads(record.heads);
          if (request.kind === "preview")
            return {
              state: this.state(),
              preview: {
                scope: request.scope,
                recordId: request.recordId,
                heads,
                beforeStamp: plan.beforeStamp,
                before: plan.beforeStamp,
                after: plan.afterStamp,
                issue: plan.issue,
                author: request.author,
                sequence: request.sequence,
                local: request.local,
              },
            };
          if (
            !this.requireVault().dataApproved() ||
            heads !== request.heads ||
            plan.beforeStamp !== request.beforeStamp
          )
            throw new DeviceError("stale");
          await this.replica!.resolve(
            request.scope,
            request.recordId,
            value,
            deleted,
            heads,
            request.beforeStamp,
          );
          this.sent.clear();
          await this.collect(true);
          await this.flush();
          await this.ackAll();
        } else if (request.kind === "snapshot") {
          const v = this.requireVault();
          if (!v.dataApproved() || !this.session)
            throw new DeviceError("state");
          for (const scope of v.sessionAccess().scopes) {
            const snapshot = v.dataSnapshot(scope);
            await this.write(() => this.session!.sendSnapshot(snapshot));
          }
        } else if (request.kind === "accept-snapshot") {
          const offer = [...this.offers.values()].find(
            (o) => o.id === request.id,
          );
          if (!offer || typeof request.accept !== "boolean")
            throw new DeviceError("stale");
          if (request.accept) {
            if (!this.requireVault().dataApproved())
              throw new DeviceError("not-confirmed");
            await this.replica!.acceptSnapshot(
              offer.snapshot,
              async () => true,
            );
            await this.ackAll();
          }
          this.offers.delete(offer.snapshot.scope);
        } else if (request.kind === "reset") {
          if (request.confirmation !== "RESET")
            throw new DeviceError("not-confirmed");
          await eager;
          this.save({
            ...this.config,
            enabled: false,
            remote: null,
            categories: {},
          });
          await this.disposeBackend();
          await this.env.archive();
          this.error = null;
        } else throw new DeviceError("invalid");
      } catch (error) {
        this.fail(error);
      }
      this.notify();
      return { state: this.state() };
    });
  }
  private requireVault() {
    if (!this.config.enabled || !this.vault) throw new DeviceError("state");
    return this.vault;
  }
  private async disposeBackend() {
    await this.replica?.close();
    this.replica = null;
    this.target?.close();
    this.target = null;
    await this.vault?.close();
    this.vault = null;
    this.observed = null;
  }
  async close() {
    this.closed = true;
    this.confirmResolve?.(false);
    if (this.captureTimer) clearTimeout(this.captureTimer);
    await this.stopTransport();
    await this.serial;
    await this.disposeBackend();
  }
}
