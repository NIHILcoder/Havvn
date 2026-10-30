import React from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { roomConnectionHelp, type RoomNetworkProbe } from '../../shared/room-connection-help';
import type { RoomDiagnosticReport } from '../../shared/room-diagnostics';

export function RoomConnectionHelp({ report, probe, checking, disabled, onCheck }: { report: RoomDiagnosticReport; probe: RoomNetworkProbe | null; checking: boolean; disabled: boolean; onCheck(): void }) {
  const { t } = useTranslation(), help = roomConnectionHelp(report), c = report.connection;
  return <section className="room-connection-help" aria-label={t('rooms.help.title')}>
    <h3><Icon name="network" size={16} />{t('rooms.help.title')}</h3>
    <p className="room-connection-next" role="status">{t(`rooms.help.next.${help}`)}</p>
    <ol className="room-connection-steps">
      <li><strong>{t('rooms.help.discovery')}</strong><span>{t('rooms.help.discoveryResult').replace('{ok}', String(c.trackers.acknowledged)).replace('{total}', String(c.trackers.configured))}</span><small>{t('rooms.help.discoveryHint')}</small></li>
      <li><strong>{t('rooms.help.channel')}</strong><span>{t('rooms.help.channelResult').replace('{open}', String(c.channels.identified)).replace('{pending}', String(c.channels.pending))}</span><small>{t(c.channels.identified > 0 ? 'rooms.help.pathResult' : 'rooms.help.channelUnknown').replace('{direct}', String(c.channels.direct)).replace('{turn}', String(c.channels.turn)).replace('{relay}', String(report.people.viaPeerRelay))}</small></li>
      <li><strong>{t('rooms.diag.voice')}</strong><span>{t(!report.voice.joined ? 'rooms.help.voiceNotJoined' : report.voice.failed ? 'rooms.help.voiceFailed' : report.voice.connected ? 'rooms.help.voiceConnected' : 'rooms.help.voiceWaiting')}</span><small>{t('rooms.help.voiceHint')}</small></li>
    </ol>
    <div className="room-connection-check"><Button variant="secondary" size="sm" loading={checking} disabled={disabled} onClick={onCheck}>{t('rooms.help.check')}</Button><span>{t('rooms.help.checkHint')}</span></div>
    {probe && <div className="room-connection-probes">
      <p>{t('rooms.help.checkedAt')} {new Date(probe.checkedAt).toLocaleTimeString()}</p>
      <ul>{probe.endpoints.map(endpoint => <li key={endpoint.index}><strong>{t('rooms.help.server')} {endpoint.index + 1}</strong><div>{(['dns', 'tcp', 'tls', 'websocket'] as const).map(stage => <span key={stage} data-probe-state={endpoint[stage]}>{t(`rooms.help.stage.${stage}`)}: {t(`rooms.help.state.${endpoint[stage]}`)}</span>)}</div></li>)}</ul>
      {!probe.endpoints.length && <p>{t('rooms.help.noEndpoints')}</p>}
      <p>{t(probe.customDiscovery ? 'rooms.help.customDiscovery' : 'rooms.help.defaultDiscovery')} · {t(!probe.turnEnabled ? 'rooms.help.turnOff' : probe.turnConfigured ? 'rooms.help.turnConfigured' : 'rooms.help.turnMissing')}</p>
      <p>{t('rooms.help.probeLimits')}</p>
    </div>}
    <details><summary>{t('rooms.help.sameNetwork')}</summary><p>{t('rooms.help.sameNetworkHint')}</p></details>
  </section>;
}
