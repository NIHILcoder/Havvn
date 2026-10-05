/** Local, CSP-safe startup controller; shared by the small startup and React entries. */
import { getActiveTheme } from './theme-library';
import { readEffectiveAppearance } from './appearance';

export type SplashStage = 'settings' | 'interface' | 'downloads' | 'ready';
const messages = {
  en: {
    settings: 'Loading settings', interface: 'Preparing the interface', downloads: 'Preparing downloads', ready: 'Ready',
    tagline: 'Your space for downloads and connection', base: 'Havvn',
    slow: 'Startup is taking longer than usual. You can open the logs or reload the window.',
    logs: 'Open logs', reload: 'Reload window', logsError: 'Could not open logs. Please try again.',
  },
  ru: {
    settings: 'Загрузка настроек', interface: 'Подготовка интерфейса', downloads: 'Подготовка загрузок', ready: 'Готово',
    tagline: 'Твоё пространство для загрузок и общения', base: 'Havvn',
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
  setSplashStage(stage);
}

/** Labels describe actual milestones, not an estimated startup percentage. */
export function setSplashStage(next: SplashStage): void {
  if (dismissed || scheduled) return;
  stage = next;
  label('th-splash-status', text()[stage]);
  const el = splash();
  if (el) { el.dataset.stage = stage; el.dataset.ready = String(stage === 'ready'); }
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
