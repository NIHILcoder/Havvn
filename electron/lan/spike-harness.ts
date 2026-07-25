/**
 * Virtual-LAN Phase-0 spike harness (plan §11 Phase 0).
 *
 * Standalone CLI (plain Node, no Electron). De-risks the three things the LAN
 * feature cannot be built without knowing:
 *   1. koffi ↔ wintun.dll binding actually works (adapter create/session/ring).
 *   2. elevation — creating the adapter needs Administrator (run elevated).
 *   3. added latency of pushing every packet through the ring ↔ JS event loop
 *      (the "routing-brain-in-renderer" split), measured p50/p90/p99.
 *
 * It creates a Wintun adapter, assigns a 100.64/16 address, and runs a pump that
 *   • answers ICMP echo (so `ping <peer>` from another terminal gets replies —
 *     proves the TX/inject path), and
 *   • optionally self-generates UDP load to <peer> and measures the full
 *     userspace→kernel→ring→userspace latency of each packet (RX path).
 *
 * MUST be run from an ELEVATED terminal. State touches only the volatile adapter
 * (removed on exit). Windows x64 only.
 *
 *   npm run spike:lan -- [--ip=100.64.0.1] [--peer=100.64.0.2] [--prefix=16]
 *                        [--mtu=1280] [--duration=60] [--load=2000] [--dll=<path>]
 */
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { loadWintun } from './wintun';
import { parseIpv4, ipChecksum, IP_PROTO_ICMP, IP_PROTO_UDP } from '../../shared/lan-packet';

const ADAPTER_NAME = 'Havvn LAN Spike';
const TUNNEL_TYPE = 'Havvn';
const PROBE_PORT = 47654;
const MAGIC = Buffer.from('HVLN');

