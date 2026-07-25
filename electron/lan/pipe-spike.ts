/**
 * Virtual-LAN Phase-0.5 spike: the helper↔engine named-pipe hop in isolation.
 *
 * Phase 0 measured the Wintun-ring↔JS half (sub-ms p99). The one unmeasured
 * latency variable left is the local IPC hop that will sit between the elevated
 * helper (owns Wintun) and the engine window (owns the WebRTC channels). This
 * spike stands that hop up on a real Windows named pipe between two Node
 * processes, pushes length-prefixed frames at game rates with an embedded
 * timestamp, echoes them, and reports round-trip latency (one-way ≈ RTT/2).
 *
 * No elevation, no driver — pure IPC latency + the FrameReader reassembler under
 * load. NOT the security layer (DACL/SID/token) — that is Phase-1 correctness,
 * not steady-state latency.
 *
 *   npm run spike:pipe -- [--pps=2000] [--size=80] [--duration=12]
 *   (internal: --child <pipeName>)
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { encodeFrame, FrameReader } from '../../shared/lan-frame';

function arg(name: string, def: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const fmt = (ms: number) => `${ms.toFixed(3)}ms`;

// ── Child: connect, echo every frame back (exercises the reassembler too). ──
function runChild(pipeName: string): void {
  const sock = net.connect(pipeName);
  const reader = new FrameReader();
  sock.on('data', (chunk) => {
    try { reader.push(chunk, (payload) => sock.write(encodeFrame(payload))); }
    catch { sock.destroy(); process.exit(1); }
  });
  sock.on('error', () => process.exit(1));
  sock.on('close', () => process.exit(0));
  // Safety net: if the parent vanishes without closing us, don't linger.
  setTimeout(() => process.exit(0), 120_000);
}

// ── Parent: serve the pipe, spawn the child, generate load, measure RTT. ──
async function runParent(): Promise<void> {
  const pps = Number(arg('pps', '2000'));
  const size = Math.max(12, Number(arg('size', '80'))); // need 8B hrtime + 4B seq
  const durationS = Number(arg('duration', '12'));
  const pipeName = `\\\\.\\pipe\\havvn-lan-pipe-spike-${process.pid}`;

  const lat: number[] = [];
  let sent = 0, echoed = 0, backpressure = 0, paused = false;

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    const reader = new FrameReader();
    sock.on('data', (chunk) => {
      reader.push(chunk, (payload) => {
        echoed++;
        const t = payload.readBigUInt64LE(0);
        lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      });
    });
    sock.on('drain', () => { paused = false; });

    console.log(`child connected. generating ${pps} pps of ${size}B frames for ${durationS}s...\n`);
    const t0 = Date.now();
    let seq = 0;

    const perTick = Math.max(1, Math.round(pps / 100));
    const load = setInterval(() => {
      if (paused) return; // respect kernel-buffer backpressure (drop, don't queue)
      for (let i = 0; i < perTick; i++) {
        const p = Buffer.allocUnsafe(size);
        p.writeBigUInt64LE(process.hrtime.bigint(), 0);
        p.writeUInt32LE(seq++ >>> 0, 8);
        if (size > 12) p.fill(0, 12);
        sent++;
        if (!sock.write(encodeFrame(p))) { paused = true; backpressure++; break; }
      }
    }, 10);

    const tick = setInterval(() => {
      const s = [...lat].sort((a, b) => a - b);
      console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] sent ${sent} · echoed ${echoed}` +
        (s.length ? ` · RTT p50 ${fmt(pct(s, 0.5))} p99 ${fmt(pct(s, 0.99))}` : '') +
        (backpressure ? ` · backpressure ${backpressure}` : ''));
    }, 1000);

    setTimeout(() => {
      clearInterval(load); clearInterval(tick);
      // brief grace so in-flight echoes drain
      setTimeout(() => finish(sock), 200);
    }, durationS * 1000);

    const finish = (s: net.Socket) => {
      const rtt = lat.sort((a, b) => a - b);
      const oneWay = (p: number) => pct(rtt, p) / 2;
      console.log('\n══ PIPE-HOP SUMMARY ══');
      console.log(`frames sent ${sent} · echoed ${echoed} · loss ${sent - echoed} (${((1 - echoed / Math.max(1, sent)) * 100).toFixed(2)}%)`);
      console.log(`backpressure events: ${backpressure}`);
      if (rtt.length) {
        console.log(`round-trip (2 hops + echo): p50 ${fmt(pct(rtt, 0.5))} · p90 ${fmt(pct(rtt, 0.9))} · p99 ${fmt(pct(rtt, 0.99))} · max ${fmt(rtt[rtt.length - 1])}`);
        console.log(`implied ONE-WAY pipe hop (RTT/2): p50 ${fmt(oneWay(0.5))} · p90 ${fmt(oneWay(0.9))} · p99 ${fmt(oneWay(0.99))}`);
      }
      console.log('\nVERDICT:');
      console.log(`  named-pipe framing/reassembly: ${sent > 0 && echoed === sent ? 'CLEAN (0 loss)' : `loss ${sent - echoed} — investigate framing`}`);
      console.log('  → one-way pipe hop adds to the Phase-0 ring hop; sum ≈ total local ingress overhead before the WebRTC DataChannel (§11).');
      s.destroy();
      server.close();
      child.kill();
      process.exit(0);
    };
  });

  server.on('error', (e) => { console.error('pipe server error:', e.message); process.exit(1); });

  const child = spawn(process.execPath, [process.argv[1], '--child', pipeName], { stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code) => { if (code) console.error(`child exited early (code ${code})`); });

  server.listen(pipeName, () => console.log(`pipe listening: ${pipeName}\nspawned child pid ${child.pid}`));
}

if (process.argv.includes('--child')) {
  const name = process.argv[process.argv.indexOf('--child') + 1];
  runChild(name);
} else {
  runParent().catch((e) => { console.error('pipe spike crashed:', e); process.exit(1); });
}
