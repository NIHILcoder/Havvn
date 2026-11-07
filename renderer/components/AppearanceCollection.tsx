import React from 'react';
import { APPEARANCE_COLLECTION, collectionProfile } from '../../shared/appearance-collection';
import type { AppearanceProfile } from '../../shared/appearance-profile';
import type { Appearance } from '../../shared/appearance';
import { getActiveTheme } from '../utils/theme-library';
import { useTranslation } from '../utils/i18nContext';
import './AppearanceCollection.css';

export function AppearanceCollection({ background, disabled, onApply }: {
  background: Appearance['background']; disabled: boolean; onApply: (profile: AppearanceProfile) => void;
}) {
  const { t } = useTranslation();
  const active = getActiveTheme();
  return <div className="ap-collection" role="group" aria-label={t('appearance.collection.title')}>
    {APPEARANCE_COLLECTION.map((spec, index) => {
      const selected = background === spec.id && active?.dark['--color-accent-primary'] === spec.dark[6];
      const p = spec.mode === 'light' ? spec.light : spec.dark;
      const name = t(`appearance.collection.${spec.id}.name`);
      const style = { '--scene-surface': p[1], '--scene-ink': p[3], '--scene-accent': p[6],
        '--scene-companion': p[7], '--scene-radius': `${Math.min(spec.radius, 12)}px` } as React.CSSProperties;
      return <button key={spec.id} type="button" className="ap-world" data-scene={spec.id}
        style={style} disabled={disabled} aria-pressed={selected}
        aria-label={`${t('appearance.applyProfile')}: ${name}`} onClick={() => {
          const profile = collectionProfile(spec, name);
          // A visual preset keeps the user's accessibility and density preferences.
          profile.reduceMotion = localStorage.getItem('reduceMotion') === '1';
          profile.density = localStorage.getItem('density') === 'compact' ? 'compact' : 'normal';
          onApply(profile);
        }}>
        <span className="ap-world-art" aria-hidden="true">
          <span className="ap-world-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="ap-world-mode">{t(spec.mode === 'light' ? 'theme.light' : 'theme.dark')}</span>
          <span className="ap-world-window">
            <span className="ap-world-nav"><i /><i /><i /><i /></span>
            <span className="ap-world-content"><i /><span><i /><i /><b /></span></span>
          </span>
          {selected && <span className="ap-world-selected">✓ {t('appearance.collection.active')}</span>}
        </span>
        <span className="ap-world-caption"><strong>{name}</strong>
          <span>{t(`appearance.collection.${spec.id}.description`)}</span>
          <span className="ap-world-footer"><span className="ap-world-swatches" aria-hidden="true">
            <i style={{ background: p[0] }} /><i style={{ background: p[6] }} /><i style={{ background: p[7] }} />
          </span><span>{t(`appearance.collection.${spec.material}`)} · {spec.font === 'mono' ? 'Mono' : spec.font === 'inter' ? 'Inter' : t('appearance.collection.systemFont')}</span></span>
        </span>
      </button>;
    })}
  </div>;
}
