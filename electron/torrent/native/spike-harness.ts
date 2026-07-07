/**
 * Engine-swap spike harness (docs/engine-swap-plan.md, step 1-2).
 *
 * Standalone CLI (plain Node, no Electron): spawns the vendored
 * transmission-daemon sidecar, adds a torrent, samples speed/peers every
 * second, exercises pause/resume, probes the RPC surface our features need,
 * and prints a verdict summary. State lives under .spike/ (gitignored).
 *
 *   npm run spike:engine -- <magnet | url | path/to/file.torrent> [--duration=90] [--keep] [--no-controls] [--no-inventory]
 */

import fs from 'node:fs';
import path from 'node:path';
import { TransmissionSidecar } from './transmission-sidecar';
import { TransmissionRpc, TrStatus } from './transmission-rpc';

const STAT_FIELDS = [
  'id', 'hashString', 'name', 'status', 'percentDone', 'metadataPercentComplete',
  'rateDownload', 'rateUpload', 'peersConnected', 'peersSendingToUs',
  'sizeWhenDone', 'downloadedEver', 'eta', 'isFinished', 'error', 'errorString',
];

const mb = (bps: number) => (bps / 1_000_000).toFixed(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ControlsResult { pausePassed: boolean; resumePassed: boolean; detail: string }

async function waitFor(desc: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(1000);
  }
  console.log(`  ✗ timed out waiting for: ${desc}`);
  return false;
}

async function testControls(rpc: TransmissionRpc, hash: string): Promise<ControlsResult> {
  console.log('\n── controls: pause ──');
  await rpc.torrentStop(hash);
  const pausePassed = await waitFor('status=stopped after torrent-stop', 10_000, async () => {
    const [t] = await rpc.torrentGet(['status', 'rateDownload'], hash);
    return t.status === TrStatus.Stopped;
  });
  console.log(pausePassed ? '  ✓ paused (status=stopped)' : '  ✗ pause FAILED');
  await sleep(3000);

  console.log('── controls: resume ──');
  await rpc.torrentStartNow(hash);
  const resumed = await waitFor('status=downloading after torrent-start-now', 15_000, async () => {
    const [t] = await rpc.torrentGet(['status'], hash);
    return t.status === TrStatus.Downloading || t.status === TrStatus.Seeding;
  });
  // Speed takes a few seconds to ramp again after reconnecting to peers.
  const flowing = resumed && await waitFor('download rate > 0 after resume', 45_000, async () => {
    const [t] = await rpc.torrentGet(['rateDownload', 'status'], hash);
    return t.status === TrStatus.Seeding || t.rateDownload > 0;
  });
  console.log(flowing ? '  ✓ resumed and transferring' : '  ✗ resume FAILED');
  return { pausePassed, resumePassed: flowing, detail: `pause=${pausePassed} resume=${flowing}` };
}