function arg(name: string, def: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
function has(name: string): boolean {
  return process.argv.slice(2).some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

function ps(command: string): { ok: boolean; out: string } {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
/** Escape a value for a single-quoted PowerShell string (an un-doubled apostrophe ends it). */
const q = (s: string) => s.replace(/'/g, "''");

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
const fmt = (ms: number) => `${ms.toFixed(3)}ms`;

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('spike:lan is Windows-only (Wintun).');
    process.exit(2);
  }
  const ip = arg('ip', '100.64.0.1');
  const peer = arg('peer', '100.64.0.2');
  const prefix = Number(arg('prefix', '16'));
  const mtu = Number(arg('mtu', '1280'));
  const durationS = Number(arg('duration', '60'));
  const loadPps = has('load') ? Number(arg('load', '2000')) : 0;
  const dllPath = arg('dll', '');

  const wintun = loadWintun(dllPath || undefined);
  console.log(`wintun.dll loaded. driver version before create: ${wintun.runningDriverVersion()}`);

  let adapter: unknown = null;
  let session: unknown = null;
  let loadTimer: NodeJS.Timeout | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  let sock: dgram.Socket | null = null;
  let running = true;

  const cleanup = () => {
    running = false;
    if (loadTimer) clearInterval(loadTimer);
    if (tickTimer) clearInterval(tickTimer);
    try { sock?.close(); } catch { /* ignore */ }
    try { if (session) wintun.endSession(session); } catch { /* ignore */ }
    try { if (adapter) wintun.closeAdapter(adapter); } catch { /* ignore */ }
    // Adapter deletion drops the address, but remove it explicitly for tidiness.
    ps(`Remove-NetIPAddress -InterfaceAlias '${q(ADAPTER_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue`);
  };

  // Ctrl-C: clean up the adapter (Wintun adapters persist until closed) then exit.
  let cleanedUp = false;
  const cleanupOnce = () => { if (cleanedUp) return; cleanedUp = true; cleanup(); };
  process.on('SIGINT', () => { console.log('\ninterrupted — cleaning up...'); cleanupOnce(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupOnce(); process.exit(143); });

  try {
    adapter = wintun.createAdapter(ADAPTER_NAME, TUNNEL_TYPE);
    console.log(`adapter created: "${ADAPTER_NAME}". driver version now: ${wintun.runningDriverVersion()}`);
    session = wintun.startSession(adapter);
    const readEvent = wintun.readWaitEvent(session);

    // Configure L3: address + on-link route (New-NetIPAddress) + MTU. The adapter
    // comes up once the session is started, so this runs after startSession.
    ps(`Remove-NetIPAddress -InterfaceAlias '${q(ADAPTER_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue`);
    const addr = ps(`New-NetIPAddress -InterfaceAlias '${q(ADAPTER_NAME)}' -IPAddress ${ip} -PrefixLength ${prefix}`);
    if (!addr.ok) { console.error(`failed to assign ${ip}/${prefix}: ${addr.out}`); cleanup(); process.exit(1); }
    ps(`Set-NetIPInterface -InterfaceAlias '${q(ADAPTER_NAME)}' -NlMtuBytes ${mtu} -ErrorAction SilentlyContinue`);
    console.log(`assigned ${ip}/${prefix}, mtu ${mtu}. on-link route to ${ip.replace(/\.\d+$/, '.0')}/${prefix} installed.`);
    console.log(`\n→ in ANOTHER terminal run:  ping ${peer}\n  (the spike answers via the ring — you should see replies)`);
    if (loadPps) console.log(`→ self-generating ${loadPps} pps of UDP to ${peer}:${PROBE_PORT} for RX-latency\n`);

    const ringLat: number[] = [];  // ICMP recv→send processing overhead (routing-brain cost)
    const udpLat: number[] = [];   // full send→ring→recv latency (RX path)
    let rx = 0, icmpReplies = 0, sendFull = 0;

    const onPacket = (pkt: Buffer) => {
      rx++;
      const h = parseIpv4(pkt);
      if (!h) return;
      // ICMP echo request → reply (swap src/dst, type 8→0, recompute checksums).
      if (h.proto === IP_PROTO_ICMP && pkt.length >= h.ihl + 8 && pkt[h.ihl] === 8) {
        const t0 = process.hrtime.bigint();
        const reply = Buffer.from(pkt);
        pkt.copy(reply, 12, 16, 20); // src = original dst
        pkt.copy(reply, 16, 12, 16); // dst = original src
        reply[h.ihl] = 0;            // echo reply
        reply.writeUInt16BE(0, 10);
        reply.writeUInt16BE(ipChecksum(reply, 0, h.ihl), 10);
        reply.writeUInt16BE(0, h.ihl + 2);
        reply.writeUInt16BE(ipChecksum(reply, h.ihl, reply.length - h.ihl), h.ihl + 2);
        if (wintun.sendPacket(session, reply)) icmpReplies++; else sendFull++;
        ringLat.push(Number(process.hrtime.bigint() - t0) / 1e6);
        return;
      }
      // Our UDP probe → recover the embedded send timestamp.
      if (h.proto === IP_PROTO_UDP && pkt.length >= h.ihl + 8 + 12 &&
          pkt.readUInt16BE(h.ihl + 2) === PROBE_PORT &&
          pkt.subarray(h.ihl + 8, h.ihl + 12).equals(MAGIC)) {
        const sent = pkt.readBigUInt64LE(h.ihl + 12);
        udpLat.push(Number(process.hrtime.bigint() - sent) / 1e6);
      }
    };

    // Non-blocking pump: drain everything ready, then either yield (setImmediate)
    // under load or briefly block on the read event when idle (near-zero CPU,
    // wakes instantly on data — never adds latency while packets are flowing).
    const pump = () => {
      if (!running) return;
      let drained = 0;
      for (;;) {
        const pkt = wintun.receivePacket(session);
        if (!pkt) break;
        onPacket(pkt);
        if (++drained >= 512) break;
      }
      if (drained === 0) wintun.waitReadable(readEvent, 1);
      setImmediate(pump);
    };
    setImmediate(pump);

    // Optional load generator: fire UDP with an embedded hrtime stamp.
    if (loadPps) {
      sock = dgram.createSocket('udp4');
      await new Promise<void>((res, rej) => { sock!.bind(0, ip, () => res()); sock!.once('error', rej); });
      const perTick = Math.max(1, Math.round(loadPps / 100));
      loadTimer = setInterval(() => {
        for (let i = 0; i < perTick; i++) {
          const buf = Buffer.alloc(12);
          MAGIC.copy(buf, 0);
          buf.writeBigUInt64LE(process.hrtime.bigint(), 4);
          sock!.send(buf, PROBE_PORT, peer, () => { /* fire-and-forget */ });
        }
      }, 10);
    }

    // Live line once a second.
    const t0 = Date.now();
    tickTimer = setInterval(() => {
      const s = [...ringLat].sort((a, b) => a - b);
      console.log(
        `[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ` +
        `rx ${rx} · icmp-replies ${icmpReplies} · udp-probes ${udpLat.length}` +
        (ringLat.length ? ` · ring p50 ${fmt(pct(s, 0.5))} p99 ${fmt(pct(s, 0.99))}` : '') +
        (sendFull ? ` · send-ring-full ${sendFull}` : ''),
      );
    }, 1000);

    // Run for the duration, then summarise.
    await new Promise<void>((res) => setTimeout(res, durationS * 1000));

    running = false;
    const rs = ringLat.sort((a, b) => a - b);
    const us = udpLat.sort((a, b) => a - b);
    console.log('\n══ SPIKE SUMMARY ══');
    console.log(`packets received from ring: ${rx}`);
    console.log(`ICMP echo replies injected: ${icmpReplies}${sendFull ? ` (send-ring-full drops: ${sendFull})` : ''}`);
    if (rs.length) console.log(`routing-brain overhead (ICMP recv→send): p50 ${fmt(pct(rs, 0.5))} · p90 ${fmt(pct(rs, 0.9))} · p99 ${fmt(pct(rs, 0.99))} · max ${fmt(rs[rs.length - 1])}`);
    if (us.length) console.log(`RX path latency (UDP send→ring→recv): p50 ${fmt(pct(us, 0.5))} · p90 ${fmt(pct(us, 0.9))} · p99 ${fmt(pct(us, 0.99))} · max ${fmt(us[us.length - 1])} · samples ${us.length}`);
    console.log('\nVERDICT:');
    console.log(`  koffi↔wintun ring RX/TX: ${rx > 0 ? 'PROVEN' : 'NO PACKETS SEEN — did you ping the peer / enable --load?'}`);
    console.log(`  packet injection (TX):   ${icmpReplies > 0 ? 'PROVEN (ping got replies)' : 'not exercised (no ICMP echo requests seen)'}`);
    console.log('  → compare the p99 numbers above against the plan’s added-latency budget for the renderer-split (§11).');
  } catch (e) {
    console.error('\nspike failed:', e instanceof Error ? e.message : e);
    console.error('(create/assign needs Administrator — run this from an ELEVATED terminal.)');
    cleanupOnce();
    process.exit(1);
  }

  cleanupOnce();
  console.log('\ncleaned up (adapter removed).');
  process.exit(0);
}

main().catch((e) => { console.error('spike crashed:', e); process.exit(1); });
