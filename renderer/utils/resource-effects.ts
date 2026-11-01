import { RESOURCE_ECONOMY } from '../../shared/resource-mode';
import { downloadsModel } from '../state/downloads';
import { paintAppearance, readAppearance } from './appearance';
import { resourceMode } from './resource-mode';

export function bootResourceEffects(): () => void {
  const apply = () => {
    downloadsModel.setStatsInterval(resourceMode.getSnapshot().snapshot.economy ? RESOURCE_ECONOMY.statsIntervalMs : 0);
    paintAppearance(readAppearance());
  };
  const off = resourceMode.subscribe(apply); const release = resourceMode.retain(); apply();
  const refresh = () => { void resourceMode.refresh(); };
  window.addEventListener('havvn:settings-transfer', refresh);
  return () => { window.removeEventListener('havvn:settings-transfer', refresh); off(); release(); downloadsModel.setStatsInterval(0); };
}
