import React from 'react';
import { ENGINE_FEATURES, type EngineCapabilities } from '../../shared/engine-capabilities';
import { useTranslation } from '../utils/i18nContext';
import './EngineCapabilitiesSummary.css';

export function EngineCapabilitiesSummary({ capabilities, failed }: { capabilities: EngineCapabilities | null; failed: boolean }) {
  const { t } = useTranslation();
  return <div className="engine-capabilities" data-engine-capabilities={capabilities?.engine ?? 'unknown'}>
    <p>{capabilities ? `${t('engineFeatures.session')}: ${t(capabilities.engine === 'native' ? 'settings.engine.nativeWord' : 'settings.engine.classic')}` : t(failed ? 'engineFeatures.unknown' : 'common.loading')}</p>
    {capabilities && <dl>{ENGINE_FEATURES.map(feature => <div key={feature}>
      <dt>{t(`engineFeatures.feature.${feature}`)}</dt>
      <dd>{t(capabilities.features[feature].supported ? 'engineFeatures.supported' : 'engineFeatures.unsupported')}
        {!capabilities.features[feature].supported && <span>{t(`engineFeatures.reason.${capabilities.features[feature].reason}`)}</span>}
      </dd>
    </div>)}</dl>}
  </div>;
}
