// Loaded only by smoke-download-layout.cjs in an isolated Electron renderer.
var fs = require('node:fs'), path = require('node:path');
var ts = require(path.join(fixtureRoot, 'node_modules/typescript'));
var React = require(path.join(fixtureRoot, 'node_modules/react'));
var dom = require(path.join(fixtureRoot, 'node_modules/react-dom'));
var createRoot = require(path.join(fixtureRoot, 'node_modules/react-dom/client')).createRoot;
var dict = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'renderer/i18n/ru.json'), 'utf8'));
var t = key => dict[key] || key, cache = {}, components;
function load(file) {
  if (cache[file]) return cache[file].exports;
  var mod = { exports: {} }; cache[file] = mod;
  var js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', js)(name => {
    if (name.endsWith('.css')) return {};
    if (name.includes('i18nContext')) return { useTranslation: () => ({ t, language: 'ru' }) };
    if (name.includes('ConfirmDialog')) return { useConfirm: () => ({ confirm: async () => false }) };
    if (name.includes('useCategories')) return { useCategories: () => [], categoryLabel: () => '' };
    if (name.endsWith('/components')) return components;
    if (name.startsWith('.')) {
      var target = path.resolve(path.dirname(file), name);
      for (var ext of ['.tsx', '.ts']) if (fs.existsSync(target + ext)) return load(target + ext);
      throw Error('Missing fixture import: ' + target);
    }
    return require(name.startsWith('node:') ? name : path.join(fixtureRoot, 'node_modules', name));
  }, mod, mod.exports);
  return mod.exports;
}
localStorage.setItem('language', 'ru');
load(path.join(fixtureRoot, 'renderer/utils/error-messages.ts')).registerErrorTranslations('ru', dict);
// The list, rows, store, virtualizer and visible controls are production code.
// Closed dialogs and unrelated category/translation providers are fixture seams.
components = Object.assign({
  ToastContainer: () => null,
  useConfirm: () => ({ confirm: async () => false }),
}, ...['Button', 'Icon', 'ProgressBar', 'Badge', 'HealthBadge', 'DropdownMenu', 'EmptyState']
  .map(name => load(path.join(fixtureRoot, 'renderer/components/' + name + '.tsx'))));
var titles = ['Ubuntu 24.04 LTS.iso', 'Записи поездки · октябрь.mkv', 'Архив проекта.zip',
  'Музыкальная коллекция.flac', 'Материалы для монтажа.zip', 'Документы и фотографии.zip'];
var states = ['downloading', 'seeding', 'paused', 'completed', 'error', 'queued'];
var fixtureRows = Array.from({ length: 80 }, (_, index) => ({
  id: 'fixture-' + index, name: titles[index % titles.length] + (index >= 6 ? ' · ' + index : ''),
  sourceType: 'magnet', sourceUri: 'magnet:?xt=fixture-' + index, torrentFilePath: null,
  savePath: 'D:/Downloads', status: states[index % states.length], progress: [0.42, 1, 0.68, 1, 0.16, 0][index % 6],
  totalSize: (index + 1) * 1073741824, downloadedBytes: 450971566, uploadedBytes: 134217728,
  downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0, priority: 1, category: null,
  createdAt: new Date(1735689600000 - index * 1000), updatedAt: new Date(1735689600000),
  lastError: index % 6 === 4 ? 'Соединение с трекером временно недоступно.' : null,
}));
var pulls = 0, statsListener;
window.api = {
  getDownloads: async () => { pulls++; return fixtureRows.map(row => ({ ...row })); },
  onDownloadStats: listener => { statsListener = listener; return () => { statsListener = undefined; }; },
  getCompletionAction: async () => ({ action: 'none', available: ['none', 'sleep', 'shutdown', 'quit'] }),
  onCompletionActionChanged: () => () => {},
  getAltSpeed: async () => ({ altSpeedEnabled: false }),
  getSettings: async () => ({ clipboardWatchEnabled: true }),
};
var model = load(path.join(fixtureRoot, 'renderer/state/downloads.ts')).downloadsModel;
var Page = load(path.join(fixtureRoot, 'renderer/pages/DownloadsPage.tsx')).default;
var tree = createRoot(document.querySelector('#root'));
dom.flushSync(() => tree.render(React.createElement(Page)));
window.layout = () => {
  var rows = [...document.querySelectorAll('.downloads-vrow')].map(row => {
    var bounds = row.getBoundingClientRect(), item = row.firstElementChild;
    return { index: Number(row.dataset.index), top: bounds.top, bottom: bounds.bottom,
      height: bounds.height, detailed: item.classList.contains('download-item-detailed'),
      name: row.querySelector('.download-item-name,.trow-name')?.textContent };
  });
  return { rows, compact: !!document.querySelector('.downloads-list-compact'),
    scrollHeight: document.querySelector('.downloads-scroll')?.scrollHeight,
    scrollTop: document.querySelector('.downloads-scroll')?.scrollTop };
};
window.mode = value => {
  dom.flushSync(() => [...document.querySelectorAll('.page-actions button')].find(button => button.textContent.trim() === t('downloads.tools')).click());
  dom.flushSync(() => [...document.querySelectorAll('[role=menuitem]')].find(item => item.textContent.trim() === t('downloads.' + value + 'View')).click());
};
window.expand = index => dom.flushSync(() => {
  var toggle = document.querySelector('.downloads-vrow[data-index="' + index + '"] .trow-main');
  if (!toggle) throw Error('Missing compact row ' + index);
  toggle.click();
});
window.toggleModeKey = () => dom.flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true })));
window.scrollList = value => { document.querySelector('.downloads-scroll').scrollTop = value; };
window.pushStats = () => statsListener(fixtureRows.map(row => ({
  id: row.id, status: row.status, progress: row.id === 'fixture-0' ? 0.73 : row.progress,
  downloadedBytes: row.downloadedBytes, uploadedBytes: row.uploadedBytes,
  downSpeedBps: row.status === 'downloading' ? 6291456 : 0, upSpeedBps: row.status === 'seeding' ? 2097152 : 0,
  etaSeconds: 190, peers: 12, seeds: 8,
})));
window.pushOperation = (activity, status = 'downloading') => {
  var project = load(path.join(fixtureRoot, 'shared/download-operation.ts')).downloadOperation;
  statsListener(fixtureRows.map((row, index) => ({
    id: row.id, status: index === 0 ? status : row.status, progress: index === 0 ? .9 : row.progress,
    downloadedBytes: row.downloadedBytes, uploadedBytes: row.uploadedBytes,
    downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0,
    ...(index === 0 ? { operation: project({ ...row, status }, activity) } : {}),
  })));
};
window.longError = () => {
  fixtureRows = fixtureRows.map(row => row.id === 'fixture-0' ? { ...row, status: 'error',
    lastError: 'Не удалось соединиться с трекером. '.repeat(14) } : row);
  return model.refresh();
};
window.removeFirst = () => {
  fixtureRows = fixtureRows.slice(1);
  dom.flushSync(() => model.updateDownloads(() => fixtureRows));
};
var palette = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'themes/nihil-aero-midnight.havvn-theme.json'), 'utf8')).dark;
for (var [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value);
