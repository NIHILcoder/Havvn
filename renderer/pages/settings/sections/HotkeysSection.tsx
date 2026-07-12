/**
 * Hotkeys settings section — wraps the keybinding editor (which existed for a
 * long time but was never rendered anywhere) in the shared card primitive.
 * Persistence goes through utils/hotkeys.ts, whose save/reset dispatch a
 * window event so App.tsx's global keydown handler picks up edits live.
 */
import React, { useState } from 'react';
import { HotkeySettings } from '../../../components';
import { SettingsCard } from '../controls';
import { useTranslation } from '../../../utils/i18nContext';
import { loadHotkeys, saveHotkeys, resetHotkeys } from '../../../utils/hotkeys';

export const HotkeysSection: React.FC = () => {
  const { t } = useTranslation();
  const [hotkeys, setHotkeys] = useState(loadHotkeys);

  const handleHotkeyChange = (hotkeyId: string, keys: string[]) => {
    const next = hotkeys.map((h) => (h.id === hotkeyId ? { ...h, keys } : h));
    setHotkeys(next);
    saveHotkeys(next);
  };

  const handleReset = () => {
    setHotkeys(resetHotkeys());
  };

  return (
    <SettingsCard title={t('hotkeys.title')} icon="keyboard" description={t('hotkeys.subtitle')}>
      <HotkeySettings
        hotkeys={hotkeys}
        onHotkeyChange={handleHotkeyChange}
        onResetHotkeys={handleReset}
      />
    </SettingsCard>
  );
};
