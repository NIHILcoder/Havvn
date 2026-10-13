/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS fixture initializes API before loading the product entry. */
// Synthetic IPC boundary, actual App/pages/rows/player. No user's profile/network.
const React = require('react');
const { createRoot } = require('react-dom/client');
window.__perf = { renders: {}, commits: [], calls: {}, listeners: new Map(), tick: 0, lag: [], tickMs: [] };
const perf = window.__perf;
const idle = !!window.__perfIdle;
localStorage.setItem('onboarded', '1'); localStorage.setItem('language', 'en');
localStorage.setItem('reduceMotion', idle ? '0' : '1'); localStorage.setItem('theme', 'dark');
const now = Date.now();
const downloads = Array.from({ length: idle ? 3 : 1000 }, (_, i) => ({
  id: String(i), name: 'Fixture ' + String(i).padStart(4, '0') + '.webm', sourceType: 'magnet',
  sourceUri: '', torrentFilePath: null, savePath: '', status: idle ? 'paused' : 'downloading', progress: .2,
  downloadedBytes: 200000, uploadedBytes: 10000, downSpeedBps: idle ? 0 : 1000, upSpeedBps: idle ? 0 : 100,
  etaSeconds: 10, peers: 2, seeds: 1, totalSize: 1000000, priority: 1, category: null,
  createdAt: new Date(now - i * 1000), updatedAt: new Date(now), lastError: null,
}));
let room = {
  roomId: 'fixture', name: 'Performance room', ownerId: 'self', e2e: false, connected: true,
  members: [{ memberId: 'self', name: 'Self', avatarSeed: 'self', isSelf: true, online: true, have: [] }],
  files: Array.from({ length: 1000 }, (_, i) => ({ fileId: String(i), name: 'File ' + i + '.bin',
    size: 1000000, magnet: '', addedBy: 'self', addedAt: now, memberId: 'self' })),
  folders: [], history: [], chat: Array.from({ length: 200 }, (_, i) => ({ id: String(i),
    memberId: 'self', name: 'Self', text: 'Synthetic message ' + i, at: now - i * 1000 })),
  transfers: {}, peerCount: 0, autoFetch: false, upKbps: 0, downKbps: 0,
  voice: { inVoice: false, muted: false, deafened: false, transmitting: false, inputMode: 'vad', sharing: false, participants: [] },
  lan: { active: false, participants: [], status: 'idle' },
};
const summary = { roomId: room.roomId, name: room.name, e2e: false, memberCount: 1,
  onlineCount: 1, fileCount: 1000, unread: 0, autoFetch: false, ownerId: 'self' };
const values = {
  getDownloads: () => structuredClone(downloads), getCategories: () => [],
  getCompletionAction: () => ({ action: 'none', pending: null, available: ['none', 'quit'] }),
  getAltSpeed: () => ({ altSpeedEnabled: false }), getSettings: () => ({}),
  'rooms.list': () => [summary], 'rooms.get': () => room,
  'rooms.getProfile': () => ({ memberId: 'self', name: 'Self', avatarSeed: 'self' }),
  'rooms.engineStatus': () => ({ state: 'running' }), 'rooms.servers.state': () => ({ instances: [], modules: [] }),
  'win.isMaximized': () => false, 'win.isFullscreen': () => false,
  getTorrentFiles: () => [{ index: 0, name: 'movie.webm', path: 'movie.webm', length: 1000000, progress: 1 }],
  getStreamUrl: () => ({ url: './clip.webm', kind: 'video', transcoded: false }),
  'audioTracks.list': () => [], 'subtitles.list': () => [], 'subtitles.get': () => null,
  getEpisodePrefetchSupport: () => ({ supported: false }), 'historyPlayback.files': () => [],
};
function api(parts = []) {
  return new Proxy(function () {}, { get(_target, key) { if (key === 'then') return undefined; return api([...parts, key]); },
    apply(_target, _receiver, args) {
      const name = parts.join('.'); perf.calls[name] = (perf.calls[name] || 0) + 1;
      if (/^on[A-Z]/.test(parts.at(-1))) {
        const set = perf.listeners.get(name) || new Set(); perf.listeners.set(name, set); set.add(args[0]);
        return () => set.delete(args[0]);
      }
      if (values[name]) return Promise.resolve(values[name](...args));
      return Promise.resolve({});
    },
  });
}
window.api = api();
const App = require('../renderer/App').default;
require('../renderer/index.css');
const view = createRoot(document.getElementById('root'));
view.render(React.createElement(React.Profiler, { id: 'app', onRender: (_id, _phase, duration) => perf.commits.push(duration) }, React.createElement(App)));
window.perfEmit = (name, payload) => { for (const f of perf.listeners.get(name) || []) f(payload); };
window.perfTick = () => {
  const started = performance.now();
  const tick = ++perf.tick;
  // One changed row per tick; all other entries are fresh IPC objects with equal values.
  window.perfEmit('onDownloadStats', downloads.map((d, i) => ({ id: d.id, progress: i === 0 ? .2 + tick / 100000 : .2,
    downloadedBytes: i === 0 ? 200000 + tick : 200000, uploadedBytes: 10000,
    downSpeedBps: i === 0 ? 1000 + tick % 2 : 1000, upSpeedBps: 100, etaSeconds: 10, peers: 2, seeds: 1, status: 'downloading' })));
  perf.tickMs.push(performance.now() - started);
};
window.perfRoomTick = () => {
  room = { ...room, transfers: { '0': { progress: ++perf.tick / 10000, downSpeedBps: 1000, upSpeedBps: 0, haveLocally: false } } };
  window.perfEmit('onRoomUpdate', room);
};
window.perfNavigate = page => document.dispatchEvent(new KeyboardEvent('keydown', { code: page === 'rooms' ? 'Digit2' : 'Digit1', ctrlKey: true, bubbles: true }));
if (!idle) {
  let expected = performance.now() + 25;
  setInterval(() => { const now = performance.now(); perf.lag.push(Math.max(0, now - expected)); expected = now + 25; }, 25);
}
window.perfAppearance = preset => {
  const appearance = require('../renderer/utils/appearance');
  appearance.applyThemeGlass(undefined);
  appearance.paintAppearance(require('../shared/appearance').APPEARANCE_PRESETS[preset]);
};
window.perfReset = () => { perf.renders = {}; perf.commits = []; perf.lag = []; perf.calls = {}; perf.tickMs = []; };
window.perfResult = () => ({ renders: perf.renders, commits: perf.commits, lag: perf.lag, tickMs: perf.tickMs, calls: perf.calls,
  listeners: (perf.listeners.get('onDownloadStats') || new Set()).size,
  rows: document.querySelectorAll('.download-item').length, roomFiles: document.querySelectorAll('.room-file').length });
window.perfSetStatus = (id, status) => {
  downloads[Number(id)].status = status;
  window.perfEmit('onDownloadStats', downloads.map(d => ({ ...d, progress: d.status === 'seeding' ? 1 : d.progress })));
};
