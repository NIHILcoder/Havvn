// Audit checks against CURRENT source. Fixed cases now assert the corrected behavior.
// The immutable baseline remains in rooms-2026-10-02-evidence.json.
// Loads actual TypeScript; no Electron profile, physical microphone or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'tmp', 'rooms-audit');
fs.mkdirSync(output, { recursive: true });
function load(rel, requires = {}) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports = {};
  const context = { exports, require: name => name in requires ? requires[name] : require(name), console, Buffer, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval, navigator: {}, MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } } };
  vm.runInNewContext(js, context, { filename: rel });
  return { exports, context };
}
function stream() {
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; }, clone() { return { ...this }; } };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}
async function main() {
  const evidence = [];
  const hooks = { selfId: 'A', iceServers: [], sendSignal() {}, announce() {}, announceShare() {}, sendLoopback() {}, onChange() {}, log() {}, warn() {} };
  const desktopStream = stream();
  let resolveCapture;
  // The navigator gate is real; hardware capture itself is an injected deferred promise.
  const voicePolicy = load('shared/room-voice-policy.ts').exports;
  const voiceRecovery = load('shared/room-voice-recovery.ts').exports;
  const voiceLoaded = load('electron/sharing/room-voice.ts', {
    '../../shared/room-voice-policy': voicePolicy, '../../shared/room-voice-recovery': voiceRecovery,
    './voice/rnnoise-wasm': { RNNOISE_WASM_BASE64: '' }, './voice/rnnoise-worklet': { RNNOISE_WORKLET_SOURCE: '' }, './voice/screen-aec': { ScreenAec: {} },
  });
  voiceLoaded.context.navigator.mediaDevices = { getUserMedia() {} };
  const d = new voiceLoaded.exports.VoiceSession(hooks);
  d.captureMic = () => new Promise(resolve => { resolveCapture = resolve; });
  d.buildPipeline = async s => s;
  d.applySettings = () => {};
  const pendingJoin = d.join();
  d.leave();
  resolveCapture({ stream: desktopStream });
  await pendingJoin;
  assert.equal(d.isActive(), false);
  assert.equal(desktopStream.track.stopped, true);
  evidence.push({ id: 'VOICE-CANCEL', status: 'fixed', activeAfterLeave: d.isActive(), microphoneStillOpen: !desktopStream.track.stopped });
  d.leave();

  const guestLoaded = load('guest/voice.ts', { '../shared/room-voice-policy': voicePolicy, '../shared/room-voice-recovery': voiceRecovery });
  const streams = [];
  guestLoaded.context.navigator.mediaDevices = { getUserMedia: async () => { const s = stream(); streams.push(s); return s; } };
  const guest = new guestLoaded.exports.GuestVoice(hooks);
  await guest.join(); guest.setMuted(true); guest.leave(); await guest.join();
  assert.equal(guest.muted, true);
  assert.equal(streams[1].track.enabled, false);
  evidence.push({ id: 'GUEST-MUTE', status: 'fixed', displayedMuted: guest.muted, transmittedTrackEnabled: streams[1].track.enabled });
  guest.leave();
  guest.onPeerState('B', true, false, 10); guest.onPeerState('B', false, false, 20); guest.onPeerState('B', true, false, 10);
  assert.equal(guest.participants().some(p => p.memberId === 'B'), false);
  evidence.push({ id: 'GUEST-REPLAY', status: 'fixed', oldPresenceResurrectsParticipant: false });

  const engineSource = fs.readFileSync(path.join(root, 'electron/sharing/room-engine.ts'), 'utf8');
  const clampSource = engineSource.slice(engineSource.indexOf('function clampGossip('), engineSource.indexOf('\n// Session state is keyed'));
  const clampJs = ts.transpileModule(clampSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const clamp = vm.runInNewContext(clampJs + '\nclampGossip');
  for (const value of [null, false, 42, 'frame', []]) assert.doesNotThrow(() => clamp(value));
  evidence.push({ id: 'GOSSIP-SHAPE', status: 'fixed', decodedNullThrowsOutsideDecryptCatch: false });

  const storage = path.join(output, 'storage'); fs.mkdirSync(storage, { recursive: true });
  const { exports: e2e } = load('electron/sharing/room-e2e.ts', { fs, crypto: require('node:crypto') });
  const secret = e2e.generateRoomSecret();
  const a = path.join(storage, 'source-a'), b = path.join(storage, 'source-b'), dst = path.join(storage, 'same.txt');
  fs.writeFileSync(a, 'A-content'); fs.writeFileSync(b, 'B-content');
  for (const old of [a + '.enc', b + '.enc']) if (fs.existsSync(old)) fs.unlinkSync(old);
  await e2e.encryptFile(a, a + '.enc', secret); await e2e.encryptFile(b, b + '.enc', secret);
  // This is isolated audit data, not a room/user source.
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  await e2e.decryptFile(a + '.enc', dst, secret);
  await assert.rejects(e2e.decryptFile(b + '.enc', dst, secret));
  assert.equal(fs.readFileSync(dst, 'utf8'), 'A-content');
  evidence.push({ id: 'FILE-COLLISION', status: 'fixed', secondDifferentContentReplacesFirstAtSamePlaintextPath: false });

  const storageHelpers = load('electron/sharing/room-file-storage.ts').exports;
  const file = { fileId: 'b'.repeat(40), infoHash: 'b'.repeat(40), name: 'same.txt', size: 9, addedAt: 1, magnetURI: 'magnet:?xt=urn:btih:' + 'b'.repeat(40) };
  const transfers = new Map(), room = { roomId: 'audit', folder: storage, transfers, files: new Map([[file.fileId, file]]), folders: new Map(), trackers: [] };
  const rooms = new Map([['audit', room]]);
  const storageSource = engineSource.slice(engineSource.indexOf('type ReceiveLease'), engineSource.indexOf('/** Append an activity-log event'));
  const ensureSource = engineSource.slice(engineSource.indexOf('function ensureLocal('), engineSource.indexOf('function wireTorrentStats('));
  const transferSource = engineSource.slice(engineSource.indexOf('function setTransfer('), engineSource.indexOf('/** Seed a local file'));
  const ensureJs = ts.transpileModule(storageSource + transferSource + ensureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let downloadPath;
  const context = {
    ...load('shared/room-manifest-sync.ts').exports,
    RoomReceiveQueue: load('electron/sharing/room-receive-queue.ts').exports.RoomReceiveQueue,
    RoomDiskBudget: load('electron/sharing/room-disk-budget.ts').exports.RoomDiskBudget,
    queueMicrotask, setTimeout, clearTimeout,
    ...storageHelpers, contentKeyEpoch: secret => require('node:crypto').createHash('sha256').update('th-room-content-epoch:v2\0').update(Buffer.from(secret, 'hex')).digest('hex'), fs, path, Buffer, rooms, crypto: require('node:crypto'), clients: new Map(), decryptFile: e2e.decryptFile, netSuspended: false, isTombstonedAt: () => false,
    ensureClient: () => ({}), findTorrent: () => null, safeDirSegment: name => name,
    ipcRenderer: { send() {} }, closeStreamServers() {}, log() {}, pushState() {}, broadcast() {},
    addKnownTorrent: (_c, _h, _source, options) => { downloadPath = options.path; return { on() {} }; },
  };
  const local = vm.runInNewContext(ensureJs + '\nensureLocal', context);
  await local(room, file);
  assert.notEqual(downloadPath, storage); assert.equal(transfers.get(file.fileId).haveLocally, false);
  assert.equal(fs.readFileSync(dst, 'utf8'), 'A-content');
  evidence.push({ id: 'FILE-EXISTS', status: 'fixed', unrelatedSameNameMarkedPresentWithoutContentVerification: false });

  const statsSource = engineSource.slice(engineSource.indexOf('function wireTorrentStats('), engineSource.indexOf('\n// ── Rendezvous tracker'));
  const statsJs = ts.transpileModule(statsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const failure = { stage: 'decryption', code: 'authentication', message: 'No matching room key' };
  room.transfers.set(file.fileId, { haveLocally: false, status: 'error', phase: 'error', error: failure, cipherReady: true });
  const stats = vm.runInNewContext(statsJs + '\nwireTorrentStats', {
    rooms, storageFor: context.storageFor, setTransfer: context.setTransfer, maybeBroadcastProg() {}, pushState() {}, log() {},
  });
  stats(room, { infoHash: file.fileId, progress: 1, done: true, on() {}, once() {} });
  assert.equal(room.transfers.get(file.fileId).haveLocally, false); assert.equal(room.transfers.get(file.fileId).status, 'error');
  assert.equal(room.transfers.get(file.fileId).phase, 'error'); assert.equal(room.transfers.get(file.fileId).error, failure);
  const createTorrent = (await import('create-torrent')).default;
  const metadata = await new Promise((resolve, reject) => createTorrent(a + '.enc', { name: 'source-a.enc', announce: [] }, (e, bytes) => e ? reject(e) : resolve(Buffer.from(bytes))));
  const hash = require('parse-torrent')(metadata).infoHash;
  const encryptedFile = { fileId: hash, infoHash: hash, name: 'source-a', size: 9, enc: true, addedAt: 1 };
  room.e2e = true; room.secret = ''; room.prevSecrets = []; room.self = { memberId: 'audit' }; room.cacheDir = storage;
  room.files.set(hash, encryptedFile); room.transfers.set(hash, { cipherPath: a + '.enc', cipherReady: true, haveLocally: false });
  context.storageFor(room).metadata.set(hash, metadata);
  await context.decryptOne(room, encryptedFile, a + '.enc');
  assert.equal(room.transfers.get(hash).phase, 'waiting-key'); assert.equal(room.transfers.get(hash).haveLocally, false);
  room.secret = e2e.generateRoomSecret(); await context.decryptOne(room, encryptedFile, a + '.enc');
  assert.equal(room.transfers.get(hash).error.code, 'authentication');
  context.addKnownTorrent = () => { throw new Error('Retry unexpectedly started a torrent'); };
  room.secret = secret; context.retryDecrypt('audit', hash); await context.storageFor(room).decrypting.get(hash);
  assert.equal(room.transfers.get(hash).phase, 'ready'); assert.equal(room.transfers.get(hash).haveLocally, true);
  assert.equal(fs.readFileSync(context.verifiedLocalFile('audit', hash), 'utf8'), 'A-content');
  rooms.clear(); context.cancelReceives(room);
  evidence.push({ id: 'E2E-STATE', status: 'fixed', ciphertextCompleteMarkedPlaintextReady: false, previousDecryptErrorOverwritten: false, waitingKeyExplicit: true, retryWithoutDownload: true });

  const backfillSource = engineSource.slice(engineSource.indexOf('function sendChatBackfill('), engineSource.indexOf('\n// ── Chat authorship'));
  const backfillJs = ts.transpileModule(backfillSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // Isolate backfill serialization here; real signatures/limits are exercised by integration tests.
  let backfill;
  const chatHistory = load('shared/room-chat-history.ts').exports;
  const serve = vm.runInNewContext(backfillJs + '\nsendChatBackfill', { chatBackfillPages: chatHistory.chatBackfillPages, ingressByWire: new WeakMap(), ingressByRoom: new WeakMap(), ingressBudget: () => ({ take: () => true }), verifyChat: () => true, sendTo: (_r, _w, msg) => { backfill = msg; } });
  const chat = [{ id: 'reply', at: 20, memberId: 'B', text: 'reply', pub: 'p', sig: 's', replyTo: 'parent', replyText: 'quoted' }, { id: 'late', at: 10, memberId: 'C', text: 'delayed', pub: 'p', sig: 's' }];
  serve({ chat, bans: new Set() }, {}, { chatSync: 2, chatIds: [] });
  assert.equal(backfill.msgs[0].replyTo, 'parent');
  assert.equal(backfill.msgs[0].replyText, 'quoted');
  backfill = null; serve({ chat, bans: new Set() }, {}, { chatSync: 2, chatIds: ['reply'], chatAt: 15 });
  assert.equal(backfill.msgs.some(m => m.id === 'late'), true);
  evidence.push({ id: 'CHAT-BACKFILL', status: 'fixed', replyContextDropped: false, delayedLowerTimestampMissed: false, idBased: true });

  const log = { info() {}, warn() {}, error() {} };
  const roomDb = { getSettings: async () => ({}), getPersistedRooms: () => [], getRoomProfile: () => ({ memberId: 'A' }) };
  const electron = { ipcMain: { on() {}, handle() {} }, app: { getPath: () => storage }, shell: {} };
  const managerLoaded = load('electron/sharing/room-manager.ts', {
    electron, uuid: { v4: () => 'id' }, '../utils': { logger: { child: () => log } }, '../i18n': { t: x => x }, '../db/store': roomDb,
    './room-crypto': {}, '../../shared/media': {}, '../torrent/subtitle-probe': {}, './room-e2e': {}, '../gameserver/server-mirror': {},
    '../utils/global-ptt': {}, '../lan/lan-manager': { getLanManager: () => ({ configure() {} }) }, '../../shared/lan-quality': {}, '../../shared/lan-prefs': {},
    './room-file-storage': storageHelpers, './ice-servers': {}, '../utils/os-notify': {}, './room-engine-policy': {}, '../../shared/room-owner-pin': {},
    '../../shared/room-chat-delivery': load('shared/room-chat-delivery.ts').exports,
    '../../shared/room-resources': load('shared/room-resources.ts').exports,
    '../../shared/room-diagnostics': load('shared/room-diagnostics.ts', { './room-capabilities': load('shared/room-capabilities.ts').exports }).exports,
  });
  const manager = new managerLoaded.exports.RoomManager();
  manager.win = { isDestroyed: () => false }; manager.ready = false;
  let settled = false;
  let rejectStartup;
  const startupPromise = new Promise((_resolve, reject) => { rejectStartup = reject; });
  manager.startup = { promise: startupPromise, reject: rejectStartup, timer: setTimeout(() => {}, 20000) };
  const waiting = manager.ensureWindow().then(() => { settled = true; }, () => { settled = true; });
  manager.failAll('engine crashed');
  await waiting;
  assert.equal(settled, true); assert.equal(manager.startup, null);
  evidence.push({ id: 'ENGINE-READY', status: 'fixed', startupWaitRemainsPendingAfterFailAll: false });
  roomDb.getPersistedRooms = () => [{ roomId: 'room-A' }];
  manager.cache.set('room-A', {}); manager.win = null; manager.ready = false;
  manager.reactivate = async () => { throw new Error('Engine unavailable'); };
  await assert.rejects(manager.sendChat('room-A', 'test'), /Engine unavailable/);
  evidence.push({ id: 'CHAT-ACK', status: 'fixed', returnedSuccessWithoutSendingToAnyEngine: false });
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
