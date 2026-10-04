import { ServerPanelStatus, useServerPanelData } from './useServerPanelData';
/**
 * Settings form, generated from the module's ConfigField descriptors.
 *
 * WHY DESCRIPTORS RATHER THAN PER-GAME REACT: a game module ships plain data and
 * gets a form that already obeys this app's theming, its dock realm rules and
 * its advanced/warn conventions. A second module needs no UI code at all, and
 * cannot accidentally reintroduce the portal and container-type bugs that this
 * folder has already solved once.
 *
 * The controls themselves live in ServerConfigField, shared with the create form —
 * which asks for a few of these same settings before the first boot and must ask
 * with the same ranges, the same translations and the same warnings.
 */
import { Button } from '../../components/Button';
import React, { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import { useHostToast } from '../../utils/hostToast';
import { ServerConfigField, validServerConfigValue } from './ServerConfigField';
import { useServerError } from './serverErrors';
import type { ConfigField } from '../../../shared/types';

interface ServerConfigFormProps {
  instanceId: string;
  /** A live server reads its config at boot, so editing it now would show
   *  settings that are not actually in effect. */
  locked: boolean;
}

export const ServerConfigForm: React.FC<ServerConfigFormProps> = ({ instanceId, locked }) => {
  const { t } = useTranslation();
  const toast = useHostToast();
  const errorText = useServerError();

  const [schema, setSchema] = useState<ConfigField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  /** The last committed values, so Revert can put an edited form back without a
   *  round trip — and without the user having to guess what they changed. */
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const valid = schema.every(field => validServerConfigValue(field, values[field.key] ?? ''));

  const load = useCallback(() => window.api.rooms.servers.getConfig(instanceId), [instanceId]);
  const { data, loading, error, reload, ready } = useServerPanelData(load);
  useEffect(() => {
    if (!data) return;
    setSchema(data.schema); setValues(data.values); setSaved(data.values); setDirty(false);
  }, [data]);

  const set = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (saving || locked || !ready || !valid) return;
    setSaving(true);
    try {
      await window.api.rooms.servers.saveConfig(instanceId, values);
      setSaved(values);
      setDirty(false);
      toast.success(t('rooms.server.settingsSaved'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }, [errorText, instanceId, t, toast, values, saving, locked, ready, valid]);

  const basic = schema.filter((f) => !f.advanced);
  const advanced = schema.filter((f) => f.advanced);

  const renderField = (field: ConfigField): React.ReactNode => (
    <ServerConfigField
      key={field.key}
      field={field}
      value={values[field.key] ?? ''}
      disabled={locked || saving}
      idPrefix={`cfg-${instanceId}`}
      onChange={(v) => set(field.key, v)}
    />
  );

  if (!ready) return <ServerPanelStatus loading={loading} error={error} reload={reload} />;

  return (
    <div className="server-config">
      {/* The fields scroll, Save does not: a settings pane whose only commit
          button is below the fold reads as one that cannot be committed. */}
      <div className="server-config-scroll">
        {locked && (
          <p className="server-config-locked">
            <Icon name="lock" size={12} />
            {t('rooms.server.stopFirst')}
          </p>
        )}

        {basic.map(renderField)}

        {advanced.length > 0 && (
          <>
            <div className="server-config-advanced">
              <Button size="sm"
                type="button"
                className="server-config-advanced-toggle"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={12} />
                {t('rooms.server.advanced')}
              </Button>
            </div>
            {showAdvanced && advanced.map(renderField)}
          </>
        )}
      </div>

      <div className="server-config-foot">
        {dirty && !locked && <span className="server-config-dirty">{t('rooms.server.unsaved')}</span>}
        {dirty && !locked && (
          <Button size="sm"
            type="button"
            className="room-server-btn"
            disabled={saving}
            onClick={() => { setValues(saved); setDirty(false); }}
          >
            {t('rooms.server.revert')}
          </Button>
        )}
        <Button size="sm"
          type="button"
          variant="primary" className="room-server-primary" loading={saving}
          disabled={locked || !dirty || !valid}
          onClick={() => void save()}
        >
          <Icon name="check" size={13} />
          {t('rooms.server.saveSettings')}
        </Button>
      </div>
    </div>
  );
};