/** Probe the RPC surface the app's must-have features map onto (plan §"Ремапится"). */
async function inventory(rpc: TransmissionRpc, hash: string, downloadDir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const session = await rpc.sessionGet();
  const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, session[k]]));
  out['session'] = pick([
    'version', 'rpc-version', 'rpc-version-semver', 'utp-enabled', 'encryption',
    'dht-enabled', 'pex-enabled', 'lpd-enabled', 'peer-port', 'port-forwarding-enabled',
    'peer-limit-global', 'peer-limit-per-torrent',
    'alt-speed-enabled', 'alt-speed-down', 'alt-speed-up',
    'speed-limit-down', 'speed-limit-down-enabled', 'speed-limit-up', 'speed-limit-up-enabled',
    'blocklist-enabled', 'blocklist-url', 'blocklist-size',
    'seedRatioLimit', 'seedRatioLimited', 'idle-seeding-limit', 'idle-seeding-limit-enabled',
    'download-queue-enabled', 'sequential_download', 'default-trackers',
  ]);

  // Per-torrent surface: files/priorities/peers/trackers/pieces + sequential mode.
  const probeFields = [
    'files', 'fileStats', 'priorities', 'wanted', 'peers', 'trackerStats',
    'pieces', 'pieceCount', 'pieceSize', 'availability', 'sequential_download',
    'downloadLimit', 'downloadLimited', 'uploadLimit', 'uploadLimited',
    'seedRatioLimit', 'seedRatioMode', 'seedIdleLimit', 'seedIdleMode', 'labels', 'group',
  ];
  const [t] = await rpc.torrentGet(probeFields, hash);
  const tt = t as unknown as Record<string, unknown>;
  out['torrentFieldPresence'] = Object.fromEntries(probeFields.map((f) => [f, tt[f] !== undefined]));
  const files = t.files ?? [];
  out['files'] = { count: files.length, first: files[0], firstHasPieceBounds: (files[0] as unknown as Record<string, unknown>)?.['beginPiece'] !== undefined || (files[0] as unknown as Record<string, unknown>)?.['begin_piece'] !== undefined };
  const peers = t.peers ?? [];
  out['peerSample'] = peers.slice(0, 3).map((p) => ({
    address: p.address, port: p.port, clientName: p.clientName, isUTP: p.isUTP,
    isEncrypted: p.isEncrypted, rateToClient: p.rateToClient, rateToPeer: p.rateToPeer,
    progress: p.progress, flagStr: p.flagStr,
  }));
  out['peerCounts'] = { total: peers.length, utp: peers.filter((p) => p.isUTP).length, encrypted: peers.filter((p) => p.isEncrypted).length };
  out['trackerStatsSample'] = (t.trackerStats ?? []).slice(0, 2);

  // Mutators: set → read back → restore.
  const roundtrips: Record<string, boolean | string> = {};
  try {
    await rpc.torrentSet(hash, { downloadLimit: 512, downloadLimited: true, uploadLimit: 256, uploadLimited: true });
    const [lim] = await rpc.torrentGet(['downloadLimit', 'downloadLimited', 'uploadLimit', 'uploadLimited'], hash);
    const l = lim as unknown as Record<string, unknown>;
    roundtrips['perTorrentSpeedLimits'] = l['downloadLimit'] === 512 && l['downloadLimited'] === true && l['uploadLimit'] === 256;
    await rpc.torrentSet(hash, { downloadLimited: false, uploadLimited: false });
  } catch (e) { roundtrips['perTorrentSpeedLimits'] = String(e); }

  try {
    await rpc.torrentSet(hash, { sequential_download: true });
    const [seq] = await rpc.torrentGet(['sequential_download'], hash);
    roundtrips['sequentialDownload'] = (seq as unknown as Record<string, unknown>)['sequential_download'] === true;
    await rpc.torrentSet(hash, { sequential_download: false });
  } catch (e) { roundtrips['sequentialDownload'] = String(e); }

  try {
    await rpc.torrentSet(hash, { 'priority-high': [0] });
    const [pri] = await rpc.torrentGet(['priorities'], hash);
    roundtrips['filePriority'] = ((pri as unknown as { priorities?: number[] }).priorities ?? [])[0] === 1;
    await rpc.torrentSet(hash, { 'priority-normal': [0] });
  } catch (e) { roundtrips['filePriority'] = String(e); }

  try {
    // tracker mutation via read-modify-write of trackerList (4.0+ replacement for trackerAdd/Remove)
    const [before] = await rpc.torrentGet(['trackerList'], hash);
    const list = String((before as unknown as Record<string, unknown>)['trackerList'] ?? '');
    const probe = 'udp://spike-probe.invalid:6969/announce';
    await rpc.torrentSet(hash, { trackerList: list ? `${list}\n\n${probe}` : probe });
    const [after] = await rpc.torrentGet(['trackerList'], hash);
    roundtrips['trackerListEdit'] = String((after as unknown as Record<string, unknown>)['trackerList']).includes(probe);
    await rpc.torrentSet(hash, { trackerList: list }); // restore
  } catch (e) { roundtrips['trackerListEdit'] = String(e); }

  try {
    await rpc.sessionSet({ 'alt-speed-enabled': true, 'alt-speed-down': 1000, 'alt-speed-up': 100 });
    const s2 = await rpc.sessionGet();
    roundtrips['altSpeed'] = s2['alt-speed-enabled'] === true && s2['alt-speed-down'] === 1000;
    await rpc.sessionSet({ 'alt-speed-enabled': false });
  } catch (e) { roundtrips['altSpeed'] = String(e); }

  try {
    await rpc.sessionSet({ 'blocklist-url': 'https://example.invalid/blocklist.gz', 'blocklist-enabled': true });
    const s3 = await rpc.sessionGet();
    roundtrips['blocklistConfig'] = s3['blocklist-enabled'] === true && s3['blocklist-url'] === 'https://example.invalid/blocklist.gz';
    await rpc.sessionSet({ 'blocklist-enabled': false });
  } catch (e) { roundtrips['blocklistConfig'] = String(e); }

  try {
    await rpc.torrentSet(hash, { seedRatioLimit: 2.5, seedRatioMode: 1, seedIdleLimit: 30, seedIdleMode: 1 });
    const [sr] = await rpc.torrentGet(['seedRatioLimit', 'seedRatioMode', 'seedIdleLimit', 'seedIdleMode'], hash);
    const s = sr as unknown as Record<string, unknown>;
    roundtrips['seedLimits'] = s['seedRatioLimit'] === 2.5 && s['seedRatioMode'] === 1 && s['seedIdleLimit'] === 30;
    await rpc.torrentSet(hash, { seedRatioMode: 0, seedIdleMode: 0 });
  } catch (e) { roundtrips['seedLimits'] = String(e); }

  out['roundtrips'] = roundtrips;
  try { out['freeSpace'] = await rpc.freeSpace(downloadDir); } catch (e) { out['freeSpace'] = String(e); }
  try { out['sessionStats'] = await rpc.sessionStats(); } catch (e) { out['sessionStats'] = String(e); }
  try { out['portTest'] = await rpc.portTest(); } catch (e) { out['portTest'] = String(e); } // informational — depends on router
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const source = argv.find((a) => !a.startsWith('--'));
  if (!source) {
    console.error('usage: spike-harness <magnet | url | path/to/file.torrent> [--duration=90] [--keep] [--no-controls] [--no-inventory]');
    process.exit(2);
  }
  const durationS = Number(argv.find((a) => a.startsWith('--duration='))?.split('=')[1] ?? 90);
  const keep = argv.includes('--keep');
  const runControls = !argv.includes('--no-controls');
  const runInventory = !argv.includes('--no-inventory');

  const repoRoot = process.cwd();
  const binaryPath = path.join(repoRoot, 'vendor', 'transmission', 'win32-x64', 'transmission-daemon.exe');
  if (!fs.existsSync(binaryPath)) {
    console.error(`engine binary missing: ${binaryPath}\nrun: node scripts/fetch-transmission.mjs`);
    process.exit(2);
  }
  const spikeDir = path.join(repoRoot, '.spike');
  const downloadDir = path.join(spikeDir, 'downloads');

  const sidecar = new TransmissionSidecar({
    binaryPath,
    configDir: path.join(spikeDir, 'transmission-config'),
    downloadDir,
    onLog: (line) => console.log(`  [daemon] ${line}`),
    onUnexpectedExit: (code) => { console.error(`daemon exited unexpectedly (code ${code})`); process.exit(1); },
  });

  // Ctrl-C / kill: stop the sidecar so we never leave an orphaned daemon behind
  // (belt to the pid-file suspenders — this cleans up in-run, that on next run).
  const onSignal = () => { void sidecar.stop().finally(() => process.exit(130)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log('spawning transmission-daemon sidecar...');
  const t0 = Date.now();
  let exitCode = 0;
  try {
    const rpc = await sidecar.start();
    const session = await rpc.sessionGet();
    console.log(`ready in ${Date.now() - t0}ms — transmission ${session['version']}, rpc ${session['rpc-version-semver'] ?? session['rpc-version']}, pid ${sidecar.pid}, rpcPort ${sidecar.rpcPort}, peerPort ${sidecar.peerPort}`);

    const isFile = /\.torrent$/i.test(source) && fs.existsSync(source);
    const added = isFile
      ? await rpc.torrentAdd({ metainfo: fs.readFileSync(source) })
      : await rpc.torrentAdd({ filename: source });
    console.log(`added: ${added.name} (${added.hashString})${added.duplicate ? ' [duplicate]' : ''}`);
    const hash = added.hashString;

    // ── Sampling loop ────────────────────────────────────────────────────────
    // `--duration` counts ACTIVE seconds (download rate > 0): tracker outages /
    // cold-DHT bootstrap can mean minutes at 0 peers, which must not eat the
    // measurement window or trigger the pause/resume test on a dead swarm.
    const samples: Array<{ bps: number; peers: number }> = [];
    let active = 0;
    let controls: ControlsResult | null = null;
    let metadataAnnounced = false;
    const loopStart = Date.now();
    const hardDeadline = loopStart + Math.max(600_000, durationS * 4000);
    for (;;) {
      const [t] = await rpc.torrentGet(STAT_FIELDS, hash);
      if (!metadataAnnounced && t.metadataPercentComplete >= 1) {
        metadataAnnounced = true;
        console.log(`metadata complete: ${t.name} — ${(t.sizeWhenDone / 1e9).toFixed(2)} GB`);
      }
      const line = `[${String(Math.round((Date.now() - loopStart) / 1000)).padStart(4)}s] ` +
        `${TrStatus[t.status]} ${(t.percentDone * 100).toFixed(1).padStart(5)}% ` +
        `↓ ${mb(t.rateDownload).padStart(6)} MB/s ↑ ${mb(t.rateUpload)} MB/s ` +
        `peers ${t.peersConnected} (${t.peersSendingToUs} sending) eta ${t.eta > 0 ? `${t.eta}s` : '—'}` +
        (t.error ? ` ERROR(${t.error}): ${t.errorString}` : '');
      console.log(line);
      if (t.error) { exitCode = 1; break; }
      if (t.status === TrStatus.Downloading) {
        samples.push({ bps: t.rateDownload, peers: t.peersConnected });
        if (t.rateDownload > 0) active++;
      }

      // Only exercise pause/resume once the swarm is demonstrably alive —
      // resuming into zero reachable peers proves nothing about the engine.
      if (runControls && !controls && active >= 20) controls = await testControls(rpc, hash);
      const done = t.status === TrStatus.Seeding || t.isFinished || t.percentDone >= 1;
      if (done || active >= durationS || Date.now() > hardDeadline) break;
      await sleep(1000);
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    const rates = samples.map((s) => s.bps).sort((a, b) => a - b);
    // Steady window: from the first nonzero-rate sample, skipping 10s of ramp-up.
    const firstActive = samples.findIndex((s) => s.bps > 0);
    const steady = (firstActive < 0 ? [] : samples.slice(firstActive + 10)).map((s) => s.bps).sort((a, b) => a - b);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
    console.log('\n══ SPEED SUMMARY ══');
    console.log(`samples: ${samples.length} downloading-seconds, ${active} with traffic; ${firstActive < 0 ? 'swarm never became active' : `first traffic at ${firstActive}s`}`);
    console.log(`steady (post-ramp): avg ${mb(avg(steady))} MB/s · p10 ${mb(q(steady, 0.10))} · median ${mb(q(steady, 0.5))} · p90 ${mb(q(steady, 0.9))} · max ${mb(rates[rates.length - 1] ?? 0)}`);
    console.log(`peers: max ${Math.max(0, ...samples.map((s) => s.peers))}`);
    if (controls) console.log(`controls: ${controls.detail}`);

    if (runInventory) {
      console.log('\n══ API INVENTORY ══');
      const inv = await inventory(rpc, hash, downloadDir);
      const invPath = path.join(spikeDir, 'inventory.json');
      fs.writeFileSync(invPath, JSON.stringify(inv, null, 2));
      console.log(JSON.stringify({ session: inv['session'], roundtrips: inv['roundtrips'], peerCounts: inv['peerCounts'], torrentFieldPresence: inv['torrentFieldPresence'] }, null, 2));
      console.log(`full inventory → ${invPath}`);
    }

    if (!keep) {
      console.log('\nremoving spike torrent (+data)...');
      await rpc.torrentRemove(hash, true);
      await sleep(1000);
    }
  } catch (e) {
    exitCode = 1;
    console.error('spike failed:', e instanceof Error ? e.message : e);
  } finally {
    console.log('stopping daemon...');
    await sidecar.stop();
    console.log('daemon stopped.');
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error('spike crashed:', e); process.exit(1); });
