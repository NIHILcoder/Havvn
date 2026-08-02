/**
 * Sends a module's AnnouncePlan on a timer, so a dedicated server appears in the
 * game's own local-network list.
 *
 * THE INTERFACE CHOICE IS THE WHOLE TRICK. A multicast datagram leaves through
 * ONE interface, chosen by the routing table, which on a machine with a physical
 * LAN plus a tunnel is almost never the tunnel. setMulticastInterface pins it to
 * the virtual address instead, so the packet goes out of the Wintun adapter —
 * where Havvn's LAN session replicates it to every member. That is what turns
 * "the server is reachable at 100.x.y.z:25565" into "the server is simply in
 * everyone's list", with nobody typing an address.
 *
 * TTL is 1 on purpose: this is a link-local advertisement and must not be
 * forwarded beyond it.
 */
import dgram from 'dgram';
import { logger } from '../utils';
import type { AnnouncePlan } from '../../shared/gameserver-types';

const log = logger.child('GameAnnouncer');

export class Announcer {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private plan: AnnouncePlan | null = null;
  /** Consecutive send failures, so a permanently broken socket stops logging on
   *  every tick (at 1.5 s that is 2400 lines an hour). */
  private failures = 0;

  /** Start or update the advertisement. Passing null stops it. */
  set(plan: AnnouncePlan | null, bindAddress?: string): void {
    if (!plan) { this.stop(); return; }

    const sameTarget = this.plan
      && this.plan.host === plan.host
      && this.plan.port === plan.port
      && this.plan.intervalMs === plan.intervalMs;

    this.plan = plan;
    if (sameTarget && this.socket) return; // payload refreshed, socket reused

    this.stop();
    try {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', (err) => {
        log.warn('announce socket error', { err: String(err) });
        this.stop();
      });
      socket.bind(() => {
        try {
          if (plan.multicast) {
            socket.setMulticastTTL(1);
            // Loopback ON: the host's own game client should see its own server
            // in the list too, which is the first thing anyone checks.
            socket.setMulticastLoopback(true);
            if (bindAddress) socket.setMulticastInterface(bindAddress);
          } else {
            socket.setBroadcast(true);
          }
        } catch (err) {
          log.warn('could not configure announce socket', { err: String(err), bindAddress });
        }
      });
      this.socket = socket;
      this.failures = 0;
      this.timer = setInterval(() => this.tick(), plan.intervalMs);
      this.tick();
      log.info('announcing', { host: plan.host, port: plan.port, via: bindAddress ?? 'default route' });
    } catch (err) {
      log.warn('could not start announcer', { err: String(err) });
      this.stop();
    }
  }

  /** Refresh only the payload (motd or port changed) without recreating the
   *  socket — a rebind would drop the interface pin. */
  updatePayload(payload: Buffer): void {
    if (this.plan) this.plan = { ...this.plan, payload };
  }

  private tick(): void {
    const { socket, plan } = this;
    if (!socket || !plan) return;
    socket.send(plan.payload, plan.port, plan.host, (err) => {
      if (!err) { this.failures = 0; return; }
      this.failures++;
      if (this.failures === 1 || this.failures % 200 === 0) {
        log.warn('announce send failed', { err: String(err), failures: this.failures });
      }
    });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
  }

  get active(): boolean {
    return this.socket !== null;
  }
}
