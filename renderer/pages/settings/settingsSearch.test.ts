import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import ru from '../../i18n/ru.json';
import { SETTINGS_SEARCH_ENTRIES } from './settingsSearchCatalog';
import { normalizeSettingsSearch, searchSettings } from './settingsSearch';

describe('search individual settings', () => {
  it('finds a parameter by its name even when the category has no matching words', () => {
    const result = searchSettings(SETTINGS_SEARCH_ENTRIES, 'автозапуск', key => ru[key]);
    expect(result.some(item => item.section === 'general' && item.labelKey === 'settings.autoLaunch' && item.kind === 'row')).toBe(true);
  });
  it('ranks an exact parameter name before related description matches', () => {
    const results = searchSettings(SETTINGS_SEARCH_ENTRIES, en['settings.upSpeed'], key => en[key]);
    expect(results[0].labelKey).toBe('settings.upSpeed');
    expect(results[0].section).toBe('connection');
  });
  it('finds a parameter from words in its description', () => {
    const text = en['settings.closeTray.desc'];
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, text, key => en[key]).some(item => item.labelKey === 'settings.closeTray')).toBe(true);
  });
  it('matches multiple words regardless of order or repeated spaces', () => {
    const label = ru['settings.maxConnGlobal'];
    const words = label.split(/\s+/).reverse().join('   ');
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, words, key => ru[key]).some(item => item.labelKey === 'settings.maxConnGlobal')).toBe(true);
  });
  it('normalizes Russian ё, case and whitespace without changing source labels', () => {
    expect(normalizeSettingsSearch('  ПРИЁМ  ФАЙЛОВ  ')).toBe('прием файлов');
    const results = searchSettings(SETTINGS_SEARCH_ENTRIES, '  ' + ru['settings.theme'].toUpperCase() + ' ', key => ru[key]);
    expect(results.some(item => item.label === ru['settings.theme'])).toBe(true);
  });
  it('includes hotkeys and nested appearance parameters, and rejects missing/empty queries', () => {
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, 'VLC', key => en[key]).some(item => item.labelKey === 'external.choose' && item.kind === 'control')).toBe(true);
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, en['hotkeys.voiceMute'], key => en[key]).some(item => item.section === 'hotkeys' && item.labelKey === 'hotkeys.voiceMute')).toBe(true);
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, en['appearance.backgroundDim'], key => en[key]).some(item => item.section === 'interface')).toBe(true);
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, 'nonexistent-parameter-83921', key => en[key])).toEqual([]);
    expect(searchSettings(SETTINGS_SEARCH_ENTRIES, '', key => en[key])).toEqual([]);
  });
});
