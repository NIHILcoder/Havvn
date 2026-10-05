// A small shared entry runs before React/fonts/dictionaries. No inline JS: the
// packaged CSP permits only local scripts. Both entries share webpack's runtime.
import { bootApplyActiveTheme, resolvedMode } from './utils/theme-library';
import { restoreThemePrefs } from './utils/theme-prefs';
import { initializeSplash, setSplashStage, armSplashFailsafe } from './utils/splash';
import './styles/variables.css';

try {
  document.documentElement.dataset.theme = resolvedMode();
  document.documentElement.lang = localStorage.getItem('language') === 'ru' ? 'ru' : 'en';
  if (localStorage.getItem('reduceMotion') === '1') document.documentElement.dataset.reduceMotion = 'true';
  bootApplyActiveTheme();
  restoreThemePrefs();
} catch { /* Cosmetic storage failure must not block startup. */ }
initializeSplash();
setSplashStage('settings');
armSplashFailsafe();
