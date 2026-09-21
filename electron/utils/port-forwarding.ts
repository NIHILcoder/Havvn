/**
 * Port forwarding (UPnP IGD + NAT-PMP)
 *
 * WebTorrent (µTP disabled) accepts incoming peers over a single TCP port. If
 * the router doesn't forward that port, the client can only make *outgoing*
 * connections — which throttles peer count and speed, especially for torrents
 * with few seeds. This service asks the router (via UPnP or NAT-PMP) to forward
 * the listening port back to this machine and keeps the lease renewed.
 *
 * Design notes:
 *  - Tries UPnP first (covers most consumer routers), falls back to NAT-PMP
 *    (Apple routers, some ISP gateways).
 *  - A fixed listening port (Settings → Advanced) is required for a *stable*
 *    mapping across restarts — a random OS port can still be mapped for the
 *    session but won't persist, so we surface that in the status.
 *  - Everything is best-effort and fully guarded: a router with UPnP disabled
 *    must never break startup. Failure is reported as status, not thrown.
 */

import * as natPmp from 'nat-pmp';
import type UpnpClient from '@silentbot1/nat-api/lib/upnp/index.js';
import { logger } from './logger';
import * as db from '../db/store';
import * as os from 'os';

const log = logger.child('PortForward');

export type PortForwardState =
  | 'disabled'     // turned off in settings
  | 'mapping'      // attempt in progress
  | 'mapped'       // router is forwarding the port
  | 'unsupported'  // no UPnP/NAT-PMP-capable gateway found
  | 'failed';      // gateway found but the mapping was refused / errored

export interface PortForwardStatus {
  state: PortForwardState;
  port: number | null;
  method: 'upnp' | 'nat-pmp' | null;
  externalIp?: string;
  error?: string;
  updatedAt: number;
}

