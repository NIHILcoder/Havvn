/** Abrupt-process-exit fixture; only writes beneath this script's exclusive temp root. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { RoomSyncApplier } = require('../dist/electron/electron/sharing/room-sync-apply.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

async function run() {
  if (process.argv.includes('--worker')) {
    const { root, request, step } = JSON.parse(process.env.HAVVN_SYNC_SPIKE_REQUEST);
    await new RoomSyncApplier(root).apply(request, current => {
      if (current === step) process.exit(73);
    });
    throw new Error('Crash checkpoint was not reached');
  }
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-crash-'));
  try {
    for (const step of ['prepared', 'previous-saved', 'published', 'committed']) {
      const destination = path.join(fixtureRoot, step);
      fs.mkdirSync(destination);
      const source = path.join(fixtureRoot, `${step}.ini`);
      fs.writeFileSync(source, 'new configuration');
      fs.writeFileSync(path.join(destination, 'config.ini'), 'previous configuration');
      const request = { relativePath: 'config.ini', source, revisionId: sha(step),
        digest: sha('new configuration'), expectedDigest: sha('previous configuration') };
      const result = spawnSync(process.execPath, [__filename, '--worker'], {
        env: { ...process.env, HAVVN_SYNC_SPIKE_REQUEST: JSON.stringify({ root: destination, request, step }) },
        windowsHide: true, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(result.status, 73, result.error?.message || result.stderr);
      const applier = new RoomSyncApplier(destination);
      const receipts = await applier.recover();
      const applied = step === 'published' || step === 'committed';
      assert.equal(receipts[0].state, applied ? 'applied' : 'rolled-back');
      assert.equal(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8'),
        applied ? 'new configuration' : 'previous configuration');
      assert.deepEqual(await applier.recover(), receipts);
      console.log(`Crash recovery passed: ${step} -> ${receipts[0].state}`);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
