/**
 * Settings navigation rail — grouped sections with a live search that filters by
 * label + keywords, so you can find a setting without knowing its tab.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Icon, LogoMark } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { SETTINGS_GROUPS, SETTINGS_NAV } from './nav';
import { SETTINGS_SEARCH_ENTRIES } from './settingsSearchCatalog';
import { normalizeSettingsSearch, searchSettings, type SettingSearchResult } from './settingsSearch';
import './SettingsNav.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TKey = any;

export const SettingsNav: React.FC<{
  active: string;
  onSelect: (id: string) => void;
  onSelectSetting?: (result: SettingSearchResult) => void;
}> = ({ active, onSelect, onSelectSetting }) => {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const navigation = useRef<HTMLElement>(null);
  const query = normalizeSettingsSearch(q);
  const results = searchSettings(SETTINGS_SEARCH_ENTRIES, query, t);

  const matches = (id: string, keywords: string) => {
    if (!query) return true;
    const text = normalizeSettingsSearch(t(`settings.${id}` as TKey) + ' ' + keywords);
    return query.split(' ').every(term => text.includes(term));
  };
  const visible = SETTINGS_NAV.filter((i) => matches(i.id, i.keywords));
  const selectSetting = (result: SettingSearchResult) => {
    if (onSelectSetting) onSelectSetting(result);
    else onSelect(result.section);
  };
  useEffect(() => {
    navigation.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <aside className={`stg-nav${query ? ' stg-nav--searching' : ''}`}>
      <div className="stg-nav-head">
        <LogoMark size={24} />
        <h2>{t('nav.settings')}</h2>
      </div>

      <div className="stg-nav-search">
        <Icon name="search" size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); setQ(''); }
            else if (event.key === 'Enter' && query) {
              if (results[0]) {
                event.preventDefault();
                selectSetting(results[0]);
              } else if (visible[0]) {
                event.preventDefault();
                onSelect(visible[0].id);
              }
            }
          }}
          placeholder={t('settings.searchPlaceholder')}
          aria-label={t('settings.searchPlaceholder')}
        />
        {q && (
          <button className="stg-nav-clear" onClick={() => setQ('')} aria-label={t('settings.clearSearch')}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>

      <nav className="stg-nav-list" aria-label={t('nav.settings')} ref={navigation}>
        {!results.length && !visible.length && <p className="stg-nav-empty">{t('settings.searchEmpty')}</p>}
        {results.map(result => (
          <button type="button" key={`${result.section}:${result.labelKey}`} className="stg-nav-result" onClick={() => selectSetting(result)}>
            <span>{result.label}</span>
            <small title={result.description || undefined}>{t(`settings.${result.section}` as TKey)}</small>
          </button>
        ))}
        {SETTINGS_GROUPS.map((g) => {
          const items = visible.filter((i) => i.group === g);
          if (!items.length) return null;
          return (
            <div key={g} className="stg-nav-grp">
              <div className="stg-nav-grp-h">{t(`settings.group.${g}` as TKey)}</div>
              {items.map((item) => (
                <div key={item.id} className="stg-nav-section">
                  <button
                    className={`stg-nav-item${active === item.id ? ' on' : ''}`}
                    aria-current={active === item.id ? 'page' : undefined}
                    onClick={() => onSelect(item.id)}
                  >
                    <Icon name={item.icon} size={16} />
                    <span className="stg-nav-item-label">{t(`settings.${item.id}` as TKey)}</span>
                    {active === item.id && <span className="stg-nav-dot" />}
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
};
