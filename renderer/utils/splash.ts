/** Local, CSP-safe startup controller; shared by the small startup and React entries. */
import { getActiveTheme } from './theme-library';
import { readEffectiveAppearance } from './appearance';

export type SplashStage = 'settings' | 'interface' | 'downloads' | 'ready';
const messages = {
  en: {
    settings: 'Loading settings', interface: 'Preparing the interface', downloads: 'Preparing downloads', ready: 'Ready',
    tagline: 'Your space for downloads and connection', base: 'Havvn',
    heading: 'Starting Havvn', appearance: 'Appearance', footer: 'Your workspace is getting ready',
    stepSettings: 'Settings', stepInterface: 'Interface', stepDownloads: 'Downloads',
    detailSettings: 'Your preferences and appearance', detailInterface: 'Preparing your workspace', detailDownloads: 'Restoring your download list',
    featureDownloads: 'Downloads', featureRooms: 'Rooms', featureWorkspace: 'Shared workspace',
    windowControls: 'Window controls', minimize: 'Minimize', maximize: 'Maximize or restore', close: 'Close',
    slow: 'Startup is taking longer than usual. You can open the logs or reload the window.',
    logs: 'Open logs', reload: 'Reload window', logsError: 'Could not open logs. Please try again.',
  },
  ru: {
    settings: 'Загрузка настроек', interface: 'Подготовка интерфейса', downloads: 'Подготовка загрузок', ready: 'Готово',
    tagline: 'Твоё пространство для загрузок и общения', base: 'Havvn',
    heading: 'Запуск Havvn', appearance: 'Оформление', footer: 'Готовим твоё рабочее пространство',
    stepSettings: 'Настройки', stepInterface: 'Интерфейс', stepDownloads: 'Загрузки',
    detailSettings: 'Твои предпочтения и оформление', detailInterface: 'Подготовка рабочего пространства', detailDownloads: 'Восстановление списка загрузок',
    featureDownloads: 'Загрузки', featureRooms: 'Комнаты', featureWorkspace: 'Совместная работа',
    windowControls: 'Управление окном', minimize: 'Свернуть', maximize: 'Развернуть или восстановить', close: 'Закрыть',
    slow: 'Запуск занимает больше времени, чем обычно. Можно открыть журнал или перезагрузить окно.',
    logs: 'Открыть журнал', reload: 'Перезагрузить окно', logsError: 'Не удалось открыть журнал. Попробуй ещё раз.',
  },
};
let dismissed = false;
let scheduled = false;
let armed = false;
let stage: SplashStage = 'settings';
let slowTimer: number | undefined;
let failsafeTimer: number | undefined;
const MIN_VISIBLE_MS = 450;
const startedAt = Date.now();

function text() { return messages[document.documentElement.lang === 'ru' ? 'ru' : 'en']; }
function splash() { return document.getElementById('th-splash'); }
function label(id: string, value: string): void { const el = document.getElementById(id); if (el) el.textContent = value; }

export function initializeSplash(): void {
  const el = splash();
  if (!el) return;
  const p = readEffectiveAppearance();
  el.dataset.glass = String(p.material !== 'solid' && p.intensity > 0 && p.scopes.includes('dialogs'));
  el.dataset.backdrop = el.dataset.glass === 'true' ? p.background : 'none';
  const t = text();
  label('th-splash-tagline', t.tagline);
  label('th-splash-heading', t.heading);
  label('th-splash-theme-label', t.appearance);
  label('th-splash-footer-label', t.footer);
  for (const [name, title, detail] of [['settings', t.stepSettings, t.detailSettings], ['interface', t.stepInterface, t.detailInterface], ['downloads', t.stepDownloads, t.detailDownloads]]) {
    label(`th-splash-step-${name}-title`, title); label(`th-splash-step-${name}-detail`, detail);
  }
  label('th-splash-feature-downloads', t.featureDownloads);
  label('th-splash-feature-rooms', t.featureRooms);
  label('th-splash-feature-workspace', t.featureWorkspace);
  label('th-splash-theme-name', getActiveTheme()?.name || t.base);
  label('th-splash-slow-text', t.slow);
  label('th-splash-logs', t.logs);
  label('th-splash-reload', t.reload);
  const logs = document.getElementById('th-splash-logs') as HTMLButtonElement | null;
  if (logs) {
    logs.disabled = typeof window.api?.openLogsFolder !== 'function';
    logs.onclick = () => {
      logs.disabled = true;
      void Promise.resolve().then(() => window.api.openLogsFolder()).catch(() => {
        label('th-splash-slow-text', t.logsError);
      }).finally(() => { logs.disabled = false; });
    };
  }
  const reload = document.getElementById('th-splash-reload');
  if (reload) reload.onclick = () => window.location.reload();
  const controls = window.api?.win;
  el.dataset.nativeControls = String(typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || ''));
  document.getElementById('th-splash-window-controls')?.setAttribute('aria-label', t.windowControls);
  const bind = (id: string, title: string, action?: () => void) => {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) { button.disabled = !action; button.title = title; button.setAttribute('aria-label', title); button.onclick = action ?? null; }
  };
  bind('th-splash-minimize', t.minimize, controls?.minimize);
  bind('th-splash-maximize', t.maximize, controls?.toggleMaximize);
  bind('th-splash-close', t.close, controls?.close);
  const header = document.getElementById('th-splash-header');
  if (header) header.ondblclick = event => { if (event.target === header || event.target instanceof Element && !event.target.closest('button')) controls?.toggleMaximize?.(); };
  setSplashStage(stage);
}

/** Labels describe actual milestones, not an estimated startup percentage. */
export function setSplashStage(next: SplashStage): void {
  if (dismissed || scheduled) return;
  stage = next;
  label('th-splash-status', text()[stage]);
  const el = splash();
  if (el) { el.dataset.stage = stage; el.dataset.ready = String(stage === 'ready'); }
  const steps = ['settings', 'interface', 'downloads'] as const;
  const current = stage === 'ready' ? steps.length : steps.indexOf(stage);
  steps.forEach((name, index) => { const step = document.getElementById(`th-splash-step-${name}`); if (step) step.dataset.state = index < current ? 'done' : index === current ? 'active' : 'pending'; });
}

function hideNow(): void {
  if (dismissed) return;
  dismissed = true;
  window.clearTimeout(slowTimer);
  window.clearTimeout(failsafeTimer);
  const el = splash();
  if (!el) return;
  el.classList.add('th-splash-out');
  window.setTimeout(() => el.remove(), 360);
}

/** Idempotent across StrictMode, polling and late engine replies. */
export function dismissSplash(): void {
  if (dismissed || scheduled) return;
  setSplashStage('ready');
  scheduled = true;
  window.clearTimeout(slowTimer);
  window.clearTimeout(failsafeTimer);
  window.setTimeout(hideNow, Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt)));
}

/** An unavailable engine cannot block a mounted UI. A failed mount retains
 * recovery controls rather than revealing an empty black window. */
export function armSplashFailsafe(ms = 6000): void {
  if (armed || dismissed || scheduled) return;
  armed = true;
  const showSlow = () => { const el = document.getElementById('th-splash-slow'); if (el) el.hidden = false; };
  slowTimer = window.setTimeout(showSlow, Math.min(4000, ms));
  failsafeTimer = window.setTimeout(() => {
    if (document.getElementById('root')?.childElementCount) hideNow();
    else showSlow();
  }, ms);
}
