/* eslint-disable @typescript-eslint/no-require-imports -- This fixture runs as CommonJS in both Node and Electron. */
// Two real Electron room managers, isolated profiles, loopback tracker and host-only WebRTC.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const PREFIX = 'SYNC_FIXTURE ';
// An atomic replacement can remove the pathname between exists() and read().
// Poll absence until delivery; propagate every error other than ENOENT.
function readFixtureText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const ui = process.argv.includes('--ui');
const conflictsOnly = process.argv.includes('--conflicts-only');
const faults = process.argv.includes('--faults');
const writers = process.argv.includes('--writers');
const editor = process.argv.includes('--editor');
const moves = process.argv.includes('--moves');
const compaction = process.argv.includes('--compaction');
const checkpoint = process.argv.includes('--checkpoint');
const multipart = process.argv.includes('--multipart');
const history = process.argv.includes('--history');
const library = process.argv.includes('--library');
const deletes = process.argv.includes('--deletes');
const paths = process.argv.includes('--paths');
const metadata = process.argv.includes('--metadata');
const missing = process.argv.includes('--missing');
const trashStorage = process.argv.includes('--trash-storage');
const documents = process.argv.includes('--documents');
if (documents && (!ui || trashStorage || missing || metadata || paths || deletes || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--documents requires --ui and its own scenario');
if (trashStorage && (!ui || missing || metadata || paths || deletes || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--trash-storage requires --ui and its own scenario');
if (missing && (!ui || metadata || paths || deletes || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--missing requires --ui and its own scenario');
if (metadata && (!ui || paths || deletes || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--metadata requires --ui and its own scenario');
if (paths && (!ui || deletes || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--paths requires --ui and its own scenario');
if (deletes && (!ui || library || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--deletes requires --ui and its own scenario');
if (library && (!ui || history || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--library requires --ui and its own scenario');
if (history && (!ui || checkpoint || multipart || writers || editor || moves || faults || compaction)) throw new Error('--history requires --ui and its own scenario');
if (multipart && (!ui || checkpoint || writers || editor || moves || faults || compaction)) throw new Error('--multipart requires --ui and its own scenario');
if (checkpoint && (!ui || writers || editor || moves || faults || compaction)) throw new Error('--checkpoint requires --ui and its own scenario');
if (compaction && (!ui || writers || editor || moves || faults)) throw new Error('--compaction requires --ui and its own scenario');
if (moves && (writers || editor || faults)) throw new Error('--moves is a separate scenario');
if (editor && (!ui || writers || faults)) throw new Error('--editor requires --ui and its own scenario');
if (writers && faults) throw new Error('--writers and --faults are separate scenarios');
if (faults && (ui || process.platform !== 'win32')) throw new Error('--faults requires Windows and the non-UI scenario');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { createInterface } = require('node:readline');
  (async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-rooms-'));
    const workers = []; let passed = false, roomIds;
    const evidence = { version: require('../package.json').version, startedAt: new Date().toISOString(), platform: process.platform,
      os: os.release(), physicalMachines: 1, loopbackOnly: true, officeOrIdeTested: false, checks: [] };
    const record = id => evidence.checks.push({ id, passed: true });
    const { Server } = await import('bittorrent-tracker');
    const tracker = new Server({ udp: false, http: false, ws: true, stats: false });
    tracker.on('error', error => console.error('Fixture tracker:', error.message));
    await new Promise(resolve => tracker.listen(0, '127.0.0.1', resolve));
    const trackerUrl = `ws://127.0.0.1:${tracker.http.address().port}`;
    const relayTracker = documents ? new Server({ udp: false, http: false, ws: true, stats: false }) : null;
    if (relayTracker) { relayTracker.on('error', error => console.error('Relay tracker:', error.message)); await new Promise(resolve => relayTracker.listen(0, '127.0.0.1', resolve)); }
    const relayTrackerUrl = relayTracker ? `ws://127.0.0.1:${relayTracker.http.address().port}` : '';
    const launch = async name => {
      const directory = path.join(fixture, name); fs.mkdirSync(directory, { recursive: true });
      const env = { ...process.env, HAVVN_SYNC_FIXTURE_DIRECTORY: directory, HAVVN_SYNC_FIXTURE_TRACKER: trackerUrl, HAVVN_SYNC_FIXTURE_UI: ui ? '1' : '', HAVVN_SYNC_FIXTURE_DOCUMENTS: documents ? '1' : '', HAVVN_SYNC_FIXTURE_DELETES: deletes || paths || metadata || missing || trashStorage ? '1' : '' }; delete env.ELECTRON_RUN_AS_NODE; delete env.HAVVN_FILE_SYNC;
      if (documents && name === 'receiver') env.HAVVN_SYNC_FIXTURE_EXTRA_TRACKER = relayTrackerUrl;
      if (documents && name === 'relayed') env.HAVVN_SYNC_FIXTURE_TRACKER = relayTrackerUrl;
      const child = spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let sequence = 0, stderr = '';
      const pending = new Map();
      const ready = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
      const receive = line => {
        if (!line.startsWith(PREFIX)) { stderr = (stderr + '\n' + line).slice(-10000); return; }
        const response = JSON.parse(line.slice(PREFIX.length)), waiter = pending.get(response.id);
        if (!waiter) return; pending.delete(response.id);
        if (response.ok) waiter.resolve(response.result); else waiter.reject(new Error(response.error));
      };
      createInterface({ input: child.stdout }).on('line', receive);
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000); });
      child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
      child.on('exit', code => { for (const waiter of pending.values()) waiter.reject(new Error(`Fixture ${name} exited ${code}: ${stderr}`)); pending.clear(); });
      const call = (action, values = {}) => new Promise((resolve, reject) => {
        // Room setup includes both the engine startup budget and the command's own deadline.
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture ${name}/${action} timed out: ${stderr}`)); }, ['create', 'join', 'restore'].includes(action) ? 60_000 : 30_000);
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        worker.socket.write(JSON.stringify({ id, action, ...values }) + '\n');
      });
      const worker = { child, call, directory, logs: () => stderr }; workers.push(worker);
      const timer = setTimeout(() => pending.get(0)?.reject(new Error(`Fixture ${name} startup timed out: ${stderr}`)), 30_000);
      try {
        const { port } = await ready;
        worker.socket = require('node:net').createConnection({ port, host: '127.0.0.1' });
        await new Promise((resolve, reject) => { worker.socket.once('connect', resolve); worker.socket.once('error', reject); });
        createInterface({ input: worker.socket }).on('line', receive);
      } finally { clearTimeout(timer); }
      return worker;
    };
    const waitFor = async (read, predicate, message) => {
      const deadline = Date.now() + 30_000; let last;
      while (Date.now() < deadline) { last = await read(); if (predicate(last)) return last; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error(`${message}: ${JSON.stringify(last)}`);
    };
    const stop = async worker => {
      const exited = new Promise(resolve => worker.child.once('exit', resolve));
      await worker.call('stop'); await exited;
    };
    try {
      let left = await launch('publisher'), right = await launch('receiver');
      if (faults) evidence.runtime = await left.call('runtime');
      const created = await left.call('create'); const joined = await right.call('join', { invite: created.invite });
      roomIds = { publisher: created.roomId, receiver: joined.roomId };
      await waitFor(() => left.call('inspect', { roomId: created.roomId }), state => state.members >= 2, 'Publisher did not connect');
      await waitFor(() => right.call('inspect', { roomId: joined.roomId }), state => state.members >= 2 && state.owner, 'Receiver did not connect');
      if (documents) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        const click = async (worker, selector) => {
          await waitFor(() => worker.call('ui-control-ready', { selector }), Boolean, 'Document control did not become available: ' + selector);
          return worker.call('ui-doc-click', { selector });
        };
        const state = worker => worker.call('ui-doc-state');
        const openEditor = async (worker, roomId) => {
          await worker.call('ui-open', { roomId, surface: 'files' });
          await waitFor(() => state(worker), s => s.entry, 'Editor button is missing'); await click(worker, '[data-editor-open]'); await click(worker, '[data-docs-open]');
          await waitFor(() => state(worker), s => s.editor, 'Documents editor is missing');
        };
        await openEditor(left, created.roomId);
        await waitFor(() => state(left), s => s.page.includes('Место для вашей следующей идеи'), 'Empty documents workspace did not open');
        await left.call('ui-doc-focus-search');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-empty-wide.png'), width: 1552, height: 1050 });
        const emptyLayout = await left.call('ui-doc-layout');
        fs.writeFileSync(path.join(evidenceRoot, 'documents-empty-layout.json'), JSON.stringify(emptyLayout, null, 2));
        assert.ok(emptyLayout.bottomGap <= 2, 'Empty workspace leaves unused modal space: ' + JSON.stringify(emptyLayout));
        assert.ok(emptyLayout.emptyIconOffset <= 2, 'Empty-state icon is not centered');
        assert.equal(emptyLayout.searchFocused, true, 'Documents search did not receive initial focus');
        assert.equal(emptyLayout.searchFocusVisible, true, 'Search focus decoration was not exercised');
        assert.equal(emptyLayout.searchOutline, 'none', 'Search shows a second focus outline inside its border');
        assert.equal(emptyLayout.searchShadow, 'none', 'Search shows an inner focus shadow');
        record('empty-workspace-fills-dialog-with-single-search-border');
        await click(left, '[data-docs-new]');
        await waitFor(() => left.call('ui-control-ready', { selector: '[data-docs-title]' }), Boolean, 'Create form did not open');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-create-wide.png'), width: 1552, height: 1050 });
        const createLayout = await left.call('ui-doc-layout');
        assert.ok(createLayout.bottomGap <= 2, 'Create form leaves unused modal space');
        assert.equal(createLayout.titleOutline, 'none', 'Document title has duplicate focus decoration');
        assert.equal(createLayout.titleShadow, 'none', 'Document title shows an extra focus shadow');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-create-narrow.png'), width: 540, height: 900 });
        assert.deepEqual((await state(left)).overflow, [], 'Narrow create form overflows');
        assert.ok((await left.call('ui-doc-layout')).bottomGap <= 2, 'Narrow create form leaves unused modal space');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-create-returned-wide.png'), width: 1100, height: 900 });
        record('create-form-wide-and-narrow-with-single-field-focus');
        await left.call('ui-doc-input', { selector: '[data-docs-title]', value: 'План команды · Havvn' }); await click(left, '.hd-create button[type=submit]');
        await waitFor(() => state(left), s => s.buffer && s.readOnly === 'false', 'Owner document did not open');
        const catalog = await left.call('docs-view', { roomId: created.roomId }), documentId = catalog.items[0].documentId;
        const source = '# Вместе — быстрее\n\nРабочее пространство нашей команды.\n\n## План на неделю\n\n- [x] Объединить идеи в одном документе\n- [x] Сохранять черновики при потере связи\n- [ ] Подготовить следующую версию Havvn\n\n## Важные решения\n\n> Каждый видит правки и курсоры остальных.\n\n| Задача | Ответственный | Статус |\n| --- | --- | --- |\n| Интерфейс редактора | Команда | Готово |\n| Проверка обновлений | Участники | В работе |\n\n## Заметки\n\n`Ctrl + F` — поиск · `Ctrl + Z` — отмена своей правки\n\n<script>window.__docsExecuted=true</script>\n![remote](https://example.invalid/private-image)\n';
        await left.call('ui-doc-text', { body: source });
        await waitFor(() => state(left), s => s.statusKey === 'rooms.docs.synced' && s.text === source.trimEnd(), 'Owner text was not saved');
        const bufferLayout = await left.call('ui-doc-layout');
        assert.equal(bufferLayout.editorFocusVisible, true, 'Editor text focus decoration was not exercised');
        assert.equal(bufferLayout.editorOutline, 'none', 'Text editor shows an extra inner outline');
        assert.equal(bufferLayout.editorShadow, 'none', 'Text editor shows an extra inner shadow');
        const translations = require('../renderer/i18n/ru.json'), saved = await state(left);
        assert.equal(saved.status, translations['rooms.docs.synced']);
        assert.equal(saved.saveScope, translations['rooms.docs.confirmedHint']);
        record('confirmed-version-does-not-promise-every-peer-delivery');
        await waitFor(() => right.call('docs-view', { roomId: joined.roomId }), v => v.items.some(d => d.documentId === documentId), 'Document did not reach receiver');
        await openEditor(right, joined.roomId); await click(right, `[data-docs-document="${documentId}"]`);
        await waitFor(() => state(right), s => s.text === source.trimEnd(), 'Reader did not get confirmed text');
        // Real native editor input on both profiles, before either half-second autosave.
        await Promise.all([left.call('ui-doc-text', { body: '\nИзменение владельца', append: true }), right.call('ui-doc-text', { body: '\nИзменение участника', append: true })]);
        await waitFor(() => state(left), s => s.text.includes('Изменение владельца') && s.text.includes('Изменение участника') && s.statusKey === 'rooms.docs.synced', 'Concurrent edits failed on owner');
        await waitFor(() => state(right), s => s.text.includes('Изменение владельца') && s.text.includes('Изменение участника') && s.statusKey === 'rooms.docs.synced', 'Concurrent edits failed on writer'); record('concurrent-native-editors');
        await right.call('ui-doc-key', { key: 'z', ctrlKey: true });
        await waitFor(() => state(left), s => s.text.includes('Изменение владельца') && !s.text.includes('Изменение участника'), 'Undo removed a remote edit'); record('own-undo-preserves-remote-edit');
        await click(left, '[data-docs-history]'); await click(left, '[data-docs-snapshot]');
        await waitFor(() => state(left), s => s.snapshots > 0, 'Local snapshot was not saved'); record('local-snapshot');
        await click(left, '.hd-inspector-title button');
        await waitFor(() => state(left), s => s.cursors > 0, 'Remote cursor did not appear'); record('authenticated-cursor');
        await right.call('net-pause'); await right.call('ui-doc-text', { body: '\nОфлайн-черновик', append: true });
        await waitFor(() => state(right), s => s.statusKey === 'rooms.docs.localSaved', 'Offline save is not durable');
        assert.equal((await state(left)).text.includes('Офлайн-черновик'), false); record('offline-draft-not-prematurely-confirmed');
        await stop(right); right = await launch('receiver'); await right.call('restore', { roomId: joined.roomId });
        await waitFor(() => right.call('docs-view', { roomId: joined.roomId }), v => v.items.some(d => d.documentId === documentId), 'Protected document was not restored');
        await openEditor(right, joined.roomId); await click(right, `[data-docs-document="${documentId}"]`);
        await waitFor(() => state(right), s => s.text.includes('Офлайн-черновик'), 'Offline draft was lost after restart');
        await waitFor(() => state(left), s => s.text.includes('Офлайн-черновик'), 'Offline draft did not synchronize after restart'); record('protected-restart-and-reconnect');
        await click(left, '[data-docs-rights]');
        await click(left, '.hd-inspector input[type=checkbox]:checked:not(:disabled)'); await click(left, '[data-docs-policy-save]');
        await waitFor(() => state(right), s => s.readOnly === 'true', 'Revoked writer is still editable'); record('revocation-read-only');
        await left.call('docs-policy', { roomId: created.roomId, documentId, writers: catalog.members.filter(m => m.capable).map(m => m.memberId) });
        await waitFor(() => state(right), s => s.readOnly === 'false', 'Writer permission was not restored');
        // Two disjoint tracker swarms force publisher <-> receiver <-> third.
        // Publisher and third share no tracker and have no direct WebRTC wire.
        let third = await launch('relayed'); const thirdRoom = await third.call('join', { invite: created.invite });
        await waitFor(() => third.call('inspect', { roomId: thirdRoom.roomId }), s => s.members >= 2 && s.owner, 'Relayed room baseline was not established');
        await waitFor(() => third.call('docs-view', { roomId: thirdRoom.roomId }), v => v.items.some(d => d.documentId === documentId), 'Document checkpoint did not traverse relay');
        await waitFor(() => left.call('docs-routes', { roomId: created.roomId }), list => list.some(m => m.name === 'Мария' && m.relayed), 'Third participant unexpectedly has a direct owner connection');
        const relayRoster = await left.call('docs-view', { roomId: created.roomId });
        await left.call('docs-policy', { roomId: created.roomId, documentId, writers: relayRoster.members.filter(m => m.capable).map(m => m.memberId) });
        await openEditor(third, thirdRoom.roomId); await click(third, `[data-docs-document="${documentId}"]`);
        await waitFor(() => state(third), s => s.readOnly === 'false' && s.text.includes('Офлайн-черновик'), 'Relayed writer did not receive edit rights');
        await third.call('ui-doc-text', { body: '\nПравка через посредника', append: true });
        await waitFor(() => state(left), s => s.text.includes('Правка через посредника'), 'Relayed proposal did not reach owner');
        await waitFor(() => state(third), s => s.statusKey === 'rooms.docs.synced', 'Owner confirmation did not traverse relay'); record('three-profiles-forced-relay-without-direct-wire');
        await click(left, '[data-docs-mode=split]'); await click(right, '[data-docs-mode=preview]');
        await waitFor(() => state(left), s => s.preview && s.cursors > 0, 'Markdown preview or cursor missing');
        const safe = await state(left); assert.equal(safe.executed, false); assert.equal(safe.remoteImages, 0); assert.equal(safe.unsafeLinks, 0); record('safe-markdown-preview');
        await click(left, '[data-docs-export]');
        await waitFor(() => state(left), s => s.page.includes('Текст экспортирован'), 'Export did not finish');
        assert.ok(fs.readFileSync(path.join(left.directory, 'document.md'), 'utf8').includes('Офлайн-черновик')); record('native-explicit-export');
        await click(left, '[data-docs-dismiss-notice]');
        await right.call('ui-doc-key', { key: 'Home', ctrlKey: true }); await left.call('ui-doc-key', { key: 'Home', ctrlKey: true });
        await waitFor(() => state(left), s => s.cursorWidgets > 0, 'Remote cursor is missing from the visible CodeMirror text'); record('visible-remote-caret-in-editor');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-wide.png'), width: 1440, height: 960 });
        await right.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-narrow.png'), width: 540, height: 900 });
        assert.ok((await left.call('ui-doc-layout')).bottomGap <= 2, 'Open editor does not fill the wide dialog');
        assert.ok((await right.call('ui-doc-layout')).bottomGap <= 2, 'Open editor does not fill the narrow dialog');
        const layout = await state(right); assert.deepEqual(layout.overflow, [], 'Narrow editor has overflowing controls'); assert.equal(layout.sidebarVisible, false, 'Sidebar obscures the narrow editor'); record('wide-and-narrow-layouts');
        const storage = fs.readdirSync(path.join(right.directory, 'profile/room-documents'), { recursive: true }).filter(f => f.endsWith('.json')).map(f => fs.readFileSync(path.join(right.directory, 'profile/room-documents', f), 'utf8')).join('');
        assert.equal(storage.includes('Офлайн-черновик'), false); assert.ok(storage.includes('enc:v1:')); record('os-protected-document-storage');
        const successor = (await right.call('docs-view', { roomId: joined.roomId })).selfId;
        const thirdId = (await third.call('docs-view', { roomId: thirdRoom.roomId })).selfId;
        await third.call('net-pause'); await third.call('ui-doc-text', { body: '\nЛичный черновик перед передачей', append: true });
        await waitFor(() => state(third), s => s.statusKey === 'rooms.docs.localSaved', 'Private pre-transfer draft did not persist'); await stop(third);
        // Lose only the successor's document records; signed room transfer messages
        // continue over the real WebRTC wires. This makes the recovery UI observable.
        await right.call('docs-hold-records', { enabled: true });
        await left.call('docs-transfer-owner', { roomId: created.roomId, memberId: successor });
        await waitFor(() => left.call('docs-inspect', { roomId: created.roomId, documentId }), d => d.ownerId === successor && d.recovering, 'Previous owner did not retain a readable recovery copy');
        await waitFor(() => state(left), s => s.recovering && s.readOnly === 'true', 'Open editor did not enter recovery mode');
        const recovery = await left.call('docs-inspect', { roomId: created.roomId, documentId });
        assert.ok(recovery.snapshots.length > 0); assert.ok(recovery.text.includes('Правка через посредника')); assert.equal(recovery.text.includes('Личный черновик перед передачей'), false);
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-recovery-wide.png'), width: 1440, height: 960 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-recovery-narrow.png'), width: 540, height: 900 });
        assert.deepEqual((await state(left)).overflow, []); record('owner-transfer-with-durable-handoff-and-readable-recovery');
        await right.call('docs-hold-records', { enabled: false });
        await waitFor(() => state(left), s => !s.recovering && s.readOnly === 'false' && !s.errors.length, 'Open editor token did not survive owner transfer');
        third = await launch('relayed'); await third.call('restore', { roomId: thirdRoom.roomId });
        await waitFor(() => third.call('docs-view', { roomId: thirdRoom.roomId }), v => v.ownerId === successor && v.items.some(d => d.documentId === documentId && !d.recovering), 'Offline participant did not migrate after restart');
        await openEditor(third, thirdRoom.roomId); await click(third, `[data-docs-document="${documentId}"]`);
        await waitFor(() => state(third), s => s.review && s.text.includes('Личный черновик перед передачей'), 'Private draft was lost or published during transfer');
        const privateText = (await state(third)).text;
        assert.equal((await state(right)).text.includes('Личный черновик перед передачей'), false);
        await third.call('ui-capture', { destination: path.join(evidenceRoot, 'documents-draft-review.png'), width: 1440, height: 960 });
        await click(third, '[data-docs-apply-draft]'); await click(third, '.um-backdrop-top .btn-primary');
        await waitFor(() => state(third), s => !s.review && s.statusKey === 'rooms.docs.synced' && s.text === privateText, 'Private draft review did not synchronize exactly once');
        await waitFor(() => state(right), s => s.text === privateText, 'New owner did not receive explicitly applied draft'); record('offline-private-draft-restart-and-explicit-review-after-transfer');
        await right.call('docs-kick', { roomId: joined.roomId, memberId: thirdId });
        await waitFor(() => right.call('docs-inspect', { roomId: joined.roomId, documentId }), d => !d.writers.includes(thirdId), 'Rekey restored banned edit access');
        await waitFor(() => state(left), s => !s.recovering && s.text.includes('Личный черновик перед передачей') && !s.errors.length, 'Live editor did not survive secret rotation');
        await stop(third); record('rekey-keeps-document-and-removes-banned-writer');
        await stop(left); await stop(right);
        right = await launch('receiver'); await right.call('restore', { roomId: joined.roomId });
        left = await launch('publisher'); await left.call('restore', { roomId: created.roomId });
        for (const [worker, roomId] of [[left, created.roomId], [right, joined.roomId]]) {
          await waitFor(() => worker.call('docs-view', { roomId }), v => v.items.some(d => d.documentId === documentId && !d.recovering), 'Migrated document did not survive full restart');
          await openEditor(worker, roomId); await click(worker, `[data-docs-document="${documentId}"]`);
          await waitFor(() => state(worker), s => s.text.includes('Личный черновик перед передачей') && !s.errors.length, 'Migrated text is missing after full restart');
        }
        assert.equal((await left.call('docs-inspect', { roomId: created.roomId, documentId })).snapshots.length > 0, true);
        record('owner-transfer-and-rekey-full-protected-restart-with-local-history');
        await right.call('ui-doc-text', { body: '\nПоследняя правка перед переходом', append: true });
        await right.call('ui-page-leave');
        await waitFor(() => state(right), s => !s.editor, 'Page navigation did not finish after saving the document');
        assert.equal((await right.call('docs-inspect', { roomId: joined.roomId, documentId })).text.includes('Последняя правка перед переходом'), true);
        record('page-navigation-flushes-the-last-edit-before-closing-its-token');
        passed = true; evidence.passed = true; evidence.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(evidenceRoot, 'documents-acceptance.json'), JSON.stringify(evidence, null, 2));
        console.log('Collaborative editor passed: three native profiles, forced relay, concurrent edits, cursors, offline restart, owner handoff, read-only recovery, private draft review, rekey, local history, safe export and responsive screenshots. One physical PC.'); return;
      }
      const one = 'first encrypted room configuration\n'.repeat(2048);
      if (ui) {
        await left.call('edit', { body: one }); await left.call('ui-open', { roomId: created.roomId });
        await waitFor(() => left.call('ui-state'), state => state.ready, 'Source UI did not open');
        await left.call('ui-click', { target: 'create' });
        await waitFor(() => left.call('ui-state'), state => state.preview && !state.busy && state.text.includes('config.ini'), 'Source preview missing');
        assert.equal((await left.call('ui-state')).connectMode, 'send', 'New source must explain sending before confirmation');
        await left.call('ui-mode-preview', { value: 'manual' });
        await left.call('ui-click', { target: 'confirm' });
      }
      const rootId = ui ? (await waitFor(() => left.call('roots', { roomId: created.roomId }), roots => roots.length === 1, 'UI root not created'))[0].rootId
        : await left.call('create-root', { roomId: created.roomId });
      await waitFor(() => right.call('roots', { roomId: joined.roomId }), roots => roots.some(root => root.rootId === rootId), 'Root metadata not delivered');
      const roots = await right.call('roots', { roomId: joined.roomId });
      assert.equal(roots[0].binding, null, 'Remote metadata must not grant a local binding');
      let previousRevision = '';
      const publish = async body => {
        if (!ui) return left.call('publish', { roomId: created.roomId, rootId, body });
        await left.call('edit-atomic', { body });
        if (!previousRevision) {
          await waitFor(() => left.call('ui-state'), state => state.switches > 0 && !state.busy, 'Publisher automatic mode not rendered');
          await left.call('ui-click', { target: 'toggle' });
        }
        const page = await waitFor(() => left.call('sync-files', { roomId: created.roomId, rootId }), page => page.items.some(file => file.path === 'config.ini' && file.revisionId !== previousRevision), 'Automatic publication failed');
        previousRevision = page.items.find(file => file.path === 'config.ini').revisionId; return previousRevision;
      };
      await publish(one);
      assert.equal(await right.call('read'), null, 'No implicit write before consent');
      if (ui) {
        await right.call('ui-open', { roomId: joined.roomId });
        await waitFor(() => right.call('ui-state'), state => state.ready && state.roots === 1, 'Receiver UI did not open');
        await right.call('ui-click', { target: 'bind' });
        await waitFor(() => right.call('ui-state'), state => state.preview && !state.busy && state.text.includes('config.ini'), 'Receiver preview missing');
        assert.equal((await right.call('ui-state')).connectMode, 'receive', 'Read-only receiver must offer receiving, not publication');
        await right.call('ui-mode-preview', { value: 'manual' });
        await right.call('ui-click', { target: 'confirm' });
        await waitFor(() => right.call('ui-state'), state => state.switches === 1, 'Receiver binding missing');
        assert.equal(await right.call('read'), null, 'Connecting alone must not enable application');
        await right.call('ui-click', { target: 'toggle' });
      } else await right.call('bind', { roomId: joined.roomId, rootId });
      await waitFor(() => right.call('read'), value => value === one, 'First file version not applied');
      if (trashStorage) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-click', { target: 'rights' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Разрешить удаление с корзиной') && !state.busy, 'Deletion opt-in missing');
        await left.call('ui-deletes-enable'); await left.call('ui-click', { target: 'rights-review' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Выбор проверен') && !state.busy, 'Rights review missing');
        await left.call('ui-click', { target: 'rights-confirm' });
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 6, 'v6 policy not delivered');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        await left.call('publish-path', { roomId: created.roomId, rootId, relativePath: 'second.ini', body: 'shared second file' });
        await waitFor(() => right.call('read-path', { relativePath: 'second.ini' }), value => value === 'shared second file', 'Second file missing');
        const rows = (await left.call('sync-files', { roomId: created.roomId, rootId })).items, first = rows.find(r => r.path === 'config.ini'), second = rows.find(r => r.path === 'second.ini');
        await right.call('write-path', { relativePath: 'second.ini', body: 'unpublished local bytes' });
        for (const row of [first, second]) {
          const preview = await left.call('delete-preview', { roomId: created.roomId, rootId, entryId: row.entryId });
          await left.call('delete-confirm', { roomId: created.roomId, rootId, previewId: preview.previewId });
        }
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId, trash: true }), page => page.items.length === 2, 'Tombstones missing');
        await waitFor(() => right.call('read'), value => value === null, 'First file was not moved to trash');
        const resolve = await right.call('delete-preview', { roomId: joined.roomId, rootId, entryId: second.entryId, resolve: true });
        await right.call('delete-confirm', { roomId: joined.roomId, rootId, previewId: resolve.previewId });
        assert.deepEqual((await right.call('trash-bytes')).sort(), [one, 'unpublished local bytes'].sort());
        const before = await right.call('checkpoint-state', { roomId: joined.roomId, rootId });
        await right.call('ui-open', { roomId: joined.roomId, surface: 'files' });
        await waitFor(() => right.call('ui-state'), state => state.libraryTrash, 'Shared-files trash entry missing');
        await right.call('ui-click', { target: 'library-trash' });
        await waitFor(() => right.call('ui-state'), state => state.trashStorageButton, 'Trash storage entry missing');
        await right.call('ui-click', { target: 'library-trash-storage' });
        await waitFor(() => right.call('ui-state'), state => state.trashStorageRows === 2 && !state.busy, 'Local trash inventory missing');
        assert.equal((await right.call('ui-state')).trashStorageEligible, 1, 'Unpublished local bytes were eligible for cleanup');
        assert.equal((await right.call('ui-state')).trashStorageConfirmDisabled, true, 'Cleanup allowed without review');
        await right.call('ui-click', { target: 'trash-storage-select' });
        assert.equal((await right.call('ui-state')).trashStorageConfirmDisabled, true, 'Selection bypassed review');
        await right.call('ui-click', { target: 'trash-storage-review' });
        await waitFor(() => right.call('ui-state'), state => state.trashStorageConfirmDisabled === false && !state.busy, 'Cleanup review missing');
        await right.call('ui-theme');
        for (const [name, width, height] of [['wide', 1100, 900], ['narrow', 520, 820]]) {
          await right.call('ui-capture', { destination: path.join(evidenceRoot, 'trash-storage-' + name + '.png'), width, height });
          assert.equal((await right.call('ui-layout')).overflow.length, 0, 'Trash storage dialog overflows');
        }
        await right.call('ui-click', { target: 'trash-storage-confirm' });
        await waitFor(() => right.call('ui-state'), state => state.trashStorageRows === 1 && state.text.includes('Удалено копий: 1') && !state.busy, 'Cleanup result missing');
        assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']);
        const after = await right.call('checkpoint-state', { roomId: joined.roomId, rootId }); assert.equal(after.records, before.records); assert.equal(after.heads, before.heads);
        await right.call('cache-zero', { roomId: joined.roomId, rootId });
        await stop(right); right = await launch('receiver'); await right.call('restore');
        assert.equal(await right.call('read'), null, 'Pruned receipt recreated deleted working file');
        assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']);
        const history = await right.call('history', { roomId: joined.roomId, rootId, entryId: first.entryId });
        assert.equal(history.items.find(row => row.revisionId === first.revisionId)?.local, true, 'Verified recovery content lost after cleanup');
        const restore = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: first.revisionId });
        await left.call('restore-confirm', { roomId: created.roomId, rootId, previewId: restore.previewId });
        await waitFor(() => right.call('read'), body => body === one, 'Restoration after trash cleanup failed');
        record('verified-cache-cleanup-and-zero-cache-restart');
        const openStorage = async () => {
          await right.call('ui-open', { roomId: joined.roomId, surface: 'files' });
          await waitFor(() => right.call('ui-state'), s => s.libraryTrash, 'Trash entry missing after restart');
          await right.call('ui-click', { target: 'library-trash' });
          await waitFor(() => right.call('ui-state'), s => s.trashStorageButton, 'Trash storage entry missing');
          await right.call('ui-click', { target: 'library-trash-storage' });
          await waitFor(() => right.call('ui-state'), s => s.trashStorageRows === 1 && !s.busy, 'Unique copy missing');
        };
        await openStorage(); assert.equal((await right.call('ui-state')).trashStorageEligible, 0);
        await right.call('save-cancel-once'); await right.call('ui-click', { target: 'trash-export' });
        await waitFor(() => right.call('ui-state'), s => !s.busy, 'Canceled picker did not settle');
        assert.equal(fs.existsSync(path.join(right.directory, 'trash-copy-1.ini')), false); assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']); record('cancel-keeps-protected-original');
        await right.call('ui-click', { target: 'trash-export' });
        await waitFor(() => right.call('ui-state'), s => s.trashStorageEligible === 1 && s.text.includes('Копия сохранена и проверена') && !s.busy, 'Unique export was not verified');
        assert.equal(fs.readFileSync(path.join(right.directory, 'trash-copy-1.ini'), 'utf8'), 'unpublished local bytes');
        assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']); assert.equal((await right.call('ui-state')).trashStorageConfirmDisabled, true); record('binary-exact-export-without-automatic-cleanup');
        for (const [name, width, height] of [['wide', 1100, 900], ['narrow', 520, 820]]) {
          await right.call('ui-capture', { destination: path.join(evidenceRoot, 'trash-export-' + name + '.png'), width, height });
          assert.equal((await right.call('ui-layout')).overflow.length, 0, 'Trash export dialog overflows');
        }
        await stop(right); right = await launch('receiver'); await right.call('restore'); await openStorage();
        assert.equal((await right.call('ui-state')).trashStorageEligible, 1); record('protected-export-receipt-survives-restart');
        fs.writeFileSync(path.join(right.directory, 'trash-copy-1.ini'), 'changed exported copy');
        await right.call('ui-click', { target: 'trash-storage-refresh' }); await waitFor(() => right.call('ui-state'), s => s.trashStorageEligible === 0 && !s.busy, 'Modified export still authorizes cleanup');
        await right.call('ui-click', { target: 'trash-export' });
        await waitFor(() => right.call('ui-state'), s => s.text.includes('Этот файл уже существует') && !s.busy, 'Existing export was overwritten');
        assert.equal(fs.readFileSync(path.join(right.directory, 'trash-copy-1.ini'), 'utf8'), 'changed exported copy'); assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']); record('changed-export-and-no-overwrite-protect-original');
        await right.call('ui-click', { target: 'trash-storage-refresh' }); await waitFor(() => right.call('ui-state'), s => !s.busy, 'Refresh did not settle');
        await right.call('trash-export-fresh-name'); await right.call('ui-click', { target: 'trash-export' });
        await waitFor(() => right.call('ui-state'), s => s.trashStorageEligible === 1 && !s.busy, 'Fresh export did not re-enable review');
        await right.call('ui-click', { target: 'trash-storage-select' }); await right.call('ui-click', { target: 'trash-storage-review' });
        await waitFor(() => right.call('ui-state'), s => !s.trashStorageConfirmDisabled && !s.busy, 'Export cleanup review missing');
        fs.unlinkSync(path.join(right.directory, 'trash-copy-2.ini'));
        await right.call('ui-click', { target: 'trash-storage-confirm' });
        await waitFor(() => right.call('ui-state'), s => s.text.includes('Корзина или копия для восстановления изменились') && !s.busy, 'Lost export was not detected before cleanup');
        assert.deepEqual(await right.call('trash-bytes'), ['unpublished local bytes']); record('lost-export-invalidates-reviewed-cleanup');
        await right.call('ui-click', { target: 'trash-storage-refresh' }); await waitFor(() => right.call('ui-state'), s => !s.busy, 'Refresh did not settle');
        await right.call('trash-export-fresh-name'); await right.call('ui-click', { target: 'trash-export' });
        await waitFor(() => right.call('ui-state'), s => s.trashStorageEligible === 1 && !s.busy, 'Final export did not verify');
        await right.call('ui-click', { target: 'trash-storage-select' }); await right.call('ui-click', { target: 'trash-storage-review' });
        await waitFor(() => right.call('ui-state'), s => !s.trashStorageConfirmDisabled && !s.busy, 'Final cleanup review missing');
        await right.call('ui-click', { target: 'trash-storage-confirm' });
        await waitFor(() => right.call('ui-state'), s => s.trashStorageRows === 0 && !s.busy, 'Explicit cleanup did not remove unique trash payload');
        assert.equal(fs.readFileSync(path.join(right.directory, 'trash-copy-3.ini'), 'utf8'), 'unpublished local bytes');
        await stop(right); right = await launch('receiver'); await right.call('restore');
        assert.deepEqual(await right.call('trash-bytes'), []); assert.equal(await right.call('read-path', { relativePath: 'second.ini' }), null); record('explicit-unique-cleanup-does-not-delete-export-or-resurrect-file');
        evidence.passed = true; evidence.nativePickerStubbed = true; evidence.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(evidenceRoot, 'trash-export-acceptance.json'), JSON.stringify(evidence, null, 2));
        console.log('Trash storage and export passed: two native profiles, E2E WebRTC, unique local bytes, canceled picker, exact export, no overwrite or automatic cleanup, durable receipt, tamper/lost-copy protection, explicit cleanup, restart and two UI sizes. One physical PC.');
        passed = true; return;
      }
      if (missing) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-click', { target: 'rights' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Разрешить удаление с корзиной') && !state.busy, 'Deletion opt-in missing');
        await left.call('ui-deletes-enable'); await left.call('ui-click', { target: 'rights-review' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Выбор проверен') && !state.busy, 'Deletion rights review missing');
        await left.call('ui-click', { target: 'rights-confirm' });
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 6, 'v6 not delivered');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        for (const relativePath of ['keep.ini', 'second.ini']) await left.call('publish-path', { roomId: created.roomId, rootId, relativePath, body: relativePath });
        await waitFor(() => right.call('read-path', { relativePath: 'second.ini' }), value => value === 'second.ini', 'Second file not delivered');
        const initial = (await left.call('sync-files', { roomId: created.roomId, rootId })).items.find(row => row.path === 'config.ini');
        await left.call('ui-open', { roomId: created.roomId, surface: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRoots === 1 && state.missingButton, 'Disk deletions control missing from shared files');
        await left.call('unlink-path', { relativePath: 'config.ini' }); await left.call('unlink-path', { relativePath: 'second.ini' });
        assert.equal(await right.call('read'), one, 'External deletion was sent without review');
        await left.call('ui-click', { target: 'library-missing' });
        await waitFor(() => left.call('ui-state'), state => state.missingRows === 2 && !state.busy, 'Confirmed disk deletion list missing');
        assert.equal((await left.call('ui-state')).missingReviewDisabled, true, 'Mass deletion review allowed without acknowledgement');
        await left.call('ui-theme');
        for (const [name, width, height] of [['wide', 1100, 900], ['narrow', 520, 820]]) {
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'missing-' + name + '.png'), width, height });
          assert.equal((await left.call('ui-layout')).overflow.length, 0, 'Missing-files dialog overflows');
        }
        await left.call('ui-click', { target: 'missing-ack' }); await left.call('ui-click', { target: 'missing-review' });
        await waitFor(() => left.call('ui-state'), state => state.deleteReview && state.text.includes('защищённом кеше') && !state.busy, 'External deletion confirmation missing');
        // A late external save must invalidate the one-use confirmation.
        await left.call('edit', { body: 'late local save' }); await left.call('ui-click', { target: 'delete-confirm' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('проверьте его заново') && !state.busy, 'Late save did not invalidate confirmation');
        assert.equal(await right.call('read'), one, 'Stale confirmation deleted peer file');
        await left.call('ui-open', { roomId: created.roomId, surface: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.missingButton, 'Missing-files entry not reopened');
        await left.call('unlink-path', { relativePath: 'config.ini' }); await left.call('ui-click', { target: 'library-missing' });
        await waitFor(() => left.call('ui-state'), state => state.missingRows === 2 && !state.busy, 'Deletion review did not recover');
        await left.call('ui-click', { target: 'missing-ack' }); await left.call('ui-click', { target: 'missing-review' });
        await waitFor(() => left.call('ui-state'), state => state.deleteReview && !state.busy, 'Second confirmation missing');
        await left.call('ui-click', { target: 'delete-confirm' });
        await waitFor(() => right.call('read'), body => body === null, 'Reviewed deletion was not applied');
        assert.equal(await right.call('read-path', { relativePath: 'second.ini' }), 'second.ini', 'Unselected deletion was sent');
        assert.deepEqual(await right.call('trash-bytes'), [one]);
        await left.call('cache-zero', { roomId: created.roomId, rootId });
        await stop(left); left = await launch('publisher'); await left.call('restore');
        const history = await left.call('history', { roomId: created.roomId, rootId, entryId: initial.entryId });
        assert.equal(history.items.find(row => row.revisionId === initial.revisionId)?.local, true, 'Recovery content lost across zero cache/restart');
        const restore = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: initial.revisionId });
        await left.call('restore-confirm', { roomId: created.roomId, rootId, previewId: restore.previewId });
        await waitFor(() => right.call('read'), body => body === one, 'Old content not restored after restart');
        await left.call('unlink-path', { relativePath: 'config.ini' }); await left.call('unlink-path', { relativePath: 'keep.ini' });
        assert.equal((await left.call('missing', { roomId: created.roomId, rootId })).blocked, 'all', 'All-file disappearance was not blocked');
        console.log('Disk deletion review passed: repeated scans, shared-files entry, mass gate, late-save rejection, one-file E2E deletion, peer trash, zero-cache restart and restore, all-file loss block, two UI sizes. One PC, isolated profiles.');
        passed = true; return;
      }
      if (metadata) {
        const initial = (await left.call('sync-files', { roomId: created.roomId, rootId })).items[0], password = 'fixture metadata password 123';
        let body = one;
        for (let n = 0; n < 3; n++) {
          if (n) { body = 'Metadata archive version ' + n; await left.call('publish', { roomId: created.roomId, rootId, body }); await waitFor(() => right.call('read'), value => value === body, 'History fixture contents not delivered'); }
          await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.pending === 0, 'History fixture announcements not acknowledged before checkpoint');
          const cp = await left.call('checkpoint-preview', { roomId: created.roomId, rootId }); await left.call('checkpoint-confirm', { roomId: created.roomId, previewId: cp.previewId });
          await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.archives === n + 1, 'History epoch not received');
          await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
          await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.pending === 0, 'Signed announcements not acknowledged');
        }
        await waitFor(async () => { await left.call('cache-zero', { roomId: created.roomId, rootId }); return left.call('checkpoint-state', { roomId: created.roomId, rootId }); }, state => state.sources <= 1, 'Old content is still being seeded');
        await left.call('ui-open', { roomId: created.roomId }); await waitFor(() => left.call('ui-state'), state => state.ready && !state.busy, 'Archive settings missing');
        await left.call('ui-click', { target: 'metadata' }); await waitFor(() => left.call('ui-state'), state => state.metadataRows === 3 && !state.busy, 'Archive inventory missing');
        await left.call('ui-metadata-fields', { keep: '0' }); await left.call('ui-click', { target: 'metadata-review' });
        await waitFor(() => left.call('ui-state'), state => state.metadataRemove === 3 && !state.busy, 'Old epochs not selected');
        assert.equal((await left.call('ui-state')).metadataConfirmDisabled, true, 'Cleanup allowed before export');
        await left.call('ui-metadata-fields', { password }); await left.call('ui-click', { target: 'metadata-export' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Зашифрованный журнал сохранён') && state.metadataConfirmDisabled === false && !state.busy, 'Encrypted export missing');
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-theme');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'metadata-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'metadata-narrow.png'), width: 520, height: 820 });
        assert.deepEqual((await left.call('ui-layout')).overflow, []);
        const exportInfo = await left.call('metadata-export-inspect', { password }); assert.equal(exportInfo.format, 'havvn-file-sync-history'); assert.equal(exportInfo.plainNames, false); assert.equal(exportInfo.localPaths, false);
        await left.call('ui-click', { target: 'metadata-confirm' });
        await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.archives === 0, 'Old epochs not removed');
        assert.equal(await left.call('read'), body); assert.equal(await right.call('read'), body);
        assert.equal((await left.call('history', { roomId: created.roomId, rootId, entryId: initial.entryId })).items.some(item => item.revisionId === initial.revisionId), false);
        await stop(left); left = await launch('publisher'); await left.call('restore');
        await left.call('ui-open', { roomId: created.roomId }); await waitFor(() => left.call('ui-state'), state => state.ready && !state.busy, 'Restarted archive settings missing');
        await left.call('ui-click', { target: 'metadata' }); await waitFor(() => left.call('ui-state'), state => state.text.includes('Старых архивных эпох пока нет') && !state.busy, 'Cleanup not durable');
        await left.call('ui-metadata-fields', { password: 'a wrong fixture password' }); await left.call('ui-click', { target: 'metadata-import' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Неверный пароль') && !state.busy, 'Wrong password not rejected');
        await left.call('ui-metadata-fields', { password }); await left.call('ui-click', { target: 'metadata-import' });
        await waitFor(() => left.call('ui-state'), state => state.metadataRows === 3 && state.text.includes('История загружена') && !state.busy, 'Exported history not imported');
        assert.equal(await left.call('read'), body, 'Import changed working contents');
        const history = await left.call('history', { roomId: created.roomId, rootId, entryId: initial.entryId }); assert.ok(history.items.some(item => item.revisionId === initial.revisionId));
        const restore = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: initial.revisionId });
        await left.call('restore-confirm', { roomId: created.roomId, previewId: restore.previewId });
        await waitFor(() => right.call('read'), value => value === one, 'Imported history content not restored through the peer');
        assert.equal(await left.call('read'), one);
        passed = true; console.log('Metadata archives passed: encrypted native export, verified cleanup preview, export prerequisite, durable retention, wrong-password rejection, import without changing heads, old-content restore from peer, E2E WebRTC and two UI sizes. One PC, isolated profiles.'); return;
      }
      if (paths) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        const rights = await left.call('rights', { roomId: created.roomId, rootId });
        const selected = rights.candidates.filter(member => member.moves).map(member => member.memberId); assert.equal(selected.length, 2);
        const grant = await left.call('rights', { roomId: created.roomId, rootId, writers: selected, moves: true });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: grant.previewId });
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.publisher && state.roots[0]?.moves, 'Path resolution rights missing');
        await left.call('net-pause');
        const peerBody = 'Independent peer contents\n', ownerBody = 'Independent owner contents\n';
        const peerRevision = await right.call('publish-path', { roomId: joined.roomId, rootId, relativePath: 'collision.ini', body: peerBody });
        const peerEntry = (await right.call('sync-files', { roomId: joined.roomId, rootId })).items.find(file => file.revisionId === peerRevision).entryId;
        await right.call('net-pause'); await left.call('net-resume');
        await waitFor(() => left.call('sync-view', { roomId: created.roomId }), state => state.roots[0]?.publisher, 'Owner did not resume');
        await left.call('publish-path', { roomId: created.roomId, rootId, relativePath: 'collision.ini', body: ownerBody });
        await right.call('net-resume');
        await waitFor(() => left.call('sync-files', { roomId: created.roomId, rootId }), page => page.items.filter(file => file.path === 'collision.ini' && file.pathResolvable).length === 2, 'Independent name collision not detected');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.filter(file => file.path === 'collision.ini' && file.pathResolvable).length === 2, 'Peer did not detect collision');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        await left.call('ui-open', { roomId: created.roomId, surface: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRoots === 1, 'Shared files surface missing');
        await left.call('ui-click', { target: 'library-expand' });
        await waitFor(() => left.call('ui-state'), state => state.pathButtons === 2, 'Direct path resolution controls missing');
        await left.call('ui-path-open', { entryId: peerEntry });
        await waitFor(() => left.call('ui-state'), state => state.pathVersions === 1 && !state.busy, 'Version chooser missing');
        assert.equal((await left.call('ui-state')).pathConfirmDisabled, true);
        await left.call('ui-path-name', { value: 'copies/peer.ini' }); await left.call('ui-click', { target: 'path-review' });
        await waitFor(() => left.call('ui-state'), state => state.pathConfirmDisabled === false && !state.busy, 'Path preview missing');
        await left.call('ui-theme');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'paths-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'paths-narrow.png'), width: 520, height: 820 });
        const layout = await left.call('ui-layout'); assert.deepEqual(layout.overflow, []); assert.deepEqual(layout.smallButtons, []);
        await left.call('write-path', { relativePath: 'copies/peer.ini', body: 'Unshared file created after review' });
        await left.call('ui-click', { target: 'path-confirm' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Этот путь уже занят') && !state.busy, 'Stale destination did not block confirmation');
        assert.equal(await left.call('read-path', { relativePath: 'copies/peer.ini' }), 'Unshared file created after review');
        await left.call('ui-path-name', { value: 'copies/peer-safe.ini' }); await left.call('ui-click', { target: 'path-review' });
        await waitFor(() => left.call('ui-state'), state => state.pathConfirmDisabled === false && !state.busy, 'Second path review missing');
        await left.call('ui-click', { target: 'path-confirm' });
        await waitFor(() => left.call('read-path', { relativePath: 'copies/peer-safe.ini' }), body => body === peerBody, 'Selected peer content not materialized');
        await waitFor(() => right.call('read-path', { relativePath: 'copies/peer-safe.ini' }), body => body === peerBody, 'Encrypted resolution not delivered');
        assert.equal(await left.call('read-path', { relativePath: 'collision.ini' }), ownerBody);
        assert.equal(await right.call('read-path', { relativePath: 'collision.ini' }), peerBody, 'Peer original bytes lost');
        const peerFiles = await right.call('sync-files', { roomId: joined.roomId, rootId });
        assert.equal(peerFiles.items.find(file => file.path === 'collision.ini').status, 'deferred');
        await right.call('ui-open', { roomId: joined.roomId }); await waitFor(() => right.call('ui-state'), state => state.ready && !state.busy, 'Peer settings missing');
        await right.call('ui-click', { target: 'files' });
        await waitFor(() => right.call('ui-state'), state => state.text.includes('Обновление отложено'), 'Preserved source review missing');
        await right.call('ui-click', { target: 'review-conflict' });
        await waitFor(() => right.call('ui-state'), state => state.diffRows > 0 && !state.busy, 'Other document comparison missing');
        await right.call('ui-click', { target: 'keep-conflict' });
        await waitFor(() => right.call('read-path', { relativePath: 'collision.ini' }), body => body === ownerBody, 'Other document not applied after review');
        assert.ok((await right.call('local-copies', { name: 'collision.ini' })).includes(peerBody), 'Keep both did not retain original source');
        const history = await left.call('history', { roomId: created.roomId, rootId, entryId: peerEntry }); assert.equal(history.items.length, 2); assert.ok(history.items.some(item => item.revisionId === peerRevision));
        await stop(right); right = await launch('receiver'); await right.call('restore');
        assert.equal(await right.call('read-path', { relativePath: 'copies/peer-safe.ini' }), peerBody); assert.equal(await right.call('read-path', { relativePath: 'collision.ini' }), ownerBody);
        passed = true; console.log('Path conflicts passed: independent offline documents, direct shared-files chooser, authenticated encrypted contents, occupied destination race, preserved originals, reviewed keep-both, stable history, receiver restart and two UI sizes. One PC, isolated profiles.'); return;
      }
      if (deletes) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        const entryId = (await left.call('sync-files', { roomId: created.roomId, rootId })).items[0].entryId;
        await left.call('ui-click', { target: 'rights' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Разрешить удаление с корзиной') && !state.busy, 'Deletion opt-in missing');
        await left.call('ui-deletes-enable'); await left.call('ui-click', { target: 'rights-review' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Выбор проверен') && !state.busy, 'Deletion opt-in review missing');
        await left.call('ui-click', { target: 'rights-confirm' });
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 6, 'Deletion policy did not reach receiver');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        await left.call('ui-open', { roomId: created.roomId, surface: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRoots === 1, 'Deletion shared-files entry missing');
        await left.call('ui-click', { target: 'library-expand' });
        await waitFor(() => left.call('ui-state'), state => state.deleteButtons === 1, 'Direct deletion control missing');
        await left.call('ui-click', { target: 'delete' });
        await waitFor(() => left.call('ui-state'), state => state.deleteReview && !state.busy, 'Deletion preview missing');
        await left.call('ui-theme');
        for (const [name, width, height] of [['wide', 1100, 900], ['narrow', 520, 820]]) {
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'delete-' + name + '.png'), width, height });
          assert.equal((await left.call('ui-layout')).overflow.length, 0, 'Deletion dialog overflows');
        }
        await right.call('lock-file'); await left.call('ui-click', { target: 'delete-confirm' });
        const deleted = (await waitFor(() => left.call('sync-files', { roomId: created.roomId, rootId, trash: true }), page => page.items.some(f => f.deleted), 'Tombstone missing from trash')).items[0].revisionId;
        await waitFor(() => right.call('inspect', { roomId: joined.roomId, rootId }), state => state.retries.includes(rootId + ':' + deleted), 'Locked deletion did not pause');
        assert.equal(await right.call('read'), one, 'Locked working bytes were changed');
        await right.call('unlock-file'); await right.call('rescan', { roomId: joined.roomId, rootId });
        await waitFor(() => right.call('read'), body => body === null, 'Deletion did not resume after unlocking');
        assert.deepEqual(await right.call('trash-bytes'), [one]);
        await left.call('ui-click', { target: 'settings-close' });
        await waitFor(() => left.call('ui-state'), state => state.libraryTrash, 'Shared-files trash control missing');
        await left.call('ui-click', { target: 'library-trash' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRows === 1 && state.text.includes('Удалён'), 'Trash contents missing');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'trash-library.png'), width: 1000, height: 820 });
        await left.call('ui-click', { target: 'history' });
        await waitFor(() => left.call('ui-state'), state => state.historyRows === 2 && !state.busy, 'Trash history missing');
        await left.call('ui-click', { target: 'restore-version' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Восстановление версии') && !state.busy, 'Trash restore review missing');
        await left.call('ui-click', { target: 'restore-confirm' });
        await waitFor(() => right.call('read'), body => body === one, 'Trash restore did not publish and apply a new version');
        await right.call('edit', { body: 'Independent edit survives shared deletion' });
        const review = await left.call('delete-preview', { roomId: created.roomId, rootId, entryId });
        await left.call('delete-confirm', { roomId: created.roomId, previewId: review.previewId });
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(f => f.deleted && f.resolvable && f.status === 'conflict'), 'Edited receiver deletion conflict missing');
        assert.equal(await right.call('read'), 'Independent edit survives shared deletion');
        await right.call('ui-open', { roomId: joined.roomId });
        await waitFor(() => right.call('ui-state'), state => state.ready && !state.busy, 'Deletion conflict UI missing');
        await right.call('ui-click', { target: 'files' });
        await waitFor(() => right.call('ui-state'), state => state.conflicts === 1 && !state.busy, 'Deletion conflict row missing');
        await right.call('ui-click', { target: 'review-conflict' });
        await waitFor(() => right.call('ui-state'), state => state.deleteReview && !state.busy, 'Deletion conflict review missing');
        await right.call('ui-capture', { destination: path.join(evidenceRoot, 'delete-conflict.png'), width: 900, height: 820 });
        await right.call('ui-click', { target: 'delete-keep' });
        await waitFor(() => right.call('read'), body => body === null, 'Reviewed deletion did not finish');
        assert.ok((await right.call('local-copies')).includes('Independent edit survives shared deletion'));
        assert.ok((await right.call('trash-bytes')).includes('Independent edit survives shared deletion'));
        await stop(right); right = await launch('receiver'); await right.call('restore');
        await waitFor(() => right.call('inspect', { roomId: joined.roomId }), state => state.owner && state.members >= 2, 'Restarted deletion profile did not reconnect');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId, trash: true }), page => page.items.some(f => f.revisionId !== deleted && f.status === 'deleted'), 'Deletion receipt did not survive restart');
        assert.equal(await right.call('read'), null);
        const cache = await left.call('cache-zero', { roomId: created.roomId, rootId }); assert.ok(cache.protectedBytes > 0);
        const firstId = (await left.call('history', { roomId: created.roomId, rootId, entryId })).items.at(-1).revisionId;
        const restore = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: firstId });
        await left.call('restore-confirm', { roomId: created.roomId, previewId: restore.previewId });
        await waitFor(() => right.call('read'), body => body === one, 'Restoration after zero-cache/restart failed');
        assert.ok((await right.call('local-copies')).includes('Independent edit survives shared deletion'));
        passed = true;
        console.log('Safe sync deletion passed: owner v6 opt-in, direct shared-files confirmation, Windows lock/retry, durable trash, history restore, local edit conflict/keep-both, restart and zero-cache restoration. One PC, isolated profiles.'); return;
      }
      if (library) {
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('share-ordinary', { roomId: created.roomId });
        await left.call('ui-open', { roomId: created.roomId, surface: 'files', launcher: true });
        await waitFor(() => left.call('ui-state'), state => state.workspaceButtons === 2 && state.text.includes('shared-'), 'Workspace launcher buttons missing');
        assert.equal((await left.call('ui-state')).libraryRoots, 0, 'Folder cards must not clutter the main file list');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-buttons-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-buttons-narrow.png'), width: 520, height: 820 });
        await left.call('ui-doc-click', { selector: '[data-sync-folders-open]' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRoots === 1 && state.text.includes('shared-'), 'Live folder missing from shared files');
        await left.call('ui-click', { target: 'library-expand' });
        await waitFor(() => left.call('ui-state'), state => state.libraryRows === 1 && state.libraryEditors === 1, 'Direct editor control missing');
        for (const [name, width, height] of [['wide', 1100, 900], ['narrow', 520, 820]]) {
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'library-' + name + '.png'), width, height });
          const layout = await left.call('ui-layout');
          assert.equal(layout.overflow.length, 0, 'Library horizontal overflow: ' + JSON.stringify(layout));
          assert.equal(layout.smallButtons.length, 0, 'Library buttons too small: ' + JSON.stringify(layout));
          assert.ok(Math.abs(layout.rowGap) < 3, 'Virtualized files overlap live folders: ' + JSON.stringify(layout));
        }
        await left.call('ui-scroll-files', { bottom: true });
        await waitFor(() => left.call('ui-state'), state => state.lastOrdinaryVisible, 'Virtualized files do not reach the end');
        await left.call('ui-scroll-files', { bottom: false });
        await left.call('ui-click', { target: 'library-expand' });
        await left.call('ui-click', { target: 'library-expand' });
        await waitFor(() => left.call('ui-state'), state => state.libraryEditors === 1, 'Re-expanding folder lost editor');
        await left.call('ui-editor-open', { path: 'config.ini' });
        await waitFor(() => left.call('ui-state'), state => state.editorText.startsWith('first encrypted room configuration'), 'Direct editor did not open working file');
        const edited = 'Saved directly from Shared files\nрусский текст\n';
        await left.call('ui-editor-text', { body: edited });
        await waitFor(() => left.call('ui-state'), state => state.editorText.includes('русский текст') && !state.editorSaveDisabled, 'Editor input missing');
        await left.call('ui-click', { target: 'editor-save' });
        await waitFor(() => right.call('read'), value => value === edited, 'Direct editor save did not reach receiver');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'library-editor.png'), width: 1100, height: 900 });
        await left.call('ui-click', { target: 'editor-close' });
        await left.call('ui-theme');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'library-blue.png'), width: 1000, height: 820 });
        await left.call('ui-click', { target: 'library-settings' });
        await waitFor(() => left.call('ui-state'), state => state.roots === 1 && !state.busy, 'Folder settings did not open');
        assert.equal((await left.call('ui-state')).settingsOpen, false, 'Advanced settings must initially be collapsed');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'folder-settings-wide.png'), width: 1100, height: 900 });
        await left.call('ui-click', { target: 'settings-expand' });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'folder-settings-narrow.png'), width: 520, height: 920 });
        const layout = await left.call('ui-layout');
        assert.equal(layout.overflow.length, 0, 'Settings horizontal overflow: ' + JSON.stringify(layout));
        assert.equal(layout.smallButtons.length, 0, 'Settings buttons too small: ' + JSON.stringify(layout));
        assert.equal(layout.clippedSwitches, 0, 'Toggle slider is outside its track');
        await left.call('ui-click', { target: 'settings-close' });
        await left.call('ui-click', { target: 'history' });
        await waitFor(() => left.call('ui-state'), state => state.historyRows === 2, 'Direct history action missed its entry');
        await right.call('ui-open', { roomId: joined.roomId, surface: 'files' });
        await waitFor(() => right.call('ui-state'), state => state.libraryRoots === 1, 'Receiver shared folder missing');
        await right.call('ui-click', { target: 'library-expand' });
        await waitFor(() => right.call('ui-state'), state => state.libraryEditors === 1, 'Read-only editor missing');
        await right.call('ui-editor-open', { path: 'config.ini' });
        await waitFor(() => right.call('ui-state'), state => state.editorReadOnly === 'true' && !state.editorSaveExists, 'Shared-files entry bypassed writer rights');
        const fresh = await launch('unbound'), freshRoom = await fresh.call('join', { invite: created.invite });
        await waitFor(() => fresh.call('inspect', { roomId: freshRoom.roomId }), state => state.owner && state.members >= 3, 'Unbound profile did not establish room ownership');
        await waitFor(() => fresh.call('roots', { roomId: freshRoom.roomId }), roots => roots.length === 1, 'Unbound folder metadata missing');
        await fresh.call('ui-open', { roomId: freshRoom.roomId, surface: 'files' });
        await waitFor(() => fresh.call('ui-state'), state => state.libraryRoots === 1 && state.libraryConnect, 'Unbound folder must remain visible');
        await fresh.call('ui-click', { target: 'library-expand' });
        await waitFor(() => fresh.call('ui-state'), state => state.libraryRows === 1, 'Unbound folder entries missing');
        assert.equal((await fresh.call('ui-state')).libraryEditors, 0, 'Unbound folder offers a local editor');
        assert.equal(await fresh.call('read'), null, 'Browsing shared files implicitly wrote to disk');
        await fresh.call('ui-capture', { destination: path.join(evidenceRoot, 'library-unbound.png'), width: 900, height: 820 });
        await fresh.call('ui-click', { target: 'library-connect' });
        await waitFor(() => fresh.call('ui-state'), state => state.roots === 1, 'Connect did not open folder settings');
        assert.equal((await fresh.call('roots', { roomId: freshRoom.roomId }))[0].binding, null, 'Opening settings implicitly bound a folder');
        await fresh.call('ui-click', { target: 'bind' });
        await waitFor(() => fresh.call('ui-state'), s => s.preview && !s.busy && s.connectMode === 'receive', 'Connect flow did not offer receive mode');
        assert.equal(await fresh.call('read'), null, 'Previewing receive mode wrote files before consent');
        await fresh.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-connect-receive.png'), width: 1000, height: 900 });
        await fresh.call('ui-click', { target: 'confirm' });
        await waitFor(() => fresh.call('read'), body => body === edited, 'Connect and receive did not download the shared version');
        const receivedMode = await fresh.call('sync-view', { roomId: freshRoom.roomId });
        assert.equal(receivedMode.roots[0].autoApply, true); assert.equal(receivedMode.roots[0].autoPublish, false);
        await left.call('ui-click', { target: 'settings-close' });
        await left.call('ui-doc-click', { selector: ':is(.room-workarea-modal, .room-workspace-modal) > .um-head .um-x' });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-main-before-editor.png'), width: 1100, height: 900 });
        await left.call('ui-doc-click', { selector: '[data-editor-open]' });
        await waitFor(() => left.call('ui-control-ready', { selector: '[data-editor-files]' }), Boolean, 'Editor menu did not open');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-editor-menu.png'), keepSize: true });
        await left.call('ui-doc-click', { selector: '[data-editor-files]' });
        await waitFor(() => left.call('ui-state'), s => s.libraryEditors === 1, 'Project file browser did not expose the editor');
        await left.call('ui-editor-open', { path: 'config.ini' });
        await waitFor(() => left.call('ui-control-ready', { selector: '.room-file-editor-collaborate' }), Boolean, 'Collaborative copy action did not load');
        await left.call('ui-doc-click', { selector: '.room-file-editor-collaborate' });
        await waitFor(() => left.call('ui-doc-state'), s => s.editor && s.page.includes('самостоятельная копия'), 'Copy editor did not explain that it creates a separate document');
        assert.equal((await left.call('ui-doc-layout')).onTop, true, 'Collaborative copy is hidden behind the file editor');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'workspace-collaborative-copy.png'), width: 1100, height: 900 });
        await left.call('ui-doc-click', { selector: '.room-workarea-tab:has([role=tab][aria-selected=true]) > button[aria-label]' });
        await waitFor(() => left.call('ui-control-ready', { selector: '.um-backdrop-top .um-foot button:last-child' }), Boolean, 'Closing the unsaved collaborative copy must ask for confirmation');
        await left.call('ui-doc-click', { selector: '.um-backdrop-top .um-foot button:first-child' });
        await waitFor(() => left.call('ui-doc-state'), s => s.editor && s.page.includes('самостоятельная копия'), 'Cancelling close discarded the copy');
        await left.call('ui-doc-click', { selector: '.room-workarea-tab:has([role=tab][aria-selected=true]) > button[aria-label]' });
        await waitFor(() => left.call('ui-control-ready', { selector: '.um-backdrop-top .um-foot button:last-child' }), Boolean, 'Discard confirmation missing');
        await left.call('ui-doc-click', { selector: '.um-backdrop-top .um-foot button:last-child' });
        await waitFor(() => left.call('ui-state'), s => s.editorOnTop, 'Closing copy did not return to the file buffer');
        assert.equal(await left.call('read'), edited, 'Preparing a collaborative copy changed the project file');
        passed = true;
        console.log('Room shared-files UI passed: visible live folder, direct editor/save/E2E delivery, read-only access, direct history, unbound browsing/explicit consent, mixed virtualized list, wide/narrow settings. One physical PC, isolated profiles.');
        return;
      }
      if (history) {
        const first = (await right.call('sync-files', { roomId: joined.roomId, rootId })).items[0], initialId = first.revisionId, entryId = first.entryId;
        const rights = await left.call('rights', { roomId: created.roomId, rootId });
        const grant = await left.call('rights', { roomId: created.roomId, rootId, writers: rights.candidates.filter(m => m.capable).map(m => m.memberId) });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: grant.previewId });
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.multiWriter && state.roots[0]?.publisher && !state.roots[0]?.autoApply, 'Writer grant pending');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        for (const body of ['archived second version', 'archived third version']) {
          await left.call('publish', { roomId: created.roomId, rootId, body });
          await waitFor(() => right.call('read'), value => value === body, 'Archive holder missed old bytes');
          await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.status === 'published', 'Archive holder receipt pending');
        }
        for (let n = 0; n < 2; n++) {
          const preview = await left.call('checkpoint-preview', { roomId: created.roomId, rootId });
          await left.call('checkpoint-confirm', { roomId: created.roomId, previewId: preview.previewId });
          await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.archives === n + 1, 'Archive holder missed cutover');
          if (!n) {
            await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
            await left.call('publish', { roomId: created.roomId, rootId, body: 'current after first checkpoint' });
            await waitFor(() => right.call('read'), body => body === 'current after first checkpoint', 'Archive holder did not retain current bytes');
            await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.status === 'published', 'Holder current receipt pending');
          }
        }
        let fresh = await launch('fresh'), freshRoom = await fresh.call('join', { invite: created.invite });
        await waitFor(() => fresh.call('checkpoint-state', { roomId: freshRoom.roomId, rootId }), state => state?.archives === 0 && state?.version === 4, 'Fresh history profile did not bootstrap');
        const candidates = await waitFor(() => left.call('rights', { roomId: created.roomId, rootId }), state => state.candidates.filter(m => m.checkpoints).length === 3, 'Fresh writer capability missing');
        const freshGrant = await left.call('rights', { roomId: created.roomId, rootId, writers: candidates.candidates.filter(m => m.checkpoints).map(m => m.memberId) });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: freshGrant.previewId });
        await waitFor(() => fresh.call('sync-view', { roomId: freshRoom.roomId }), state => state.roots[0]?.publisher, 'Fresh writer grant missing');
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.records === 2, 'Holder rights pending');
        await left.call('net-pause');
        await fresh.call('ui-open', { roomId: freshRoom.roomId });
        await waitFor(() => fresh.call('ui-state'), state => state.ready && !state.busy, 'History UI missing');
        await fresh.call('ui-click', { target: 'files' });
        await waitFor(() => fresh.call('ui-state'), state => state.fileRows > 0 && !state.busy, 'History file list missing');
        await fresh.call('ui-click', { target: 'history' });
        await waitFor(() => fresh.call('ui-state'), state => state.historyRows === 1 && state.historyFetch && !state.busy, 'Earlier-history control missing');
        await fresh.call('ui-click', { target: 'history-fetch' });
        await waitFor(() => fresh.call('ui-state'), state => state.historyRows === 4 && state.text.includes('Ранняя история получена') && !state.busy, 'Remote archived history not displayed');
        assert.equal(await fresh.call('read'), null); assert.equal((await fresh.call('roots', { roomId: freshRoom.roomId }))[0].binding, null);
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await fresh.call('ui-capture', { destination: path.join(evidenceRoot, 'history-network-wide.png'), width: 1100, height: 1050 });
        await fresh.call('ui-capture', { destination: path.join(evidenceRoot, 'history-network-narrow.png'), width: 520, height: 900 });
        await stop(fresh); fresh = await launch('fresh'); await fresh.call('restore');
        const versions = await fresh.call('history', { roomId: freshRoom.roomId, rootId, entryId }); assert.ok(versions.items.some(r => r.revisionId === initialId));
        await fresh.call('bind', { roomId: freshRoom.roomId, rootId });
        await waitFor(() => fresh.call('read'), body => body === 'current after first checkpoint', 'Current bytes after history restart not received');
        const review = await fresh.call('restore-preview', { roomId: freshRoom.roomId, rootId, revisionId: initialId });
        assert.equal(await fresh.call('read'), 'current after first checkpoint');
        await fresh.call('restore-confirm', { roomId: freshRoom.roomId, previewId: review.previewId });
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        await waitFor(() => right.call('read'), body => body === one, 'Restored remote history did not become a shared revision');
        passed = true; console.log('Network history passed: two verified archive epochs from a non-owner while owner offline, separate capability, explicit UI download without binding, restart, old encrypted bytes fetched on review and restored as a new shared revision'); return;
      }
      if (multipart) {
        await right.call('net-pause');
        assert.equal(await left.call('multipart-tree', { roomId: created.roomId, rootId }), 2000);
        await left.call('ui-open', { roomId: created.roomId });
        await waitFor(() => left.call('ui-state'), state => state.ready && !state.busy, 'Large folder UI missing');
        await left.call('ui-click', { target: 'checkpoint' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('протокол v5') && state.text.includes('2000') && !state.busy, 'Multipart checkpoint review missing');
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'multipart-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'multipart-narrow.png'), width: 520, height: 820 });
        await left.call('ui-click', { target: 'checkpoint-confirm' });
        await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.version === 5 && state.records === 1 && state.heads === 2000, 'Owner multipart cutover failed');
        await right.call('net-resume');
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 5 && state.heads === 2000 && state.archives === 1, 'Multipart checkpoint not received');
        assert.equal(await right.call('read'), one);
        assert.equal((await right.call('sync-view', { roomId: joined.roomId })).roots[0].autoApply, false);
        await stop(left); await stop(right); left = await launch('publisher'); right = await launch('receiver');
        await left.call('restore'); await right.call('restore');
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 5 && state.heads === 2000, 'Multipart checkpoint lost after restart');
        const fresh = await launch('fresh'), freshRoom = await fresh.call('join', { invite: created.invite });
        await waitFor(() => fresh.call('checkpoint-state', { roomId: freshRoom.roomId, rootId }), state => state?.version === 5 && state.heads === 2000 && state.archives === 0, 'Fresh peer multipart bootstrap failed');
        assert.equal(await fresh.call('read'), null);
        const rights = await left.call('rights', { roomId: created.roomId, rootId });
        const change = await left.call('rights', { roomId: created.roomId, rootId, writers: rights.selected });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: change.previewId });
        await waitFor(() => fresh.call('checkpoint-state', { roomId: freshRoom.roomId, rootId }), state => state?.version === 5 && state.records === 2, 'Large rights policy not transferred');
        await left.call('publish', { roomId: created.roomId, rootId, body: 'after multipart checkpoint' });
        await fresh.call('bind', { roomId: freshRoom.roomId, rootId, autoApply: false });
        await fresh.call('multipart-sample', { roomId: freshRoom.roomId, rootId });
        await waitFor(() => fresh.call('read'), body => body === 'after multipart checkpoint', 'Content after large checkpoint not applied');
        passed = true; console.log('Multipart checkpoints passed: 2000 real source files and signed heads, reviewed v5 cutover, encrypted WebRTC, receiver restart, fresh-profile bootstrap, large rights policy, sample content after cutover and two UI sizes'); return;
      }
      if (checkpoint) {
        const first = await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.status === 'applied', 'Initial receipt missing');
        const entryId = first.items[0].entryId, initialId = first.items[0].revisionId;
        const rights = await left.call('rights', { roomId: created.roomId, rootId });
        const selected = rights.candidates.filter(m => m.checkpoints).map(m => m.memberId); assert.equal(selected.length, 2);
        const grant = await left.call('rights', { roomId: created.roomId, rootId, writers: selected });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: grant.previewId });
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.publisher && state.roots[0]?.multiWriter, 'Writer grant missing');
        await left.call('net-pause');
        const offlineId = await right.call('publish', { roomId: joined.roomId, rootId, body: 'offline signed work preserved across checkpoint' });
        await right.call('net-pause'); await left.call('net-resume');
        await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.version === 2, 'Owner did not resume');
        for (let n = 1; n <= 3; n++) await left.call('publish', { roomId: created.roomId, rootId, body: 'owner checkpoint update ' + n });
        await left.call('ui-open', { roomId: created.roomId });
        await waitFor(() => left.call('ui-state'), state => state.ready && !state.busy, 'Owner UI did not resume');
        await left.call('ui-click', { target: 'checkpoint' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Снимок начнёт новую эпоху') && !state.busy, 'Checkpoint review missing');
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'checkpoint-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'checkpoint-narrow.png'), width: 520, height: 820 });
        await left.call('ui-click', { target: 'checkpoint-confirm' });
        await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.version === 4 && state.records === 1 && state.archives === 1, 'Active owner log not cut');
        await right.call('net-resume');
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 4 && state.archives === 1, 'Offline peer did not accept checkpoint');
        assert.equal(await right.call('read'), 'offline signed work preserved across checkpoint');
        const offlineFiles = await right.call('sync-files', { roomId: joined.roomId, rootId }); assert.equal(offlineFiles.items[0].status, 'deferred');
        const history = await right.call('history', { roomId: joined.roomId, rootId, entryId }); assert.ok(history.items.some(r => r.revisionId === offlineId));
        const recovery = await right.call('restore-preview', { roomId: joined.roomId, rootId, revisionId: offlineId });
        await right.call('restore-confirm', { roomId: joined.roomId, previewId: recovery.previewId });
        await left.call('auto-apply', { roomId: created.roomId, rootId, enabled: true });
        await waitFor(() => left.call('read'), body => body === 'offline signed work preserved across checkpoint', 'Republished offline branch not delivered');
        await waitFor(() => left.call('sync-files', { roomId: created.roomId, rootId }), page => page.items[0]?.status === 'published', 'Owner receipt not committed');
        await stop(left); await stop(right); left = await launch('publisher'); right = await launch('receiver');
        await left.call('restore'); await right.call('restore');
        await waitFor(() => left.call('checkpoint-state', { roomId: created.roomId, rootId }), state => state?.version === 4 && state.archives === 1, 'Owner cutover lost after restart');
        await waitFor(() => right.call('checkpoint-state', { roomId: joined.roomId, rootId }), state => state?.version === 4 && state.archives === 1, 'Peer archive lost after restart');
        assert.equal(await right.call('read'), 'offline signed work preserved across checkpoint');
        const fresh = await launch('fresh'), freshRoom = await fresh.call('join', { invite: created.invite });
        await waitFor(() => fresh.call('checkpoint-state', { roomId: freshRoom.roomId, rootId }), state => state?.version === 4 && state.archives === 0, 'Fresh peer did not bootstrap from checkpoint');
        assert.equal(await fresh.call('read'), null); await fresh.call('bind', { roomId: freshRoom.roomId, rootId });
        await waitFor(() => fresh.call('read'), body => body === 'offline signed work preserved across checkpoint', 'Fresh peer did not receive current content');
        const restored = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: initialId });
        await left.call('restore-confirm', { roomId: created.roomId, previewId: restored.previewId });
        await waitFor(() => fresh.call('read'), body => body === one, 'Archived version restore failed after new-peer bootstrap');
        passed = true; console.log('Signed checkpoints passed: reviewed v4 cutover, bounded active journal, protected offline signed branch, explicit recovery, both profile restarts, fresh-peer bootstrap without old log, archived version restore, encrypted WebRTC and two UI sizes'); return;
      }
      if (compaction) {
        const first = await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.status === 'applied', 'Initial receipt missing');
        const entryId = first.items[0].entryId, initialId = first.items[0].revisionId;
        const receiverPlan = await right.call('log-preview', { roomId: joined.roomId, rootId });
        await right.call('log-confirm', { roomId: joined.roomId, previewId: receiverPlan.previewId });
        await right.call('net-pause');
        const ids = [initialId];
        for (let n = 1; n <= 5; n++) ids.push(await publish('offline journal update ' + n));
        await left.call('ui-click', { target: 'log' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Уплотнение уменьшает') && !state.busy, 'Journal review missing');
        const plan = await left.call('log-summary', { roomId: created.roomId, rootId });
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'log-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'log-narrow.png'), width: 520, height: 820 });
        await left.call('ui-click', { target: 'log-confirm' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Журнал уплотнён.') && !state.busy, 'Compaction completion missing');
        const after = await left.call('log-summary', { roomId: created.roomId, rootId });
        assert.equal(after.records, plan.records); assert.equal(after.pending, 0); assert.ok(after.storedBytes < plan.storedBytes);
        await stop(left); left = await launch('publisher'); await left.call('restore');
        await waitFor(() => left.call('log-summary', { roomId: created.roomId, rootId }), summary => summary?.archived === after.records, 'Publisher archive not restored');
        await right.call('net-resume');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.revisionId === ids.at(-1) && page.items[0]?.status === 'applied', 'Offline receiver did not catch up from compacted sender');
        assert.equal(await right.call('read'), 'offline journal update 5');
        const history = await right.call('history', { roomId: joined.roomId, rootId, entryId });
        for (const id of ids) assert.ok(history.items.some(r => r.revisionId === id), 'Compaction lost signed history');
        await stop(right); right = await launch('receiver'); await right.call('restore');
        await waitFor(() => right.call('log-summary', { roomId: joined.roomId, rootId }), summary => summary?.archived > 0, 'Receiver archive not restored');
        assert.equal(await right.call('read'), 'offline journal update 5');
        const reviewed = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: initialId });
        await left.call('restore-confirm', { roomId: created.roomId, previewId: reviewed.previewId });
        await waitFor(() => right.call('read'), body => body === one, 'History restore failed after compacted profiles restarted');
        passed = true; console.log(`Room sync compaction passed: ${plan.storedBytes} -> ${after.storedBytes} journal bytes before OS protection; full signatures/history, durable outbox, offline encrypted catch-up, both profile restarts, historical restore, reviewed UI at two sizes`); return;
      }
      if (moves) {
        const before = await left.call('rights', { roomId: created.roomId, rootId });
        assert.equal(before.candidates.filter(m => m.moves).length, 2, 'Both devices must advertise v3');
        const selected = before.candidates.filter(m => m.moves).map(m => m.memberId);
        if (ui) {
          await left.call('ui-click', { target: 'rights' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('Разрешить переименования'), 'Move capability control missing');
          await left.call('ui-moves-enable'); await left.call('ui-writers-all');
          await left.call('ui-click', { target: 'rights-review' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('Выбор проверен') && !state.busy, 'V3 opt-in not reviewed');
          await left.call('ui-click', { target: 'rights-confirm' });
        } else {
          const reviewed = await left.call('rights', { roomId: created.roomId, rootId, writers: selected, moves: true });
          await left.call('rights-confirm', { roomId: created.roomId, previewId: reviewed.previewId });
        }
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.moves && !state.roots[0]?.autoApply, 'V3 policy not delivered');
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        const initial = await left.call('sync-files', { roomId: created.roomId, rootId }), entryId = initial.items[0].entryId;
        const toPath = 'configs/renamed.ini';
        if (process.platform === 'win32') await right.call('lock-file');
        if (ui) {
          await left.call('ui-click', { target: 'files' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('Переименовать / переместить') && !state.busy, 'Move action missing');
          await left.call('ui-click', { target: 'move' }); await left.call('ui-move-path', { value: toPath });
          await left.call('ui-click', { target: 'move-review' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('config.ini → ' + toPath) && !state.busy, 'Move preview missing');
          const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'move-wide.png'), width: 1100, height: 900 });
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'move-narrow.png'), width: 520, height: 820 });
          await left.call('ui-click', { target: 'move-confirm' });
        } else {
          const reviewed = await left.call('move-preview', { roomId: created.roomId, rootId, entryId, toPath });
          await left.call('move-confirm', { roomId: created.roomId, previewId: reviewed.previewId });
        }
        if (process.platform === 'win32') {
          try {
            const locked = await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.path === toPath && page.items[0]?.status === 'error', 'Locked move did not report an error');
            assert.match(locked.items[0].detail, /EPERM|EACCES|EBUSY/i); assert.equal(await right.call('read'), one);
            assert.equal(await right.call('read-path', { relativePath: toPath }), null, 'Locked source must not create the destination');
          } finally { await right.call('unlock-file'); }
          await right.call('rescan', { roomId: joined.roomId, rootId });
        }
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.path === toPath && page.items[0]?.status === 'published', 'Move not applied on peer');
        assert.equal(await right.call('read'), null); assert.equal(await right.call('read-path', { relativePath: toPath }), one);
        const history = await left.call('history', { roomId: created.roomId, rootId, entryId }); assert.equal(history.items.length, 2);
        const restore = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: initial.items[0].revisionId }); assert.equal(restore.path, toPath);
        await left.call('restore-confirm', { roomId: created.roomId, previewId: restore.previewId });
        const restoredHead = (await left.call('sync-files', { roomId: created.roomId, rootId })).items[0].revisionId;
        await stop(right); right = await launch('receiver'); await right.call('restore');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.path === toPath && page.items[0]?.status === 'published' && page.items[0]?.revisionId === restoredHead, 'Renamed file failed after restart');
        assert.equal(await right.call('read-path', { relativePath: toPath }), one); assert.equal(await right.call('read'), null);
        passed = true; console.log('Room file sync v3 passed: explicit capability opt-in, encrypted move with stable entry history, old-version restore at current name, peer restart' + (ui ? ', reviewed move UI at two window sizes' : '')); return;
      }
      if (editor) {
        const text = '# Общая заметка\n\n- [ ] Проверить редактор\n- [x] Сохранить историю\n\n```json\n{"sync": true}\n```\n';
        await left.call('publish-note', { roomId: created.roomId, rootId, body: text });
        await waitFor(() => right.call('read-note'), body => body === text, 'Markdown fixture not delivered');
        await left.call('ui-click', { target: 'files' }); await right.call('ui-click', { target: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('note.md'), 'Source file list missing note');
        await left.call('ui-editor-open', { path: 'note.md' });
        await waitFor(() => left.call('ui-state'), state => state.editorText.trimEnd() === text.trimEnd(), 'Editor did not open Markdown');
        const edited = text.replace('Проверить редактор', 'Проверить русский текст и поиск') + '\n<script>window.__editorExecuted = true</script>\n';
        await left.call('ui-editor-text', { body: edited });
        await waitFor(() => left.call('ui-state'), state => !state.editorSaveDisabled && state.editorText.includes('русский текст'), 'Editor did not receive input');
        const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'editor-wide.png'), width: 1100, height: 900 });
        assert.equal((await left.call('ui-state')).editorOnTop, true, 'Wide editor is covered by the folder dialog');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'editor-narrow.png'), width: 520, height: 820 });
        assert.equal((await left.call('ui-state')).editorOnTop, true, 'Narrow editor is covered by the folder dialog');
        await left.call('ui-doc-click', { selector: '.room-file-editor-toolbar button[aria-label="Отменить"]' });
        await waitFor(() => left.call('ui-state'), s => !s.editorText.includes('window.__editorExecuted'), 'Toolbar undo did not change the buffer');
        await left.call('ui-doc-click', { selector: '.room-file-editor-toolbar button[aria-label="Повторить"]' });
        await waitFor(() => left.call('ui-state'), s => s.editorText.includes('window.__editorExecuted'), 'Toolbar redo did not restore the buffer');
        await left.call('ui-doc-click', { selector: '.room-file-editor-toolbar button[aria-pressed]' });
        assert.equal((await left.call('ui-text-editor-layout')).wrapped, false, 'Wrap control did not change the editor');
        await left.call('ui-doc-click', { selector: '.room-file-editor-toolbar button[aria-pressed]' });
        assert.equal((await left.call('ui-text-editor-layout')).wrapped, true, 'Wrap control did not restore wrapping');
        await left.call('ui-doc-click', { selector: '.room-file-editor-toolbar button[aria-label^="Найти"]' });
        await left.call('ui-search-text', { value: 'русский' });
        const editorLayout = await waitFor(() => left.call('ui-text-editor-layout'), s => s.searchMatches > 0, 'Search did not find the Russian text');
        assert.deepEqual(editorLayout.overflow, [], 'Narrow editor controls overflow');
        assert.ok(editorLayout.height >= 200, 'Search panel leaves no room to edit');
        assert.equal(editorLayout.clippedFooter, false, 'Save control is clipped');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'editor-search-narrow.png'), width: 520, height: 820 });
        fs.writeFileSync(path.join(evidenceRoot, 'editor-layout.json'), JSON.stringify(editorLayout, null, 2));
        await left.call('ui-doc-click', { selector: '.room-file-editor-buffer button[name=close]' });
        await left.call('ui-click', { target: 'editor-save' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Версия сохранена на этом устройстве') && state.editorSaveDisabled, 'Editor save not confirmed');
        await waitFor(() => right.call('read-note'), body => body === edited, 'Editor revision not delivered');
        assert.equal(await left.call('read-note'), edited); assert.equal((await left.call('ui-state')).editorExecuted, false, 'Editor executed source markup');
        const darkEditor = await left.call('ui-text-editor-layout');
        await left.call('ui-appearance', { theme: 'light' });
        const lightEditor = await left.call('ui-text-editor-layout');
        assert.notEqual(lightEditor.background, darkEditor.background, 'Editor ignores the light theme');
        assert.notEqual(lightEditor.color, darkEditor.color, 'Editor text ignores the light theme');
        assert.equal(lightEditor.weight, '400', 'Plain editor text should not be bold');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'editor-light.png'), width: 1100, height: 900 });
        await left.call('ui-appearance', { theme: 'dark' }); await left.call('ui-theme');
        await left.call('ui-capture', { destination: path.join(evidenceRoot, 'editor-custom-theme.png'), width: 1100, height: 900 });
        await right.call('ui-editor-open', { path: 'note.md' });
        await waitFor(() => right.call('ui-state'), state => state.editorReadOnly === 'true' && !state.editorSaveExists, 'Receiver editor is not read only');
        await left.call('ui-editor-text', { body: '# Unsaved draft\nPreserve this\n' });
        await waitFor(() => left.call('ui-state'), state => state.editorText.includes('Unsaved draft') && !state.editorSaveDisabled, 'Second editor input not received');
        await left.call('edit-note', { body: '# External file edit\nDo not overwrite\n' });
        await left.call('ui-click', { target: 'editor-save' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Черновик сохранён в открытом редакторе') && state.editorText.includes('Unsaved draft'), 'Stale-save draft was lost');
        assert.equal(await left.call('read-note'), '# External file edit\nDo not overwrite\n');
        await left.call('ui-click', { target: 'editor-close' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Есть несохранённые изменения. Отбросить их?'), 'Closing did not protect dirty draft');
        await left.call('ui-click', { target: 'editor-continue' });
        await waitFor(() => left.call('ui-state'), state => state.editorText.includes('Unsaved draft') && !state.text.includes('Есть несохранённые изменения. Отбросить их?'), 'Continue editing lost the draft');
        await left.call('ui-page-leave');
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Выйти без сохранения'), 'Page navigation did not protect the file buffer');
        await left.call('ui-doc-click', { selector: '.um-backdrop-top .btn-ghost' });
        await waitFor(() => left.call('ui-state'), state => state.editorText.includes('Unsaved draft') && !state.text.includes('Выйти без сохранения'), 'Canceled navigation lost the file buffer');
        passed = true; console.log('File editor passed: native CodeMirror input, Markdown highlighting, signed encrypted save and delivery, read-only receiver, external-edit protection, preserved dirty buffer, close confirmation, two window sizes'); return;
      }
      if (writers) {
        const before = await left.call('rights', { roomId: created.roomId, rootId });
        assert.equal(before.candidates.filter(m => m.capable).length, 2, 'Both devices must advertise v2');
        const selected = before.candidates.filter(m => m.capable).map(m => m.memberId);
        if (ui) {
          await left.call('ui-click', { target: 'rights' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('Кто может редактировать') && state.preview, 'Rights UI missing');
          await left.call('ui-writers-all'); await left.call('ui-click', { target: 'rights-review' });
          await waitFor(() => left.call('ui-state'), state => state.text.includes('Выбор проверен'), 'Rights selection not reviewed');
          const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidenceRoot, { recursive: true });
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'rights-wide.png'), width: 1100, height: 900 });
          await left.call('ui-capture', { destination: path.join(evidenceRoot, 'rights-narrow.png'), width: 520, height: 820 });
          await left.call('ui-click', { target: 'rights-confirm' });
        } else {
          const reviewed = await left.call('rights', { roomId: created.roomId, rootId, writers: selected });
          await left.call('rights-confirm', { roomId: created.roomId, previewId: reviewed.previewId });
        }
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.multiWriter && state.roots[0]?.publisher && !state.roots[0]?.autoApply, 'V2 policy not delivered');
        const leftId = await left.call('publish', { roomId: created.roomId, rootId, body: 'left concurrent encrypted edit' });
        const rightId = await right.call('publish', { roomId: joined.roomId, rootId, body: 'right concurrent encrypted edit' });
        const page = await waitFor(() => left.call('sync-files', { roomId: created.roomId, rootId }), page => page.items[0]?.status === 'conflict', 'Concurrent heads not preserved');
        const history = await left.call('history', { roomId: created.roomId, rootId, entryId: page.items[0].entryId });
        assert.equal(history.branches, 2); assert.ok(history.items.some(r => r.revisionId === leftId)); assert.ok(history.items.some(r => r.revisionId === rightId));
        const merge = await left.call('restore-preview', { roomId: created.roomId, rootId, revisionId: rightId });
        assert.equal(merge.branches, 2); await left.call('restore-confirm', { roomId: created.roomId, previewId: merge.previewId });
        await right.call('auto-apply', { roomId: joined.roomId, rootId, enabled: true });
        await waitFor(() => left.call('read'), body => body === 'right concurrent encrypted edit', 'Chosen branch not applied');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items[0]?.status === 'published', 'Merge not delivered');
        await stop(right); right = await launch('receiver'); await right.call('restore');
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => state.roots[0]?.publisher && state.roots[0]?.multiWriter, 'V2 rights lost on restart');
        await right.call('publish', { roomId: joined.roomId, rootId, body: 'offline device independent changes' });
        const revoked = await left.call('rights', { roomId: created.roomId, rootId, writers: [before.ownerId] });
        await left.call('rights-confirm', { roomId: created.roomId, previewId: revoked.previewId });
        await waitFor(() => right.call('sync-view', { roomId: joined.roomId }), state => !state.roots[0]?.publisher && !state.roots[0]?.autoApply, 'Revocation not delivered');
        assert.equal(await right.call('read'), 'offline device independent changes', 'Revocation discarded local bytes');
        await assert.rejects(right.call('publish', { roomId: joined.roomId, rootId, body: 'revoked local edit' }), /publisher binding/);
        passed = true; console.log('Room file sync v2 passed: signed writer grants, encrypted concurrent branches, explicit merge, restart and writer revocation' + (ui ? ', reviewed rights UI at two window sizes' : '')); return;
      }
      const two = 'second encrypted room configuration\n'.repeat(2048);
      const secondRevision = await publish(two);
      await waitFor(() => right.call('read'), value => value === two, 'Second file version not applied');
      await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }),
        page => page.items.some(file => file.revisionId === secondRevision && file.status === 'applied'), 'Second version receipt not committed');
      if (faults) {
        await right.call('lock-file');
        try {
          const lockedVersion = await publish('saved while the receiver file is locked');
          const failed = await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }),
            page => page.items.some(file => file.revisionId === lockedVersion && file.status === 'error'), 'Windows file lock was not reported');
          assert.match(failed.items.find(file => file.revisionId === lockedVersion).detail, /EPERM|EACCES|EBUSY/i);
          assert.equal(await right.call('read'), two, 'Locked working file was changed');
          assert.ok((await right.call('journal-state')).pending > 0, 'Lock must interrupt an actual prepared file transaction');
          record('windowsSharingViolationPreservesWorkingFileAndJournal');
        } finally { await right.call('unlock-file'); }
        await right.call('rescan', { roomId: joined.roomId, rootId });
        await waitFor(() => right.call('read'), value => value === 'saved while the receiver file is locked', 'Unlock and recheck did not resume application');
        await waitFor(() => right.call('journal-state'), state => state.pending === 0 && state.rolledBack > 0, 'Interrupted file journal did not reconcile');
        assert.ok((await right.call('backups')).includes(two), 'Unlocked retry lost the old working bytes');
        record('unlockRecoversPreparedJournalAndAppliesWithBackup');
        const empty = await publish('');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === empty && file.status === 'applied'), 'Empty file receipt missing');
        assert.equal(await right.call('read'), '', 'Empty file content changed'); record('zeroByteEncryptedFile');
        await right.call('net-pause');
        const offlineVersions = [];
        for (let i = 1; i <= 3; i++) offlineVersions.push(await publish('offline update ' + i));
        assert.equal(await right.call('read'), '', 'Suspended receiver wrote an offline update');
        assert.equal((await right.call('inspect', { roomId: joined.roomId })).syncRoots.length, 0, 'Paused file-sync service is still active');
        await right.call('net-resume');
        await waitFor(() => right.call('read'), value => value === 'offline update 3', 'Receiver did not catch up after network resume');
        const resumedFiles = await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === offlineVersions[2] && file.status === 'applied'), 'Latest offline revision receipt missing');
        const entryId = resumedFiles.items.find(file => file.path === 'config.ini').entryId;
        const history = await right.call('history', { roomId: joined.roomId, rootId, entryId });
        for (const revisionId of offlineVersions) assert.ok(history.items.some(item => item.revisionId === revisionId), 'Offline history was lost');
        record('networkPauseRestoresConsentAndAllMissedRevisionMetadata');
        // Stop only this fixture's receiver; no adapters, firewall or user processes are changed.
        await stop(right); const caughtUp = await launch('receiver'); await caughtUp.call('restore');
        await waitFor(() => caughtUp.call('inspect', { roomId: joined.roomId }), state => state.connection?.channels?.identified > 0, 'Caught-up receiver did not reconnect');
        assert.equal(await caughtUp.call('read'), 'offline update 3');
        const afterRestart = await publish('post-pause restart update');
        await waitFor(() => caughtUp.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === afterRestart && file.status === 'applied'), 'Next update failed after network pause and restart');
        assert.equal(await caughtUp.call('read'), 'post-pause restart update'); record('postPauseRestartAcceptsNextUpdate');
        // Reuse the original receiver handle in the remaining conflict/restart checks.
        right = caughtUp;
      }
      if (ui && !conflictsOnly) {
        await left.call('ui-click', { target: 'files' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('config.ini') && state.fileRows > 0 && !state.busy, 'Publisher file list missing');
        await left.call('ui-click', { target: 'history' });
        await waitFor(() => left.call('ui-state'), state => state.historyRows === 2 && !state.busy, 'Version history missing');
        await left.call('ui-click', { target: 'cache' });
        await waitFor(() => left.call('ui-state'), state => state.cache && !state.busy, 'Cache controls missing');
        await left.call('ui-cache-limit', { value: '0' });
        await left.call('ui-click', { target: 'cache-save' });
        await waitFor(() => left.call('ui-state'), state => state.text.includes('Потребуется загрузка у участников') && !state.busy, 'Old version was not evicted');
        const cacheEvidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(cacheEvidence, { recursive: true });
        await left.call('ui-capture', { destination: path.join(cacheEvidence, 'cache-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(cacheEvidence, 'cache-narrow.png'), width: 520, height: 820 });
        await left.call('ui-click', { target: 'restore-version' });
        await waitFor(() => left.call('ui-state'), state => state.preview && state.text.includes('Восстановление версии') && !state.busy, 'Restore review missing');
        await left.call('ui-click', { target: 'restore-confirm' });
        await waitFor(() => left.call('ui-state'), state => !state.preview && state.historyRows === 3 && !state.busy, 'Restoration did not create history');
        await waitFor(() => right.call('read'), body => body === one, 'Restored version did not propagate');
        previousRevision = (await left.call('sync-files', { roomId: created.roomId, rootId })).items.find(file => file.path === 'config.ini').revisionId;
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === previousRevision && file.status === 'applied'), 'Restored version receipt missing');
        const evidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidence, { recursive: true });
        await left.call('ui-history-scroll');
        await left.call('ui-capture', { destination: path.join(evidence, 'history-wide.png'), width: 1100, height: 900 });
        await left.call('ui-capture', { destination: path.join(evidence, 'history-narrow.png'), width: 520, height: 820 });
      }
      assert.equal((await left.call('inspect', { roomId: created.roomId })).ordinaryFiles, 0);
      assert.equal((await right.call('inspect', { roomId: joined.roomId })).ordinaryFiles, 0);
      await right.call('edit', { body: 'local independent edit' });
      const third = await publish('third shared version');
      await waitFor(() => right.call('inspect', { roomId: joined.roomId, rootId }), state => state.retries.includes(rootId + ':' + third), 'Local conflict was not detected');
      assert.equal(await right.call('read'), 'local independent edit');
      if (ui) {
        await right.call('ui-click', { target: 'files' });
        await waitFor(() => right.call('ui-state'), state => state.conflicts === 1 && !state.busy, 'Conflict UI missing');
        const evidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence'); fs.mkdirSync(evidence, { recursive: true });
        await right.call('ui-capture', { destination: path.join(evidence, 'conflict-wide.png'), width: 1100, height: 900 });
        await right.call('ui-capture', { destination: path.join(evidence, 'conflict-narrow.png'), width: 520, height: 820 });
        await right.call('ui-click', { target: 'defer-conflict' });
        await waitFor(() => right.call('ui-state'), state => state.text.includes('Обновление отложено') && !state.busy, 'Per-file deferral missing');
        const fourth = await publish('fourth shared version\nwhile file is deferred');
        await waitFor(() => right.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === fourth && file.status === 'deferred'), 'New head lost deferral');
        assert.equal(await right.call('read'), 'local independent edit');
      }
      await stop(right);
      let restarted = await launch('receiver');
      await restarted.call('restore');
      await waitFor(() => restarted.call('inspect', { roomId: joined.roomId }), state => state.syncRoots.some(root => root.rootId === rootId && root.binding?.autoApply), 'Binding not restored automatically');
      assert.equal(await restarted.call('read'), 'local independent edit');
      if (ui) {
        await waitFor(() => restarted.call('inspect', { roomId: joined.roomId }), state => state.connection?.channels?.identified > 0, 'Receiver room channel did not reconnect');
        await waitFor(() => restarted.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.status === 'deferred'), 'Deferral did not survive restart');
        await restarted.call('ui-open', { roomId: joined.roomId });
        await waitFor(() => restarted.call('ui-state'), state => state.ready && !state.busy, 'Restarted receiver UI missing');
        await restarted.call('ui-click', { target: 'files' });
        await waitFor(() => restarted.call('ui-state'), state => state.text.includes('Обновление отложено') && !state.busy, 'Deferred row missing');
        await restarted.call('ui-click', { target: 'review-conflict' });
        await waitFor(() => restarted.call('ui-state'), state => state.diffRows > 0 && state.text.includes('local independent edit') && state.text.includes('fourth shared version') && !state.busy, 'Verified conflict diff missing');
        const conflictEvidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence');
        await restarted.call('ui-capture', { destination: path.join(conflictEvidence, 'resolve-wide.png'), width: 1100, height: 900 });
        await restarted.call('ui-capture', { destination: path.join(conflictEvidence, 'resolve-narrow.png'), width: 520, height: 820 });
        await restarted.call('ui-click', { target: 'keep-conflict' });
        await waitFor(() => restarted.call('ui-state'), state => !state.preview && !state.busy && state.text.includes('Локальные правки сохранены отдельно'), 'Keep-both result missing');
        assert.equal(await restarted.call('read'), 'fourth shared version\nwhile file is deferred');
        assert.ok((await restarted.call('local-copies')).includes('local independent edit'), 'Separate copy lost local edits');
        await restarted.call('edit', { body: 'second independent edit' });
        const fifth = await publish('fifth shared version');
        await waitFor(() => restarted.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === fifth && file.status === 'conflict' && file.resolvable), 'Next conflict missing');
        await waitFor(() => restarted.call('ui-state'), state => state.conflicts === 1 && !state.busy, 'Next conflict UI missing');
        await restarted.call('ui-click', { target: 'review-conflict' });
        await waitFor(() => restarted.call('ui-state'), state => state.diffRows > 0 && !state.busy, 'Next diff missing');
        await restarted.call('ui-click', { target: 'accept-conflict' });
        await waitFor(() => restarted.call('ui-state'), state => !state.preview && !state.busy && state.conflicts === 0, 'Accept-shared failed');
        assert.equal(await restarted.call('read'), 'fifth shared version');
        assert.ok((await restarted.call('backups')).includes('second independent edit'), 'Accept-shared lost its backup');
        const beforeCleanup = await restarted.call('backups');
        await restarted.call('ui-click', { target: 'backups' });
        await waitFor(() => restarted.call('ui-state'), state => state.backupRows > 0 && !state.busy, 'Backup inventory missing');
        await restarted.call('ui-backup-settings', { versions: '1', days: '0', mib: '0' });
        assert.equal((await restarted.call('ui-state')).backupConfirmDisabled, true, 'Unreviewed settings can be confirmed');
        await restarted.call('ui-click', { target: 'backup-review' });
        await waitFor(() => restarted.call('ui-state'), state => state.backupRemove > 0 && !state.busy, 'Cleanup candidates missing');
        const backupEvidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence');
        await restarted.call('ui-capture', { destination: path.join(backupEvidence, 'backups-wide.png'), width: 1100, height: 900 });
        await restarted.call('ui-capture', { destination: path.join(backupEvidence, 'backups-narrow.png'), width: 520, height: 820 });
        await restarted.call('ui-click', { target: 'backup-confirm' });
        await waitFor(() => restarted.call('ui-state'), state => !state.preview && !state.busy && state.text.includes('Настройки сохранены'), 'Cleanup result missing');
        const afterCleanup = await restarted.call('backups');
        assert.ok(afterCleanup.length < beforeCleanup.length, 'Cleanup did not reclaim old copies');
        assert.ok(afterCleanup.includes('second independent edit'), 'Cleanup removed the current rollback copy');
        assert.ok((await restarted.call('local-copies')).includes('local independent edit'), 'Cleanup touched separate local copies');
        assert.equal(await restarted.call('read'), 'fifth shared version');
        // Reopen after pruning to exercise receipt recovery before the next network apply.
        await stop(restarted); restarted = await launch('receiver'); await restarted.call('restore');
        await waitFor(() => restarted.call('inspect', { roomId: joined.roomId }), state => state.connection?.channels?.identified > 0, 'Pruned receiver did not reconnect');
        assert.equal(await restarted.call('read'), 'fifth shared version');
        await restarted.call('ui-open', { roomId: joined.roomId });
        await waitFor(() => restarted.call('ui-state'), state => state.ready && !state.busy, 'Receiver filter UI missing');
        await restarted.call('ui-click', { target: 'filters' });
        await waitFor(() => restarted.call('ui-state'), state => state.filterRows >= 2 && !state.busy, 'Local/shared exclusion preview missing');
        await restarted.call('ui-filter-rules', { value: 'config.ini' });
        assert.equal((await restarted.call('ui-state')).filterConfirmDisabled, true, 'Unreviewed patterns can be saved');
        await restarted.call('ui-click', { target: 'filter-review' });
        await waitFor(() => restarted.call('ui-state'), state => state.filterRuleExcluded >= 2 && !state.busy, 'Pattern reasons missing');
        const filterEvidence = path.resolve(__dirname, '../dist/room-sync-ui/evidence');
        await restarted.call('ui-capture', { destination: path.join(filterEvidence, 'filters-wide.png'), width: 1100, height: 900 });
        await restarted.call('ui-capture', { destination: path.join(filterEvidence, 'filters-narrow.png'), width: 520, height: 820 });
        await restarted.call('ui-click', { target: 'filter-confirm' });
        await waitFor(() => restarted.call('ui-state'), state => !state.preview && !state.busy && state.text.includes('Исключения сохранены'), 'Filter confirmation missing');
        const excludedRevision = await publish('shared update excluded by the receiver');
        await waitFor(() => restarted.call('sync-files', { roomId: joined.roomId, rootId }), page => page.items.some(file => file.revisionId === excludedRevision && file.status === 'excluded'), 'Receiver did not exclude new shared version');
        assert.equal(await restarted.call('read'), 'fifth shared version');
        await stop(restarted); restarted = await launch('receiver'); await restarted.call('restore');
        await waitFor(() => restarted.call('inspect', { roomId: joined.roomId }), state => state.connection?.channels?.identified > 0, 'Filtered receiver did not reconnect');
        assert.equal((await restarted.call('sync-files', { roomId: joined.roomId, rootId })).items.find(file => file.path === 'config.ini').status, 'excluded');
        await restarted.call('ui-open', { roomId: joined.roomId });
        await waitFor(() => restarted.call('ui-state'), state => state.ready && !state.busy, 'Filtered receiver UI missing');
        await restarted.call('ui-click', { target: 'filters' });
        await waitFor(() => restarted.call('ui-state'), state => state.filterRules === 'config.ini' && !state.busy, 'Saved patterns did not survive restart');
        await restarted.call('ui-filter-rules', { value: '' }); await restarted.call('ui-click', { target: 'filter-review' });
        await waitFor(() => restarted.call('ui-state'), state => state.filterRows >= 2 && state.filterRuleExcluded === 0 && !state.busy, 'Removed pattern preview missing');
        await restarted.call('ui-click', { target: 'filter-confirm' });
        await waitFor(() => restarted.call('read'), value => value === 'shared update excluded by the receiver', 'Removing the pattern did not fetch/apply the latest shared head');
        await stop(left);
        fs.writeFileSync(path.join(left.directory, 'working/config.ini'), 'save while publisher is closed');
        const resumedPublisher = await launch('publisher'); await resumedPublisher.call('restore');
        await waitFor(() => resumedPublisher.call('sync-files', { roomId: created.roomId, rootId }),
          page => page.items.some(file => file.path === 'config.ini' && file.revisionId !== previousRevision), 'Publisher did not resume automatic saves after restart');
        await waitFor(() => restarted.call('read'), body => body === 'save while publisher is closed', 'Automatic updates did not resume after conflict resolution');
      }
      passed = true;
      if (faults) record('independentLocalEditSurvivesAnotherReceiverRestart');
      console.log('Room file sync passed: real encrypted WebRTC transfer, two versions, no implicit binding, separate manifest, local conflict, restart' + (ui ? (conflictsOnly ? '' : ', UI history/cache/restore') + ', persistent deferral, text diff, keep-both, accept-shared, reviewed backup cleanup, local/shared exclusion preview, persistent filters, unexclude latest head, automatic updates resume' : '') + (faults ? ', Windows file lock, unlock/retry, zero-byte E2E, network pause/catch-up/restart' : ''));
    } catch (error) {
      for (const worker of workers) {
        if (worker.child.exitCode === null && roomIds) {
          try { console.error('Fixture state', path.basename(worker.directory), JSON.stringify(await worker.call('inspect', { roomId: roomIds[path.basename(worker.directory)] }))); } catch { /* already exiting */ }
        }
        console.error(path.basename(worker.directory), worker.logs());
      }
      console.error('Fixture retained for diagnostics:', fixture); throw error;
    } finally {
      await Promise.all(workers.map(async worker => {
        if (worker.child.exitCode !== null) { worker.socket?.destroy(); return; }
        const exited = new Promise(resolve => worker.child.once('exit', resolve));
        try { await worker.call('stop'); } catch { worker.child.kill(); }
        await exited; worker.socket?.destroy();
      }));
      await new Promise(resolve => tracker.close(resolve));
      if (relayTracker) await new Promise(resolve => relayTracker.close(resolve));
      if (faults) {
        evidence.passed = passed; evidence.finishedAt = new Date().toISOString();
        const built = process.env.HAVVN_SYNC_FIXTURE_BUILT_ROOT ? path.join(process.env.HAVVN_SYNC_FIXTURE_BUILT_ROOT, 'sharing') : path.resolve(__dirname, '../dist/electron/electron/sharing');
        evidence.build = Object.fromEntries(['room-file-sync.js', 'room-sync-session.js', 'room-sync-apply.js', 'room-engine.js'].map(name =>
          [name, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(built, name))).digest('hex')]));
        const destination = path.resolve(__dirname, '../dist/room-sync-acceptance'); fs.mkdirSync(destination, { recursive: true });
        const report = path.join(destination, 'windows-faults.json'); fs.writeFileSync(report, JSON.stringify(evidence, null, 2)); console.log('Acceptance evidence:', report);
      }
      if (passed) {
        const target = path.resolve(fixture), temp = path.resolve(os.tmpdir());
        assert.equal(path.dirname(target), temp); assert.ok(path.basename(target).startsWith('havvn-sync-rooms-'));
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      }
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const electron = require('electron'), { app } = electron;
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  const directory = process.env.HAVVN_SYNC_FIXTURE_DIRECTORY, tracker = process.env.HAVVN_SYNC_FIXTURE_TRACKER;
  if (!directory || !tracker?.startsWith('ws://127.0.0.1:')) throw new Error('Fixture environment missing');
  const profile = path.join(directory, 'profile'); fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.on('window-all-closed', () => {});
  const built = path.resolve(process.env.HAVVN_SYNC_FIXTURE_BUILT_ROOT || path.resolve(__dirname, '../dist/electron/electron'));
  if (!built.startsWith(path.resolve(__dirname, '..') + path.sep)) throw new Error('Fixture runtime must stay inside the repository');
  const originalPreload = path.join(built, 'sharing/room-engine.js');
  const wrapper = path.join(directory, 'fixture-preload.cjs');
  // Clear only this isolated preload's STUN list before the real engine is loaded.
  fs.writeFileSync(wrapper, `require(${JSON.stringify(path.join(built, 'sharing/ice-servers.js'))}).STUN_SERVERS.length = 0; require(${JSON.stringify(originalPreload)});`);
  const OriginalWindow = electron.BrowserWindow;
  const WindowProxy = new Proxy(OriginalWindow, { construct(Target, args) {
    const options = args[0];
    if (options?.webPreferences?.preload === originalPreload) args[0] = { ...options, webPreferences: { ...options.webPreferences, preload: wrapper } };
    return Reflect.construct(Target, args);
  } });
  const injectedElectron = Object.create(electron);
  let cancelSaveOnce = false, trashExportNumber = 1;
  Object.defineProperty(injectedElectron, 'BrowserWindow', { value: WindowProxy });
  if (process.env.HAVVN_SYNC_FIXTURE_UI === '1') Object.defineProperty(injectedElectron, 'dialog', { value: new Proxy(electron.dialog, { get(target, key) {
    if (key === 'showSaveDialog') return async (_window, options) => {
      if (cancelSaveOnce) { cancelSaveOnce = false; return { canceled: true }; }
      return { canceled: false, filePath: path.join(directory, !options?.filters ? `trash-copy-${trashExportNumber}.ini` : options.filters.some(f => f.extensions.includes('md')) ? 'document.md' : 'history.havvn-history') };
    };
    if (key === 'showOpenDialog') return async (_window, options) => ({ canceled: false, filePaths: [path.join(directory, options?.filters?.some(f => f.extensions.includes('havvn-history')) ? 'history.havvn-history' : 'working')] });
    return target[key];
  } }) });
  const Module = require('node:module'), load = Module._load;
  Module._load = function(request, parent, isMain) { return request === 'electron' ? injectedElectron : load.call(this, request, parent, isMain); };
  const deadline = setTimeout(() => { console.error('Room file-sync fixture deadline'); app.exit(1); }, process.env.HAVVN_SYNC_FIXTURE_OFFICE === '1' ? 3_600_000 : process.env.HAVVN_SYNC_FIXTURE_DELETES === '1' ? 300_000 : 180_000);
  app.whenReady().then(async () => {
    require(path.join(built, 'utils/logger.js')).logger.initialize({ minLevel: 'debug', disableFileLogging: true });
    const db = require(path.join(built, 'db/store.js'));
    if (process.env.HAVVN_SYNC_FIXTURE_DOCUMENTS === '1') db.updateRoomProfile({ name: path.basename(directory) === 'publisher' ? 'Алексей' : path.basename(directory) === 'receiver' ? 'Егор' : 'Мария' });
    const configuredTrackers = [tracker, ...(process.env.HAVVN_SYNC_FIXTURE_EXTRA_TRACKER ? [process.env.HAVVN_SYNC_FIXTURE_EXTRA_TRACKER] : [])];
    assert.ok(configuredTrackers.every(url => url.startsWith('ws://127.0.0.1:')));
    await db.updateSettings({ defaultDownloadDir: path.join(directory, 'downloads'), customTrackers: configuredTrackers, shareUseTurn: false });
    assert.deepEqual(require(path.join(built, 'sharing/ice-servers.js')).resolveTrackers(configuredTrackers), configuredTrackers);
    const { RoomManager } = require(path.join(built, 'sharing/room-manager.js'));
    const { buildInvite } = require(path.join(built, 'sharing/room-crypto.js'));
    const manager = new RoomManager(), working = path.join(directory, 'working'); fs.mkdirSync(working, { recursive: true });
    let holdDocumentRecords = false;
    const managerCall = manager.call.bind(manager);
    manager.call = (type, payload, ...args) => {
      if (holdDocumentRecords && type === 'documentsSend' && ['heads', 'part'].includes(payload?.body?.kind)) return Promise.reject(new Error('Fixture document record link is unavailable'));
      return managerCall(type, payload, ...args);
    };
    let fileLock;
    const unlockFile = async () => {
      const child = fileLock; fileLock = undefined; if (!child || child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end('\n'); const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    };
    const lockFile = async () => {
      if (fileLock) throw new Error('Fixture file already locked');
      const child = require('node:child_process').spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'fixtures/room-sync-lock.ps1'), '-LiteralPath', path.join(working, 'config.ini')], { windowsHide: true, stdio: 'pipe' });
      fileLock = child;
      child.stdin.on('error', () => {}); // A failed helper can close its pipe before cleanup sends the release.
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Windows lock helper timeout')), 10_000);
          const lines = require('node:readline').createInterface({ input: child.stdout }); let errors = '';
          child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2048); });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(new Error('Windows lock helper exited ' + code + ': ' + errors)); });
          lines.on('line', line => { if (line === 'LOCKED') { clearTimeout(timer); resolve(); } });
        });
      } catch (error) { await unlockFile(); throw error; }
    };
    const syncTrace = [];
    manager.onEngine('room-file-sync-frame', (_event, packet) => { syncTrace.push({ from: packet.memberId, kind: packet.body.kind, root: packet.body.rootId, stream: packet.body.streamId }); if (syncTrace.length > 32) syncTrace.shift(); });
    let uiWindow;
    if (process.env.HAVVN_SYNC_FIXTURE_UI === '1') {
      uiWindow = new electron.BrowserWindow({ show: false, width: 1100, height: 900,
        webPreferences: { preload: path.join(built, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      uiWindow.webContents.on('console-message', (event, details) => console.error('UI console:', details?.message ?? event.message ?? details));
      uiWindow.webContents.on('preload-error', (_event, _preload, error) => console.error('UI preload:', error));
      require(path.join(built, 'ipc/room-file-sync.js')).registerRoomFileSyncIpc(uiWindow, manager);
      require(path.join(built, 'ipc/room-documents.js')).registerRoomDocumentsIpc(uiWindow, manager);
      electron.ipcMain.handle('rooms:get', (_event, id) => manager.getRoom(id));
    }
    const evaluate = async code => {
      const response = await uiWindow.webContents.executeJavaScript(`Promise.resolve().then(() => (${code})).then(value => ({value}), error => ({error: String(error.stack || error)}))`);
      if (response.error) throw new Error(response.error); return response.value;
    };
    const chooseUiMode = async (selector, value) => {
      const labels = { manual: 'Вручную', receive: 'Только получать изменения', send: 'Только отправлять изменения', sync: 'Обмениваться изменениями' };
      if (!labels[value]) throw Error('Invalid fixture mode');
      await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)} + ' [role=combobox]'); if (!e) throw Error('Mode picker unavailable'); e.click(); })()`);
      await new Promise(resolve => setTimeout(resolve, 30));
      await evaluate(`(() => { const e = [...document.querySelectorAll('[role=option]')].find(e => e.textContent.trim() === ${JSON.stringify(labels[value])}); if (!e) throw Error('Mode option unavailable'); e.click(); })()`);
    };
    app.on('browser-window-created', (_event, window) => {
      window.webContents.on('console-message', (event, details) => console.error('Engine console:', details?.message ?? event.message ?? details));
      window.webContents.on('preload-error', (_event, _preload, error) => console.error('Engine preload:', error));
    });
    let queue = Promise.resolve();
    const server = require('node:net').createServer(socket => {
      const respond = packet => socket.write(PREFIX + JSON.stringify(packet) + '\n');
      require('node:readline').createInterface({ input: socket }).on('line', line => {
      queue = queue.catch(() => {}).then(async () => {
        const message = JSON.parse(line); let result;
        try {
          const { action, roomId, rootId } = message;
          if (action === 'create') {
            const state = await manager.createRoom('File sync fixture', true, false), record = db.getPersistedRooms().find(r => r.roomId === state.roomId);
            result = { roomId: state.roomId, invite: buildInvite(record.code, record.ownerId) };
          } else if (action === 'join') { const state = await manager.joinRoom(message.invite, false); result = { roomId: state.roomId }; }
          else if (action === 'runtime') result = { electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome };
          else if (action === 'save-cancel-once') { cancelSaveOnce = true; result = true; }
          else if (action === 'trash-export-fresh-name') { result = ++trashExportNumber; }
          else if (action === 'docs-view') result = await manager.documentsView(roomId);
          else if (action === 'docs-hold-records') { holdDocumentRecords = message.enabled === true; result = true; }
          else if (action === 'docs-transfer-owner') result = await manager.transferOwner(roomId, message.memberId);
          else if (action === 'docs-kick') result = await manager.kick(roomId, message.memberId);
          else if (action === 'docs-inspect') {
            const service = manager.documents(roomId), opened = await service.open(message.documentId);
            try { result = { ...opened, text: (await service.exportText(opened.token)).text, snapshots: await service.history(opened.token) }; } finally { service.closeDocument(opened.token); }
          }
          else if (action === 'docs-routes') result = (await manager.getRoom(roomId))?.members.map(m => ({ name: m.name, memberId: m.memberId, relayed: m.relayed, isSelf: m.isSelf }));
          else if (action === 'docs-policy') {
            const service = manager.documents(roomId), opened = await service.open(message.documentId);
            try { result = await service.changePolicy(message.documentId, opened.policyId, opened.title, message.writers, false); } finally { service.closeDocument(opened.token); }
          }
          else if (action === 'ui-mode-preview') { await chooseUiMode('[data-sync-connect-mode]', message.value); result = true; }
          else if (action === 'ui-control-ready') result = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(message.selector)})].find(e => e.getClientRects().length); return !!e && !e.disabled; })()`);
          else if (action === 'ui-text-editor-layout') result = await evaluate(`(() => {
            const surface = [...document.querySelectorAll('.room-text-editor')].find(e => e.getClientRects().length), content = surface?.querySelector('.cm-content');
            const footer = document.querySelector('.room-file-editor-modal .um-foot, .room-file-editor-modal .room-tool-footer'), edge = footer?.getBoundingClientRect();
            return { height: surface?.getBoundingClientRect().height, wrapped: content && ['pre-wrap', 'break-spaces'].includes(getComputedStyle(content).whiteSpace),
              searchMatches: surface?.querySelectorAll('.cm-searchMatch').length || 0,
              font: content && getComputedStyle(content).fontFamily, weight: content && getComputedStyle(content).fontWeight,
              color: content && getComputedStyle(content).color, background: surface && getComputedStyle(surface.querySelector('.cm-editor')).backgroundColor,
              clippedFooter: !!edge && (edge.bottom > innerHeight || edge.top < 0),
              overflow: [...document.querySelectorAll('.room-file-editor-modal,.room-file-editor-toolbar,.room-file-editor-status,.hd-modal,.hd-toolbar,.hd-statusbar,.cm-search')].filter(e=>e.getClientRects().length && e.scrollWidth > e.clientWidth + 2).map(e=>e.className) };
          })()`);
          else if (action === 'ui-search-text') {
            await evaluate(`(() => { const input = [...document.querySelectorAll('.room-text-editor input[name=search]')].find(e=>e.getClientRects().length); if (!input) throw Error('Editor search is unavailable'); input.focus(); input.select(); })()`);
            await uiWindow.webContents.insertText(message.value);
            // CodeMirror commits its search query on keyup/change, as real typing does.
            await uiWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); result = true;
          }
          else if (action === 'ui-doc-click') result = await evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(message.selector)})].find(e => e.getClientRects().length); if (!e || e.disabled) throw Error('Document control unavailable: ' + ${JSON.stringify(message.selector)}); e.click(); return true; })()`);
          else if (action === 'ui-doc-input') result = await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(message.selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(message.value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
          else if (action === 'ui-doc-text') {
            await evaluate(`(() => { const content = [...document.querySelectorAll('.hd-code .cm-content')].find(e => e.getClientRects().length); content.focus(); content.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(message.append ? 'End' : 'a')}, ctrlKey: true, bubbles: true })); return true; })()`);
            await uiWindow.webContents.insertText(message.body); result = true;
          }
          else if (action === 'ui-doc-key') result = await evaluate(`(() => { const buffer = [...document.querySelectorAll('.hd-buffer')].find(e=>e.style.display!=='none'), content = buffer.querySelector('.cm-content'); content.focus(); content.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(message.key)},ctrlKey:${!!message.ctrlKey},shiftKey:${!!message.shiftKey},bubbles:true})); return true; })()`);
          else if (action === 'ui-doc-focus-search') {
            const debug = uiWindow.webContents.debugger;
            if (!debug.isAttached()) debug.attach('1.3');
            await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
            await evaluate(`document.querySelector('.hd-search input').focus()`);
            for (const modifiers of [[], ['shift']]) {
              await uiWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers });
              await uiWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers });
            }
            result = true;
          }
          else if (action === 'ui-doc-layout') result = await evaluate(`(() => {
            const body = document.querySelector('.hd-body'), workspace = document.querySelector('.hd-workspace'), empty = document.querySelector('.hd-empty'), icon = empty?.querySelector('svg');
            const search = document.querySelector('.hd-search input'), title = document.querySelector('[data-docs-title]');
            const editor = [...document.querySelectorAll('.hd-buffer .cm-content')].find(e => e.getClientRects().length);
            const iconRect = icon?.getBoundingClientRect(), emptyRect = empty?.getBoundingClientRect();
            const modal = document.querySelector('.hd-modal'), mr = modal?.getBoundingClientRect();
            return { onTop: !!mr && !!document.elementFromPoint(mr.left + mr.width / 2, mr.top + 25)?.closest('.hd-modal'), bodyHeight: body?.clientHeight, workspaceHeight: workspace?.clientHeight,
              bottomGap: body && workspace ? Math.abs(body.getBoundingClientRect().bottom - workspace.getBoundingClientRect().bottom) : null,
              emptyIconOffset: iconRect && emptyRect ? Math.abs(iconRect.left + iconRect.width / 2 - emptyRect.left - emptyRect.width / 2) : null,
              searchFocused: document.activeElement === search, searchFocusVisible: search?.matches(':focus-visible'), searchOutline: search && getComputedStyle(search).outlineStyle,
              searchShadow: search && getComputedStyle(search).boxShadow, titleOutline: title && getComputedStyle(title).outlineStyle, titleShadow: title && getComputedStyle(title).boxShadow,
              editorFocusVisible: editor?.matches(':focus-visible'), editorOutline: editor && getComputedStyle(editor).outlineStyle, editorShadow: editor && getComputedStyle(editor).boxShadow };
          })()`);
          else if (action === 'ui-page-leave') result = await evaluate(`(() => { window.__fixtureLeavePage(); return true; })()`);
          else if (action === 'ui-doc-state') result = await evaluate(`(() => {
            const buffer = [...document.querySelectorAll('.hd-buffer')].find(e => e.style.display !== 'none');
            return { entry: !!document.querySelector('[data-editor-open]'), editor: !!document.querySelector('.hd-modal'), buffer: !!buffer, page: document.body.innerText,
              text: window.__fixtureDocumentText().trimEnd(), readOnly: buffer?.querySelector('.cm-content')?.getAttribute('aria-readonly') || 'false', status: buffer?.querySelector('[data-docs-status]')?.textContent || '', statusKey: buffer?.querySelector('[data-docs-status]')?.getAttribute('data-docs-status') || '', saveScope: buffer?.querySelector('[data-docs-save-scope]')?.textContent || '',
              cursors: buffer?.querySelectorAll('.hd-collaborators button').length || 0, snapshots: buffer?.querySelectorAll('.hd-snapshot').length || 0, preview: !!buffer?.querySelector('[data-docs-preview]'),
              cursorWidgets: buffer?.querySelectorAll('.cm-ySelectionCaret').length || 0,
              recovering: !!buffer?.querySelector('[data-docs-recovery]'), review: !!buffer?.querySelector('.hd-review'),
              sidebarVisible: !!document.querySelector('.hd-sidebar')?.getClientRects().length,
              executed: window.__docsExecuted === true, remoteImages: document.querySelectorAll('.hd-preview img').length, unsafeLinks: [...document.querySelectorAll('.hd-preview a[href]')].filter(a=>!/^https?:/.test(a.href)).length,
              errors: [...document.querySelectorAll('.hd-error')].map(e=>e.textContent), overflow: [...document.querySelectorAll('.hd-modal,.hd-toolbar,.hd-actionbar,.hd-statusbar')].filter(e=>e.getClientRects().length && e.scrollWidth>e.clientWidth+2).map(e=>e.className) };
          })()`);
          else if (action === 'lock-file') { await lockFile(); result = true; }
          else if (action === 'unlock-file') { await unlockFile(); result = true; }
          else if (action === 'rescan') { await manager.fileSyncAction(roomId, rootId, 'scan'); result = true; }
          else if (action === 'conflict-preview') result = await manager.prepareFileSyncConflict(roomId, rootId, message.entryId);
          else if (action === 'conflict-resolve') result = await manager.resolveFileSyncConflict(roomId, message.previewId, message.choice);
          else if (action === 'history') result = manager.fileSyncHistory(roomId, rootId, message.entryId);
          else if (action === 'history-fetch') result = await manager.fetchFileSyncHistory(roomId, rootId, message.entryId);
          else if (action === 'net-pause') { await manager.suspendNetworking('file-sync-fixture'); result = true; }
          else if (action === 'net-resume') { await manager.resumeNetworking('file-sync-fixture'); result = true; }
          else if (action === 'journal-state') {
            const base = path.join(working, '.havvn-sync', 'transactions'); result = { pending: 0, applied: 0, rolledBack: 0 };
            for (const id of fs.existsSync(base) ? fs.readdirSync(base).filter(id => /^op-[a-zA-Z0-9]+$/.test(id)) : []) {
              const receipt = path.join(base, id, 'receipt.json');
              if (!fs.existsSync(receipt)) { if (fs.existsSync(path.join(base, id, 'journal.json'))) result.pending++; }
              else { const state = JSON.parse(fs.readFileSync(receipt, 'utf8')).state; if (state === 'applied') result.applied++; else if (state === 'rolled-back') result.rolledBack++; }
            }
          }
          else if (action === 'persisted-room-ids') result = db.getPersistedRooms().map(room => room.roomId);
          else if (action === 'restore') { await manager.restoreAll(); result = true; }
          else if (action === 'roots') result = manager.listFileSyncRoots(roomId);
          else if (action === 'create-root') result = await manager.createFileSyncRoot(roomId, 'Shared fixture', working);
          else if (action === 'bind') { await manager.bindFileSyncRoot(roomId, rootId, working, message.autoApply !== false); result = true; }
          else if (action === 'multipart-tree') {
            const service = manager.fileSyncServices.get(roomId)?.service, root = service?.roots.get(rootId);
            if (!root || root.store.heads().length !== 1) throw Error('Multipart fixture requires one initial file');
            await manager.fileSyncAction(roomId, rootId, 'auto-publish', false); await service.settled();
            const original = root.store.revision(root.store.heads()[0].revisionIds[0]), identity = db.getRoomIdentity();
            const { signSyncRevision } = require('../dist/electron/electron/sharing/room-sync-proofs');
            const records = [], body = fs.readFileSync(path.join(working, 'config.ini'));
            for (let n = 1; n < 2000; n++) {
              const relativePath = `project/${String(n).padStart(4, '0')}/config.ini`, target = path.join(working, ...relativePath.split('/'));
              fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
              records.push({ kind: 'revision', value: signSyncRevision(root.context.scope, { ...original, entryId: require('node:crypto').randomUUID(),
                parents: [], relativePath, createdAt: Date.now() + n }, identity.priv) });
            }
            root.store.acceptRecords(records); result = root.store.heads().length;
          }
          else if (action === 'multipart-sample') {
            const store = manager.fileSyncServices.get(roomId)?.service.roots.get(rootId)?.store;
            if (!store?.binding()) throw Error('Sample requires local consent');
            store.setExclusions(['project']); await manager.fileSyncAction(roomId, rootId, 'auto-apply', true); result = true;
          }
          else if (action === 'publish') { fs.writeFileSync(path.join(working, 'config.ini'), message.body); result = await manager.publishFileSyncFile(roomId, rootId, 'config.ini'); }
          else if (action === 'publish-note') { fs.writeFileSync(path.join(working, 'note.md'), message.body); result = await manager.publishFileSyncFile(roomId, rootId, 'note.md'); }
          else if (action === 'read-note') result = readFixtureText(path.join(working, 'note.md'));
          else if (action === 'edit-note') { fs.writeFileSync(path.join(working, 'note.md'), message.body); result = true; }
          else if (action === 'sync-files') result = manager.fileSyncFiles(roomId, rootId, 0, message.trash === true);
          else if (action === 'missing') result = await manager.fileSyncMissing(roomId, rootId);
          else if (action === 'unlink-path') {
            const { validSyncRelativePath } = require('../dist/electron/shared/room-file-sync'); if (!validSyncRelativePath(message.relativePath)) throw Error('Invalid fixture path');
            const target = path.join(working, ...message.relativePath.split('/')); fs.unlinkSync(target); result = true;
          }
          else if (action === 'delete-preview') result = await manager.prepareFileSyncDelete(roomId, rootId, message.entryId, message.resolve === true);
          else if (action === 'delete-confirm') result = await manager.confirmFileSyncDelete(roomId, message.previewId, message.keepBoth === true);
          else if (action === 'cache-zero') result = await manager.fileSyncCache(roomId, rootId, 0);
          else if (action === 'trash-bytes') {
            const base = path.join(working, '.havvn-sync', 'trash');
            result = fs.existsSync(base) ? fs.readdirSync(base).filter(id => /^op-[a-zA-Z0-9]+$/.test(id)).map(id => path.join(base, id, 'previous')).filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')) : [];
          }
          else if (action === 'sync-view') result = manager.fileSyncView(roomId);
          else if (action === 'rights') result = manager.fileSyncRights(roomId, rootId, message.writers, message.moves);
          else if (action === 'rights-confirm') { await manager.confirmFileSyncRights(roomId, message.previewId); result = true; }
          else if (action === 'move-preview') result = await manager.prepareFileSyncMove(roomId, rootId, message.entryId, message.toPath);
          else if (action === 'move-confirm') { await manager.confirmFileSyncMove(roomId, message.previewId); result = true; }
          else if (action === 'publish-path' || action === 'write-path') {
            const { validSyncRelativePath } = require('../dist/electron/shared/room-file-sync'); if (!validSyncRelativePath(message.relativePath)) throw Error('Invalid fixture path');
            const target = path.join(working, ...message.relativePath.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, message.body);
            result = action === 'publish-path' ? await manager.publishFileSyncFile(roomId, rootId, message.relativePath) : true;
          }
          else if (action === 'log-preview') result = await manager.previewFileSyncLog(roomId, rootId);
          else if (action === 'log-confirm') result = await manager.confirmFileSyncLog(roomId, message.previewId);
          else if (action === 'log-summary') result = manager.fileSyncServices.get(roomId)?.service.roots.get(rootId)?.store.logSummary() ?? null;
          else if (action === 'checkpoint-preview') result = await manager.previewFileSyncCheckpoint(roomId, rootId);
          else if (action === 'checkpoint-confirm') { await manager.confirmFileSyncCheckpoint(roomId, message.previewId); result = true; }
          else if (action === 'checkpoint-state') { const store = manager.fileSyncServices.get(roomId)?.service.roots.get(rootId)?.store; result = store ? { version: store.policy()?.v, records: store.records().length, archives: store.retiredCount(), heads: store.heads().length, pending: store.pendingRecordIds().length, sources: store.sources().length } : null; }
          else if (action === 'metadata-export-inspect') {
            const content = fs.readFileSync(path.join(directory, 'history.havvn-history'), 'utf8');
            const bundle = await require('../dist/electron/electron/db/room-backup').openRoomBackup(content, message.password);
            result = { format: bundle.format, plainNames: content.includes('config.ini'), localPaths: JSON.stringify(bundle).includes(directory) };
          }
          else if (action === 'read-path') { const { validSyncRelativePath } = require('../dist/electron/shared/room-file-sync'); if (!validSyncRelativePath(message.relativePath)) throw Error('Invalid fixture path'); const target = path.join(working, ...message.relativePath.split('/')); result = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null; }
          else if (action === 'restore-preview') result = await manager.prepareFileSyncRestore(roomId, rootId, message.revisionId);
          else if (action === 'restore-confirm') { await manager.confirmFileSyncRestore(roomId, message.previewId); result = true; }
          else if (action === 'auto-apply') result = await manager.fileSyncAction(roomId, rootId, 'auto-apply', message.enabled);
          else if (action === 'auto-publish') result = await manager.fileSyncAction(roomId, rootId, 'auto-publish', message.enabled);
          else if (action === 'publish-existing') {
            const { validSyncRelativePath } = require('../dist/electron/shared/room-file-sync');
            if (!validSyncRelativePath(message.relativePath)) throw Error('Invalid fixture path');
            result = await manager.publishFileSyncFile(roomId, rootId, message.relativePath);
          }
          else if (action === 'ui-writers-all') result = await evaluate(`(() => { for (const input of document.querySelectorAll('.room-sync-panel input[data-sync-writer]')) if (!input.checked && !input.disabled) input.click(); return true; })()`);
          else if (action === 'ui-moves-enable') result = await evaluate(`(() => { const input = document.querySelector('input[data-sync-moves]'); if (!input.checked) input.click(); return true; })()`);
          else if (action === 'ui-deletes-enable') result = await evaluate(`(() => { const input = document.querySelector('input[data-sync-deletes]'); if (!input.checked) input.click(); return true; })()`);
          else if (action === 'ui-move-path') result = await evaluate(`(() => { const input = document.querySelector('input[data-sync-move-path]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(message.value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
          else if (action === 'ui-path-name') result = await evaluate(`(() => { const input = document.querySelector('input[data-sync-path-name]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(message.value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
          else if (action === 'ui-metadata-fields') {
            const values = message.password !== undefined ? [['password', message.password], ['repeat', message.password]] : [['keep', message.keep]];
            for (const [field, value] of values) await evaluate(`(() => { const input = document.querySelector('[data-sync-metadata-${field}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
            result = true;
          }
          else if (action === 'ui-path-open') result = await evaluate(`(() => { const button = document.querySelector('[data-sync-entry="' + ${JSON.stringify(message.entryId)} + '"] [data-sync-path-open]'); if (!button || button.disabled) throw Error('Path control unavailable'); button.click(); return true; })()`);
          else if (action === 'edit-atomic') { const temporary = path.join(working, 'config.ini.tmp'); fs.writeFileSync(temporary, message.body); fs.renameSync(temporary, path.join(working, 'config.ini')); result = true; }
          else if (action === 'ui-open') {
            await uiWindow.loadFile(path.resolve(__dirname, '../dist/room-sync-ui/index.html'), { query: { roomId, surface: message.surface || 'settings', strict: process.env.HAVVN_SYNC_FIXTURE_DOCUMENTS === '1' ? '1' : '0' } });
            if (message.surface === 'files' && !message.launcher && process.env.HAVVN_SYNC_FIXTURE_DOCUMENTS !== '1') {
              const until = Date.now() + 5000; let opened = false;
              while (Date.now() < until) {
                opened = await evaluate(`(() => { const b = document.querySelector('[data-sync-folders-open]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
                if (opened) break; await new Promise(resolve => setTimeout(resolve, 100));
              }
              if (!opened) throw Error('Shared folders launcher unavailable');
            }
            result = true;
          }
          else if (action === 'share-ordinary') {
            const files = Array.from({length: 35}, (_, i) => { const file = path.join(directory, 'shared-' + String(i).padStart(2, '0') + '.txt'); fs.writeFileSync(file, 'ordinary shared file ' + i); return file; });
            await manager.addFiles(roomId, files); result = true;
          }
          else if (action === 'ui-state') result = await evaluate(`({ ready: !!document.querySelector('.room-sync-create input, .room-sync-root, [data-sync-folder]'), preview: !!document.querySelector('.room-sync-panel h3'), text: document.body.innerText,
            trashStorageButton: !!document.querySelector('[data-sync-library-trash-storage]'), trashStorageRows: document.querySelectorAll('[data-sync-trash-storage-row]').length, trashStorageEligible: document.querySelectorAll('[data-sync-trash-storage-select]:not(:disabled)').length, trashStorageConfirmDisabled: document.querySelector('[data-sync-trash-storage-confirm]')?.disabled,
            missingRows: document.querySelectorAll('[data-sync-missing-entry]').length, missingButton: !!document.querySelector('[data-sync-library-missing]'), missingReviewDisabled: document.querySelector('[data-sync-missing-review]')?.disabled,
            metadataRows: document.querySelectorAll('[data-sync-metadata-remove]').length, metadataRemove: document.querySelectorAll('[data-sync-metadata-remove="true"]').length, metadataConfirmDisabled: document.querySelector('[data-sync-metadata-confirm]')?.disabled,
            pathButtons: document.querySelectorAll('[data-sync-path-open]').length, pathVersions: document.querySelectorAll('[data-sync-path-version]').length, pathConfirmDisabled: document.querySelector('[data-sync-path-confirm]')?.disabled,
            deleteButtons: document.querySelectorAll('[data-sync-delete]').length, deleteReview: !!document.querySelector('[data-sync-delete-confirm]'), libraryTrash: !!document.querySelector('[data-sync-library-trash]'),
            libraryRoots: document.querySelectorAll('[data-sync-folder]').length, libraryRows: document.querySelectorAll('[data-sync-entry]').length,
            libraryEditors: document.querySelectorAll('.room-sync-library [data-sync-open-editor]').length,
            libraryConnect: !!document.querySelector('[data-sync-folder-connect]'), settingsOpen: !!document.querySelector('.room-sync-settings[open]'),
            ordinaryRows: document.querySelectorAll('[data-file-id]').length,
            lastOrdinaryVisible: !!document.querySelector('.room-files-virtual > [data-index="34"]'),
            editorText: [...document.querySelectorAll('.room-file-editor-buffer .cm-line')].map(line => line.textContent).join('\\n'),
            editorReadOnly: document.querySelector('.room-file-editor-buffer .cm-content')?.getAttribute('aria-readonly'),
            editorSaveExists: [...document.querySelectorAll('.room-file-editor-modal button')].some(b => b.textContent === 'Сохранить и опубликовать'),
            editorSaveDisabled: [...document.querySelectorAll('.room-file-editor-modal button')].find(b => b.textContent === 'Сохранить и опубликовать')?.disabled,
            editorExecuted: window.__editorExecuted === true,
            editorOnTop: (() => { const editor = document.querySelector('.room-file-editor-modal'); if (!editor) return false; const r = editor.getBoundingClientRect(); return !!document.elementFromPoint(r.x + r.width / 2, r.y + 40)?.closest('.room-file-editor-modal'); })(),
            busy: document.querySelector('.room-sync-panel')?.getAttribute('aria-busy') === 'true', cache: !!document.querySelector('.room-sync-cache'),
            historyRows: document.querySelectorAll('.room-sync-history .room-sync-file').length, historyFetch: !!document.querySelector('[data-sync-history-fetch]'), fileRows: document.querySelectorAll('.room-sync-file').length,
            diffRows: document.querySelectorAll('.room-sync-diff-line').length,
            backupRows: document.querySelectorAll('.room-sync-backup-list .room-sync-file').length, backupRemove: document.querySelectorAll('.room-sync-backup-list .backup-remove').length,
            backupConfirmDisabled: [...document.querySelectorAll('.um-foot button, .room-tool-footer button')].find(b => b.textContent === 'Сохранить настройки и очистить')?.disabled,
            filterRows: document.querySelectorAll('.room-sync-filter-list .room-sync-file').length, filterExcluded: document.querySelectorAll('.room-sync-filter-list .filter-excluded').length,
            filterRuleExcluded: document.querySelectorAll('.room-sync-filter-list [data-reason="rule"]').length,
            filterRules: document.querySelector('.room-sync-filter-editor textarea')?.value,
            filterConfirmDisabled: [...document.querySelectorAll('.um-foot button, .room-tool-footer button')].find(b => b.textContent === 'Сохранить и пересканировать')?.disabled,
            workspaceButtons: document.querySelectorAll('[data-sync-folders-open], [data-editor-open]').length, connectMode: document.querySelector('[data-sync-connect-mode]')?.getAttribute('data-sync-connect-mode'),
            roots: document.querySelectorAll('.room-sync-root').length, switches: document.querySelectorAll('[data-sync-mode-control]').length, conflicts: document.querySelectorAll('.room-sync-file.conflict').length })`);
          else if (action === 'ui-cache-limit') result = await evaluate(`(() => { const input = document.querySelector('.room-sync-cache input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(message.value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
          else if (action === 'ui-backup-settings') {
            for (const [index, field] of ['versions', 'days', 'mib'].entries()) await evaluate(`(() => { const input = document.querySelectorAll('.room-sync-backup-settings input')[${index}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(message[field])}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
            result = true;
          }
          else if (action === 'ui-filter-rules') result = await evaluate(`(() => { const input = document.querySelector('.room-sync-filter-editor textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(message.value)}); input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
          else if (action === 'ui-editor-open') result = await evaluate(`(() => { const row = [...document.querySelectorAll('.room-sync-document, .room-sync-library-file')].find(row => row.querySelector('.room-sync-document-info > span, .room-sync-library-file-name strong')?.firstChild?.textContent === ${JSON.stringify(message.path)}); const b = row?.querySelector('[data-sync-open-editor]'); if (!b || b.disabled) throw Error('Editor control unavailable'); b.click(); return true; })()`);
          else if (action === 'ui-editor-text') {
            // Hidden windows cannot receive the OS shortcut reliably. Exercise CodeMirror's
            // actual keymap in its DOM, then insert through Chromium's native editing path.
            await evaluate(`(() => { const content = document.querySelector('.room-file-editor-buffer .cm-content'); content.focus(); content.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true })); return true; })()`);
            await uiWindow.webContents.insertText(message.body); result = true;
          }
          else if (action === 'ui-history-scroll') result = await evaluate(`(() => { document.querySelector('.room-sync-history').scrollIntoView({block:'end'}); return true; })()`);
          else if (action === 'ui-scroll-files') result = await evaluate(`(() => { const scroll = document.querySelector('.room-files-scroll'); scroll.scrollTop = ${message.bottom ? 'scroll.scrollHeight' : '0'}; return true; })()`);
          else if (action === 'ui-appearance') {
            if (!['dark', 'light'].includes(message.theme)) throw Error('Invalid fixture theme');
            result = await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(message.theme)}`);
          }
          else if (action === 'ui-theme') result = await evaluate(`(() => {
            const tokens = { '--color-bg-primary': '#0b2a3b', '--color-bg-secondary': '#103d53', '--color-bg-tertiary': '#14394a', '--color-bg-elevated': '#18475b',
              '--color-accent-primary': '#5bc9e8', '--color-accent-primary-hover': '#7bddf3', '--color-border-default': '#27647d', '--color-border-strong': '#3d8399',
              '--color-text-primary': '#e0f5ff', '--color-text-secondary': '#b9deed', '--radius-sm': '10px', '--radius-md': '14px', '--radius-lg': '18px', '--clip-cut': 'none' };
            for (const [key,value] of Object.entries(tokens)) document.documentElement.style.setProperty(key,value); return true;
          })()`);
          else if (action === 'ui-layout') result = await evaluate(`(() => {
            const elements = [...document.querySelectorAll('.room-sync-library, .room-sync-modal, .hd-entry')];
            const visible = element => element.getClientRects().length > 0;
            const buttons = elements.flatMap(element => [...element.querySelectorAll('button.btn, .room-sync-library-expand')]).filter(visible);
            const list = document.querySelector('.room-files-virtual'), row = list?.querySelector('[data-file-id]');
            return { overflow: elements.filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className),
              smallButtons: buttons.filter(el => el.getBoundingClientRect().height < (el.closest('.room-sync-modal') ? 33 : 27)).map(el => el.textContent || el.getAttribute('aria-label')),
              clippedSwitches: [...document.querySelectorAll('.room-sync-mode .toggle-switch')].filter(el => { const track = el.getBoundingClientRect(), slider = el.querySelector('.toggle-slider').getBoundingClientRect(); return slider.left < track.left || slider.right > track.right || slider.top < track.top || slider.bottom > track.bottom; }).length,
              rowGap: row && list ? row.getBoundingClientRect().top - list.getBoundingClientRect().top : 0 };
          })()`);
          else if (action === 'ui-click') {
            const target = message.target;
            if (['cache', 'backups', 'filters', 'rights', 'log', 'checkpoint', 'metadata', 'trash-storage'].includes(target)) await evaluate(`(() => { const details = document.querySelector('.room-sync-settings'); if (!details.open) details.querySelector('summary').click(); })()`);
            if (target === 'create') await evaluate(`(() => { const input = document.querySelector('.room-sync-create input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Общие настройки'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
            const selector = { create: '.room-sync-create button', toggle: '[role="switch"]', bind: '[data-sync-action="bind"]', files: '[data-sync-action="files"]',
              history: '[data-sync-entry-history]', cache: '[data-sync-action="cache"]', backups: '[data-sync-action="backups"]', filters: '[data-sync-action="filters"]', 'cache-save': '.room-sync-cache button',
              'library-expand': '[data-sync-folder-expand]', 'library-settings': '[data-sync-folder-settings]', 'library-connect': '[data-sync-folder-connect]', 'settings-expand': '.room-sync-settings summary',
              delete: '[data-sync-delete]', 'delete-confirm': '[data-sync-delete-confirm]', 'delete-keep': '[data-sync-delete-keep]', 'library-trash': '[data-sync-library-trash]',
              'path-review': '[data-sync-path-review]', 'path-confirm': '[data-sync-path-confirm]',
              metadata: '[data-sync-action="metadata"]', 'metadata-review': '[data-sync-metadata-review]', 'metadata-export': '[data-sync-metadata-export]', 'metadata-import': '[data-sync-metadata-import]', 'metadata-confirm': '[data-sync-metadata-confirm]',
              'library-missing': '[data-sync-library-missing]', 'missing-review': '[data-sync-missing-review]', 'missing-ack': '[data-sync-missing-ack]',
              'library-trash-storage': '[data-sync-library-trash-storage]', 'trash-storage': '[data-sync-action="trash-storage"]', 'trash-storage-select': '[data-sync-trash-storage-select]:not(:disabled)', 'trash-storage-review': '[data-sync-trash-storage-review]', 'trash-storage-confirm': '[data-sync-trash-storage-confirm]', 'trash-storage-refresh': '[data-sync-trash-storage-refresh]', 'trash-export': '[data-sync-trash-export]',
              'restore-version': '.room-sync-history .room-sync-file:last-child button:last-child', 'history-fetch': '[data-sync-history-fetch]' }[target];
            if (target === 'toggle') {
              const mode = await evaluate(`(() => { const e = document.querySelector('[data-sync-mode-control]'); return e.dataset.syncMode === 'manual' ? e.dataset.syncWriter === 'true' ? 'send' : 'receive' : 'manual'; })()`);
              await chooseUiMode('[data-sync-mode-control]', mode);
              result = await evaluate(`(() => { const b = document.querySelector('[data-sync-mode-apply]'); if(!b || b.disabled) throw Error('Apply mode unavailable'); b.click(); return true; })()`);
            }
            else if (target === 'settings-close') result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal > .um-foot button, .room-sync-modal > .room-tool-footer button')].find(b => b.textContent === 'Закрыть'); if(!b || b.disabled) throw Error('Close unavailable'); b.click(); return true; })()`);
            else if (target === 'confirm') result = await evaluate(`(() => { const b = document.querySelector('[data-sync-connect-confirm]'); if(!b || b.disabled) throw Error('Confirm unavailable'); b.click(); return true; })()`);
            else if (['checkpoint', 'checkpoint-confirm'].includes(target)) {
              const label = target === 'checkpoint' ? 'Контрольный снимок' : 'Подписать и начать эпоху';
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Checkpoint control unavailable'); b.click(); return true; })()`);
            }
            else if (['log', 'log-confirm'].includes(target)) {
              const label = target === 'log' ? 'Журнал и место' : 'Уплотнить журнал';
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Journal control unavailable'); b.click(); return true; })()`);
            }
            else if (['move', 'move-review', 'move-confirm'].includes(target)) {
              const label = { move: 'Переименовать / переместить', 'move-review': 'Проверить перенос', 'move-confirm': 'Применить перенос' }[target];
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Move control unavailable'); b.click(); return true; })()`);
            }
            else if (['rights', 'rights-review', 'rights-confirm'].includes(target)) {
              const label = { rights: 'Кто может редактировать', 'rights-review': 'Проверить выбранные права', 'rights-confirm': 'Применить права' }[target];
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Rights control unavailable'); b.click(); return true; })()`);
            }
            else if (target.startsWith('editor-')) {
              const label = { 'editor-save': 'Сохранить и опубликовать', 'editor-close': 'Закрыть', 'editor-continue': 'Продолжить редактирование' }[target];
              result = await evaluate(`(() => { const buttons = [...document.querySelectorAll('.room-file-editor-modal .um-foot button, .room-file-editor-modal .room-tool-footer button')]; const b = buttons.find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Editor control unavailable: ' + ${JSON.stringify(target)} + ' / ' + buttons.map(b => b.textContent + ':' + b.disabled).join(', ')); b.click(); return true; })()`);
            }
            else if (target === 'restore-confirm') result = await evaluate(`(() => { const b = [...document.querySelectorAll('.um-foot button, .room-tool-footer button')].find(b => b.textContent.includes('Восстановить и опубликовать')); if(!b || b.disabled) throw Error('Restore unavailable'); b.click(); return true; })()`);
            else if (['backup-review', 'backup-confirm'].includes(target)) {
              const label = target === 'backup-review' ? 'Обновить предпросмотр' : 'Сохранить настройки и очистить';
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Backup control unavailable'); b.click(); return true; })()`);
            }
            else if (['filter-review', 'filter-confirm'].includes(target)) {
              const label = target === 'filter-review' ? 'Пересчитать исключения' : 'Сохранить и пересканировать';
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Filter control unavailable'); b.click(); return true; })()`);
            }
            else if (['review-conflict', 'defer-conflict', 'keep-conflict', 'accept-conflict'].includes(target)) {
              const label = { 'review-conflict': 'Разобрать конфликт', 'defer-conflict': 'Отложить', 'keep-conflict': 'Сохранить обе', 'accept-conflict': 'Принять общую версию' }[target];
              result = await evaluate(`(() => { const b = [...document.querySelectorAll('.room-sync-modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if(!b || b.disabled) throw Error('Conflict control unavailable'); b.click(); return true; })()`);
            }
            else result = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if(!b || b.disabled) throw Error('Control unavailable: ' + ${JSON.stringify(target)}); b.click(); return true; })()`);
          }
          else if (action === 'ui-capture') {
            const evidenceRoot = path.resolve(__dirname, '../dist/room-sync-ui/evidence');
            if (path.dirname(path.resolve(message.destination)) !== evidenceRoot) throw new Error('Invalid evidence path');
            if (!message.keepSize) uiWindow.setSize(message.width, message.height); await new Promise(resolve => setTimeout(resolve, 250));
            await evaluate(`(() => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch { /* Infinite spinners need no final frame. */ } } })()`);
            if (path.basename(message.destination).startsWith('history-')) await evaluate(`(() => { document.querySelector('.room-sync-history')?.scrollIntoView({block:'end'}); })()`);
            if (path.basename(message.destination).startsWith('cache-')) await evaluate(`(() => { document.querySelector('.room-sync-cache')?.scrollIntoView({block:'start'}); })()`);
            await uiWindow.webContents.capturePage(undefined, { stayHidden: true });
            await new Promise(resolve => setTimeout(resolve, 100));
            fs.writeFileSync(message.destination, (await uiWindow.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); result = true;
          }
          else if (action === 'edit') { fs.writeFileSync(path.join(working, 'config.ini'), message.body); result = true; }
          else if (action === 'read') result = readFixtureText(path.join(working, 'config.ini'));
          else if (action === 'local-copies' || action === 'backups') {
            const base = action === 'local-copies' ? path.join(working, '.havvn-local') : path.join(working, '.havvn-sync', 'transactions');
            const name = action === 'local-copies' ? message.name ?? 'config.ini' : 'previous';
            if (!require('../dist/electron/shared/room-file-sync').validSyncName(name)) throw Error('Invalid fixture copy name');
            result = fs.existsSync(base) ? fs.readdirSync(base).filter(id => /^(copy-|op-)[a-zA-Z0-9]+$/.test(id))
              .map(id => path.join(base, id, name)).filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')) : [];
          }
          else if (action === 'inspect') {
            const state = manager.cache.get(roomId), service = manager.fileSyncServices.get(roomId)?.service;
            result = { members: state?.members.length ?? 0, owner: state?.ownerId, connection: state?.connection, ordinaryFiles: state?.files.length ?? 0,
              syncTrace, rootsDetail: [...(service?.roots.values() ?? [])].map(root => ({ rootId: root.context.rootId, heads: root.store.heads(), sources: root.store.sources().map(s => s.revisionId).slice(-8), maintenance: service.maintenance.has(root.context.rootId) })),
              retries: [...(service?.retryAt.keys() ?? [])], syncRoots: service?.list() ?? [] };
          } else if (action === 'stop') { await unlockFile(); manager.destroy(); clearTimeout(deadline); respond({ id: message.id, ok: true, result: true }); setTimeout(() => app.exit(0), 50); return; }
          else throw new Error('Unknown fixture action');
          respond({ id: message.id, ok: true, result });
        } catch (error) { respond({ id: message.id, ok: false, error: message.action + ': ' + String(error) }); }
      });
      });
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(PREFIX + JSON.stringify({ id: 0, ok: true, result: { port: server.address().port } }) + '\n'));
  }).catch(error => { console.error(error); app.exit(1); });
}
