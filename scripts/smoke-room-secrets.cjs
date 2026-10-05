// Real OS-backed room-store round trip. Synthetic records, isolated profile,
// no BrowserWindow, remote peer, tracker, microphone or user room is opened.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, safeStorage } = require('electron');
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'havvn-room-secrets-'));
  const profile = path.join(output, 'profile'); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const deadline = setTimeout(() => { console.error('Room secret-store smoke deadline'); app.exit(1); }, 30_000);
  app.whenReady().then(() => {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS protection must be available');
    const root = path.resolve(__dirname, '..'), built = path.join(root, 'dist/electron/electron');
    const keyring = require(path.join(built, 'sharing/room-keyring.js'));
    const { banSnapshotCanonical } = require(path.join(root, 'dist/electron/shared/room-bans.js'));
    const { deriveMemberId } = require(path.join(built, 'sharing/room-crypto.js'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString(), priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const code = 'synthetic-private-invite-e2e', secret = crypto.randomBytes(32).toString('hex');
    const previous = Array.from({ length: 40 }, () => crypto.randomBytes(32).toString('hex'));
    const cfg = { ownerId: deriveMemberId(pub), e2e: true, secret, pub,
      sig: crypto.sign(null, Buffer.from(JSON.stringify(['th-room-e2e:v1', 'topic', deriveMemberId(pub), true, secret])), privateKey).toString('base64') };
    const keyPages = keyring.mintKeyPages('topic', cfg, previous, priv);
    const banState = { v: 1, ownerId: deriveMemberId(pub), revision: 1, bans: ['excluded-profile'], pub, sig: '' };
    banState.sig = crypto.sign(null, Buffer.from(banSnapshotCanonical('topic', banState)), privateKey).toString('base64');
    const room = { roomId: 'synthetic-room', name: 'Isolated smoke', folder: path.join(output, 'files'), createdAt: 1,
      code, e2e: true, secret, prevSecrets: previous, e2eCfg: cfg, keyPages, bans: banState.bans, banState };
    const Store = require('electron-store');
    const store = new Store({ name: 'rooms' }); store.set('rooms', { [room.roomId]: room });
    const dbPath = path.join(built, 'db/store.js'); let db = require(dbPath);
    assert.deepEqual(db.getPersistedRooms(), [room]);
    const json = fs.readFileSync(path.join(profile, 'rooms.json'), 'utf8');
    for (const sensitive of [code, secret, ...previous, banState.sig]) assert.ok(!json.includes(sensitive), 'secrets and topic-bound ban proof must be protected on disk');
    assert.equal(JSON.parse(json).rooms[room.roomId].banState, undefined);
    delete require.cache[require.resolve(dbPath)]; db = require(dbPath);
    const restored = db.getPersistedRooms()[0]; assert.deepEqual(restored, room);
    assert.ok(keyring.verifyKeyMetadata('topic', restored.e2eCfg));
    assert.ok(restored.keyPages.every(page => keyring.verifyKeyPage('topic', restored.e2eCfg, page)));
    assert.ok(crypto.verify(null, Buffer.from(banSnapshotCanonical('topic', restored.banState)), publicKey, Buffer.from(restored.banState.sig, 'base64')));
    db.importRoomIdentityBundle({ version: 1, identity: { pub, priv }, profile: { memberId: deriveMemberId(pub), name: 'Synthetic', avatarSeed: 'a' }, rooms: [room] });
    assert.equal(db.exportRoomIdentityBundle().identity.priv, priv);
    assert.deepEqual(db.exportRoomIdentityBundle().rooms[0].banState, banState);
    const imported = fs.readFileSync(path.join(profile, 'rooms.json'), 'utf8');
    for (const sensitive of [priv, code, secret, ...previous, banState.sig]) assert.ok(!imported.includes(sensitive));
    assert.equal(JSON.parse(imported).rooms[room.roomId].banState, undefined);
    const damaged = JSON.parse(imported); damaged.rooms[room.roomId].secrets.payload = 'enc:v1:broken'; store.set('rooms', damaged.rooms);
    // electron-store instances are independent readers; recreate after outside writes.
    delete require.cache[require.resolve(dbPath)]; db = require(dbPath);
    assert.equal(db.getPersistedRooms()[0].storageError, 'decrypt-failed');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile, 'rooms.json'), 'utf8')).rooms, damaged.rooms);
    const evidence = { actualOsProtection: true, legacyMigration: true, noPlaintextSecrets: true, reopenRoundTrip: true,
      cfgSignaturesIntact: true, pagedHistoryIntact: true, banProofProtected: true, banSignaturesIntact: true,
      atomicProtectedImport: true, corruptRecordPreserved: true };
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Room secret-store smoke passed:', JSON.stringify(evidence)); console.log('Isolated evidence:', path.join(output, 'evidence.json'));
    clearTimeout(deadline); app.exit(0);
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
