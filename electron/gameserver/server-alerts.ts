/**
 * Detect server alert conditions (crash, OOM hints, low disk).
 */
import type { ServerAlert, ServerAlertKind, ServerStatus } from '../../shared/gameserver-types';

const DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Minimum gap between two alerts of the same kind about the same instance. */
export const ALERT_COOLDOWN_MS = 60_000;

/**
 * Rate limiter for alerts, one entry per instance+kind.
 *
 * A crash with auto-restart on is a LOOP: crashed → starting → running →
 * crashed, every few seconds, each pass raising a fresh toast until the screen
 * is unusable. The room notifier solves the same problem the same way
 * (NOTIFY_COOLDOWN_MS); the first alert is what carries the information, and the
 * hundredth adds nothing.
 */
export class AlertThrottle {
  private readonly last = new Map<string, number>();

  /** True when this alert should be shown; records the decision. */
  allow(alert: ServerAlert, now = Date.now()): boolean {
    const key = `${alert.instanceId}\t${alert.kind}`;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < ALERT_COOLDOWN_MS) return false;
    this.last.set(key, now);
    return true;
  }

  /** Forget an instance entirely — it was deleted. */
  forget(instanceId: string): void {
    for (const key of this.last.keys()) {
      if (key.startsWith(`${instanceId}\t`)) this.last.delete(key);
    }
  }
}

export function alertOnStatusChange(
  instanceId: string,
  name: string,
  prev: ServerStatus | undefined,
  next: ServerStatus,
  detail?: string,
): ServerAlert | null {
  if (prev === next) return null;
  if (next === 'crashed') {
    const kind: ServerAlertKind = /out\s*of\s*memory|java\.lang\.OutOfMemoryError/i.test(detail ?? '')
      ? 'oom'
      : 'crash';
    return { kind, instanceId, name, ...(detail ? { detail } : {}) };
  }
  return null;
}

export function alertOnLowDisk(instanceId: string, name: string, free: number | null): ServerAlert | null {
  if (free === null || free >= DISK_WARN_BYTES) return null;
  const gb = (free / (1024 ** 3)).toFixed(1);
  return { kind: 'disk', instanceId, name, detail: `${gb} GiB free` };
}
