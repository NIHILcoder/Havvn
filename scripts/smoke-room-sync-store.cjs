// Native safeStorage + electron-store, isolated synthetic profile, no windows or network.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-sync-native-'));
  const profile = path.join(fixture, 'profile'); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Native sync-store deadline'); app.exit(1); }, 30_000);
  app.whenReady().then(() => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'Native system encryption must be available');
    const built = path.resolve(__dirname, '../dist/electron/electron');
    const { openRoomSyncStore } = require(path.join(built, 'db/room-sync-store.js'));
    const { signSyncPolicy, signSyncRevision } = require(path.join(built, 'sharing/room-sync-proofs.js'));
    const { deriveMemberId } = require(path.join(built, 'sharing/room-crypto.js'));
    const keys = crypto.generateKeyPairSync('ed25519');
    const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const priv = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const ownerId = deriveMemberId(pub), entryId = crypto.randomUUID();
    const context = { scope: 'private-native-room-context', rootId: crypto.randomUUID(), ownerId, e2e: false };
    const storePath = path.join(profile, 'file-sync');
    const store = openRoomSyncStore(storePath, 'synthetic-local-room', context);
    assert.equal(store.binding(), null);
    const policy = signSyncPolicy(context.scope, { v: 1, rootId: context.rootId, epoch: 1, parentPolicyId: null,
      ownerId, publisherId: ownerId, name: 'Native private folder title', allowDeletes: false, baseHeads: [], pub }, priv);
    store.acceptPolicy(policy, true);
    const revision = signSyncRevision(context.scope, { v: 1, rootId: context.rootId, policyId: policy.policyId,
      entryId, parents: [], relativePath: 'private-native.ini', op: 'put',
      blob: { infoHash: 'a'.repeat(40), name: 'private-native.ini', size: 5, enc: false, keyEpoch: null }, authorId: ownerId, createdAt: 1, pub }, priv);
    store.bind(path.join(fixture, 'private-working-folder'));
    store.acceptRevision(revision, true, 'd'.repeat(64));
    const file = path.join(storePath, fs.readdirSync(storePath).find(name => name.endsWith('.json')));
    const ciphertext = fs.readFileSync(file, 'utf8');
    for (const sensitive of [context.scope, policy.name, revision.relativePath, priv, 'private-working-folder']) assert.ok(!ciphertext.includes(sensitive));
    const restored = openRoomSyncStore(storePath, 'synthetic-local-room', context);
    assert.deepEqual(restored.heads(), store.heads()); assert.deepEqual(restored.outbox(), store.outbox());
    assert.deepEqual(restored.applied(), store.applied()); assert.deepEqual(restored.binding(), store.binding());
    assert.equal(restored.binding().autoApply, false);
    const plan = restored.prepareLogCompaction(); assert.ok(plan.savedBytes > 0);
    restored.compactLog(plan);
    const compacted = openRoomSyncStore(storePath, 'synthetic-local-room', context);
    assert.deepEqual(compacted.records(), store.records()); assert.deepEqual(compacted.outbox(), store.outbox()); assert.deepEqual(compacted.applied(), store.applied());
    assert.equal(compacted.logSummary().pending, 0);
    const compactCiphertext = fs.readFileSync(file, 'utf8');
    for (const sensitive of [context.scope, policy.name, revision.relativePath, priv, 'private-working-folder', 'gzip']) assert.ok(!compactCiphertext.includes(sensitive));
    restored.acknowledge(policy.policyId);
    assert.equal(openRoomSyncStore(storePath, 'synthetic-local-room', context).outbox().length, 1);
    console.log('Native sync-store passed: protected metadata and compressed archive, verified reload, durable outbox, disabled initial binding');
  }).then(() => {
    clearTimeout(deadline); fs.rmSync(fixture, { recursive: true, force: true }); app.exit(0);
  }).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1); });
}