const LEASE_TTL_SECONDS = 3600;          // ask the router for a 1-hour lease
const RENEW_INTERVAL_MS = 30 * 60 * 1000; // renew every 30 min (well before expiry)
const REQUEST_TIMEOUT_MS = 4000;          // SSDP/SOAP timeout — keep startup snappy
function request<T>(start: (done: (error: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Port mapping request timed out')), REQUEST_TIMEOUT_MS);
    try {
      start((error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return request<T>(done => {
    operation.then(value => done(null, value), error => done(error));
  });
}

const DESCRIPTION = 'Havvn'; // shown in the router's port-forward table

/**
 * Get default gateway IP address from network interfaces
 */
function getDefaultGateway(): string | null {
  try {
    const ifaces = os.networkInterfaces();
    // Look for primary network interface (typically has default route)
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!addrs || /^(lo|loopback|vmnet|veth|docker)/i.test(name)) continue;

      for (const addr of addrs) {
        if ((addr.family === 'IPv4' || (addr.family as unknown as number) === 4) && !addr.internal) {
          // Extract gateway from IP (typically .1 on the subnet)
          const parts = addr.address.split('.');
          if (parts.length === 4) {
            return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
          }
        }
      }
    }
  } catch (e) {
    log.warn('Failed to detect gateway', { error: String(e) });
  }
  // Common default gateways as fallback
  return '192.168.1.1';
}

class PortForwardingService {
  private upnpClient: UpnpClient | null = null;
  private pmpClient: natPmp.Client | null = null;
  private port: number | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private status: PortForwardStatus = { state: 'disabled', port: null, method: null, updatedAt: Date.now() };
  private currentMethod: 'upnp' | 'nat-pmp' | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private epoch = 0;

  private enqueue(action: () => Promise<void>): Promise<void> {
    const pending = this.lifecycle.then(action);
    this.lifecycle = pending.catch(() => {});
    return pending;
  }

  getStatus(): PortForwardStatus {
    return this.status;
  }

  /**
   * Begin (or restart) forwarding `port`. Safe to call repeatedly; if the same
   * port is already mapped it's a no-op. Always tears down a prior mapping first.
   */
  start(port: number): Promise<void> {
    const epoch = ++this.epoch;
    return this.enqueue(() => this.startInternal(port, epoch));
  }

  private async startInternal(port: number, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      await this.stopInternal();
      this.setStatus({ state: 'failed', port: null, method: null, error: 'No fixed listening port to forward' });
      return;
    }
    if ((this.upnpClient || this.pmpClient) && this.port === port && this.status.state === 'mapped') {
      this.scheduleRenewal(epoch);
      return;
    }

    await this.stopInternal();
    if (epoch !== this.epoch) return;
    this.port = port;

    await this.mapOnce();
    if (epoch !== this.epoch) {
      await this.stopInternal();
      return;
    }
    this.scheduleRenewal(epoch);
  }

  private scheduleRenewal(epoch: number): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    // Keep the lease alive and recover from transient router hiccups.
    this.renewTimer = setInterval(() => {
      void this.enqueue(async () => {
        if (epoch === this.epoch) await this.mapOnce();
      });
    }, RENEW_INTERVAL_MS);
  }

  /** Remove the mapping, stop renewing, and release clients. */
  stop(): Promise<void> {
    ++this.epoch;
    return this.enqueue(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }

    // Remove UPnP mapping
    if (this.upnpClient && this.port && this.currentMethod === 'upnp') {
      try {
        await bounded(this.upnpClient.portUnmapping({ public: this.port, protocol: 'tcp' }));
        log.info('Removed UPnP port mapping', { port: this.port });
      } catch {
        /* router may have already dropped it — ignore */
      }
    }

    // Remove NAT-PMP mapping
    if (this.pmpClient && this.port && this.currentMethod === 'nat-pmp') {
      try {
        await request<void>((done) => {
          this.pmpClient!.portUnmapping({ private: this.port!, type: 'tcp' }, (err) => {
            done(err);
          });
        });
        log.info('Removed NAT-PMP port mapping', { port: this.port });
      } catch {
        /* ignore */
      }
    }

    if (this.upnpClient) {
      try { await this.upnpClient.destroy(); } catch { /* ignore */ }
      this.upnpClient = null;
    }
    if (this.pmpClient) {
      try { this.pmpClient.close(); } catch { /* ignore */ }
      this.pmpClient = null;
    }

    this.port = null;
    this.currentMethod = null;
    this.setStatus({ state: 'disabled', port: null, method: null });
  }

  private async mapOnce(): Promise<void> {
    if (!this.port || this.inFlight) return;
    this.inFlight = true;
    const port = this.port;

    try {
      // Try UPnP first (most common)
      const upnpSuccess = await this.tryUPnP(port);
      if (upnpSuccess) {
        this.currentMethod = 'upnp';
        return;
      }

      // Fallback to NAT-PMP (Apple routers, some ISPs)
      const pmpSuccess = await this.tryNATPMP(port);
      if (pmpSuccess) {
        this.currentMethod = 'nat-pmp';
        return;
      }

      // Both methods failed
      this.setStatus({
        state: 'unsupported',
        port,
        method: null,
        error: 'No UPnP or NAT-PMP capable router found'
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: 'failed', port, method: null, error });
      log.warn('Port mapping failed', { port, error });
    } finally {
      this.inFlight = false;
    }
  }

  private async tryUPnP(port: number): Promise<boolean> {
    try {
      if (!this.upnpClient) {
        const { default: Client } = await import('@silentbot1/nat-api/lib/upnp/index.js');
        this.upnpClient = new Client({ permanentFallback: false });
      }

      const client = this.upnpClient;

      // Probe for an IGD
      try {
        await bounded(client.findGateway());
      } catch {
        return false; // No UPnP router
      }

      this.setStatus({ state: 'mapping', port, method: 'upnp' });

      await bounded(client.portMapping({
        public: port,
        private: port,
        protocol: 'tcp',
        ttl: LEASE_TTL_SECONDS,
        description: DESCRIPTION,
      }));

      let externalIp: string | undefined;
      try { externalIp = await bounded(client.externalIp()); } catch { /* optional */ }

      this.setStatus({ state: 'mapped', port, method: 'upnp', externalIp });
      log.info('Port forwarded via UPnP', { port, externalIp });
      return true;
    } catch (e) {
      log.debug('UPnP mapping failed, will try NAT-PMP', { error: String(e) });
      return false;
    }
  }

  private async tryNATPMP(port: number): Promise<boolean> {
    try {
      const gateway = getDefaultGateway();
      if (!gateway) return false;

      if (!this.pmpClient) {
        this.pmpClient = natPmp.connect(gateway);
        this.pmpClient.on('error', error => log.warn('NAT-PMP socket error', { error: String(error) }));
      }

      const client = this.pmpClient;

      this.setStatus({ state: 'mapping', port, method: 'nat-pmp' });

      // Create mapping
      await request<void>((done) => {
        client.portMapping({
          private: port,
          public: port,
          ttl: LEASE_TTL_SECONDS,
          type: 'tcp'
        }, (err) => {
          done(err);
        });
      });

      // Get external IP
      let externalIp: string | undefined;
      try {
        externalIp = await request<string>((done) => {
          client.externalIp((err, info) => {
            done(err, info?.ip.join('.'));
          });
        });
      } catch { /* optional */ }

      this.setStatus({ state: 'mapped', port, method: 'nat-pmp', externalIp });
      log.info('Port forwarded via NAT-PMP', { port, externalIp, gateway });
      return true;
    } catch (e) {
      log.debug('NAT-PMP mapping failed', { error: String(e) });
      return false;
    }
  }

  private setStatus(partial: Omit<Partial<PortForwardStatus>, 'updatedAt'> & { state: PortForwardState }): void {
    this.status = { ...this.status, ...partial, updatedAt: Date.now() };
  }
}

let service: PortForwardingService | null = null;

export function getPortForwarding(): PortForwardingService {
  if (!service) service = new PortForwardingService();
  return service;
}

/**
 * (Re)start or stop forwarding based on the persisted setting and the torrent
 * client's current listening port. Called on startup and whenever the relevant
 * settings change. `getPort` resolves the live listening port lazily.
 */
export async function restartPortForwardingFromConfig(getPort: () => number): Promise<void> {
  const svc = getPortForwarding();
  let enabled = true;
  try {
    const settings = await db.getSettings();
    enabled = settings.portForwarding !== false; // default on
  } catch {
    enabled = true;
  }

  if (!enabled) {
    log.info('Port forwarding disabled');
    await svc.stop();
    return;
  }

  const port = getPort();
  await svc.start(port);
}

export async function stopPortForwarding(): Promise<void> {
  if (service) await service.stop();
}
