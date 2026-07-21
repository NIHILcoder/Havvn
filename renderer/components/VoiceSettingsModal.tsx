/**
 * Voice settings modal — global (all-rooms) voice configuration, opened from the
 * gear in the room voice panel. Devices come from the ENGINE window's enumeration
 * (deviceId is salted per-origin, so main-renderer ids would not match the ids the
 * capture pipeline needs). Every change saves to localStorage voicePrefs and fires
 * VOICE_PREFS_EVENT; the voice panel pushes the engine-side subset over IPC.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { Modal } from './Modal';
import { Select } from './Select';
import { Toggle } from './Toggle';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import { VoicePrefs, loadVoicePrefs, saveVoicePrefs, keyLabel, toVoiceSettings } from '../utils/voicePrefs';
import { usePopout } from '../utils/popout';
import type { VoiceDeviceInfo, VoiceInputMode, NoiseSuppressionMode } from '../../shared/types';
import './VoiceSettingsModal.css';

// The meter's full-scale value (0-255 avg magnitude; speech averages ~10-50, so a
// lower ceiling keeps the interesting range visible). VAD marker uses this scale.
const METER_MAX = 96;

export const VoiceSettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<VoicePrefs>(loadVoicePrefs);
  const [devices, setDevices] = useState<VoiceDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);       // raw (pre-gain) 0-255 from the engine
  const [capturing, setCapturing] = useState(false); // PTT key rebind in progress
  const [monitor, setMonitor] = useState(false);      // "hear yourself" playback during the mic test
  const [globalInfo, setGlobalInfo] = useState<{ available: boolean; supported: boolean } | null>(null);

  const update = (patch: Partial<VoicePrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveVoicePrefs(next); // fires VOICE_PREFS_EVENT → the panel pushes to the engine
  };

  // Probe the global-PTT hook: is the native module loaded, and can it express
  // the chosen key? Doubles as the config push (the panel pushes too — idempotent).
  useEffect(() => {
    let dead = false;
    window.api.rooms.voice.globalPtt(prefs.globalPtt, prefs.pttKey)
      .then((r) => { if (!dead) setGlobalInfo({ available: r.available, supported: r.supported }); })
      .catch(() => { /* main unavailable — leave the toggle enabled optimistically */ });
    return () => { dead = true; };
  }, [prefs.globalPtt, prefs.pttKey]);

  // Device lists (engine-window enumeration), refreshed on hardware changes.
  useEffect(() => {
    let dead = false;
    const fetchDevices = () => {
      window.api.rooms.voice.devices()
        .then((d) => { if (!dead) setDevices(d); })
        .catch(() => { /* engine unavailable — pickers stay default-only */ });
    };
    fetchDevices();
    const off = window.api.onVoiceDevicesChanged(fetchDevices);
    return () => { dead = true; off(); };
  }, []);

  // Mic test lifecycle: restart when the CAPTURE config changes (device/processing);
  // gain is applied to the displayed bar client-side, so dragging it stays live.
  // `monitor` plays the processed mic back — restarts too (it rebuilds the graph).
  useEffect(() => {
    if (!testing) return;
    let dead = false;
    // Pass the current settings explicitly — the engine's cached settings are
    // debounced 200ms, so they'd lag a device/processing change made just now.
    window.api.rooms.voice.micTestStart(toVoiceSettings(prefs), monitor).catch((e) => {
      if (!dead) { setTesting(false); toast.error(String(e instanceof Error ? e.message : e)); }
    });
    const off = window.api.onVoiceMicLevel((lv) => {
      if (dead) return;
      if (lv < 0) { setTesting(false); return; } // engine auto-stopped at its 60s deadline
      setLevel(lv);
    });
    return () => {
      dead = true;
      off();
      setLevel(0);
      window.api.rooms.voice.micTestStop().catch(() => { /* ignore */ });
    };
    // Only CAPTURE-affecting knobs restart the test; gain/VAD are applied to the
    // displayed bar client-side (the meter is raw pre-gain), so they don't recapture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testing, monitor, prefs.inputDeviceId, prefs.echoCancellation, prefs.noiseSuppressionMode, prefs.autoGainControl]);

  // Detach into an OS window (the content portals there; state stays here).
  const { popout, openPopout, closePopout } = usePopout('havvn-voice-settings', t('rooms.voice.settings'));

  // Escape in the pop-out steps back to the docked modal (parity with the Modal's
  // own Escape). Skipped while capturing a PTT key — Escape cancels the capture.
  useEffect(() => {
    if (!popout || popout.closed) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !capturing) closePopout(); };
    popout.addEventListener('keydown', h);
    return () => { try { popout.removeEventListener('keydown', h); } catch { /* window gone */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popout, capturing]);

  // Capture the next key press to rebind push-to-talk (Escape cancels). Listens
  // on the window that actually HAS focus — when detached that's the pop-out.
  useEffect(() => {
    if (!capturing) return;
    const target: Window = popout && !popout.closed ? popout : window;
    const h = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      setCapturing(false);
      if (e.code !== 'Escape') update({ pttKey: e.code });
    };
    target.addEventListener('keydown', h, true);
    return () => target.removeEventListener('keydown', h, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, prefs, popout]);

  const deviceOptions = (kind: VoiceDeviceInfo['kind'], selected: string | null) => {
    // 'default'/'communications' are Chromium pseudo-devices — our null pref
    // (no deviceId constraint) already means the system default.
    const real = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const opts = [
      { value: '', label: t('rooms.voice.defaultDevice') },
      ...real.map((d, i) => ({ value: d.deviceId, label: d.label || `${t('rooms.voice.unknownDevice')} ${i + 1}` })),
    ];
    if (selected && !opts.some((o) => o.value === selected)) {
      opts.push({ value: selected, label: t('rooms.voice.unavailableDevice') });
    }
    return opts;
  };

  const shownLevel = Math.min(METER_MAX, level * prefs.inputGain);
  const levelPct = (shownLevel / METER_MAX) * 100;
  const markPct = (Math.min(METER_MAX, prefs.vadThreshold) / METER_MAX) * 100;
  const modes = useMemo(() => ([
    { id: 'always' as VoiceInputMode, label: t('rooms.voice.modeAlways') },
    { id: 'vad' as VoiceInputMode, label: t('rooms.voice.modeVad') },
    { id: 'ptt' as VoiceInputMode, label: t('rooms.voice.modePtt') },
  ]), [t]);
  const nsModes = useMemo(() => ([
    { id: 'off' as NoiseSuppressionMode, label: t('rooms.voice.nsOff') },
    { id: 'standard' as NoiseSuppressionMode, label: t('rooms.voice.nsStandard') },
    { id: 'enhanced' as NoiseSuppressionMode, label: t('rooms.voice.nsEnhanced') },
  ]), [t]);

  const content = (
    <>
      {/* Opened from inside a room, but the scope is global — say so. */}
      <p className="vsm-global-hint">{t('rooms.voice.globalHint')}</p>
      {/* Devices */}
      <div className="vsm-section">
        <div className="vsm-section-title">{t('rooms.voice.devices')}</div>
        <div className="vsm-row">
          <span className="vsm-label"><Icon name="mic" size={14} /> {t('rooms.voice.inputDevice')}</span>
          <Select
            className="vsm-select"
            options={deviceOptions('audioinput', prefs.inputDeviceId)}
            value={prefs.inputDeviceId || ''}
            onChange={(v) => update({ inputDeviceId: v || null })}
          />
        </div>
        <div className="vsm-row">
          <span className="vsm-label"><Icon name="volume-2" size={14} /> {t('rooms.voice.outputDevice')}</span>
          <Select
            className="vsm-select"
            options={deviceOptions('audiooutput', prefs.outputDeviceId)}
            value={prefs.outputDeviceId || ''}
            onChange={(v) => update({ outputDeviceId: v || null })}
          />
        </div>
        {/* Mic test: live meter with the VAD threshold marker on the same scale. */}
        <div className="vsm-row vsm-test">
          <button className={`vsm-test-btn${testing ? ' active' : ''}`} onClick={() => setTesting((x) => !x)}>
            <Icon name={testing ? 'pause' : 'play'} size={12} />
            {testing ? t('rooms.voice.micTestStop') : t('rooms.voice.micTest')}
          </button>
          {/* Hear yourself: play the PROCESSED mic back so the NS mode is audible.
              Turning it on starts the test too — the monitor lives inside the mic
              test, so on its own this button would silently do nothing. */}
          <button
            className={`vsm-test-btn${monitor ? ' active' : ''}`}
            onClick={() => { const next = !monitor; setMonitor(next); if (next) setTesting(true); }}
            title={t('rooms.voice.micMonitorHint')}
          >
            <Icon name={monitor ? 'volume-2' : 'volume-x'} size={12} />
            {t('rooms.voice.micMonitor')}
          </button>
          <div className="vsm-meter" title={t('rooms.voice.micTestHint')}>
            <div
              className={`vsm-meter-fill${shownLevel > prefs.vadThreshold ? ' hot' : ''}`}
              style={{ width: `${levelPct}%` }}
            />
            <div className="vsm-meter-mark" style={{ left: `${markPct}%` }} />
          </div>
        </div>
        {monitor && testing && <div className="vsm-hint">{t('rooms.voice.micMonitorWarn')}</div>}
      </div>

      {/* Volumes */}
      <div className="vsm-section">
        <div className="vsm-section-title">{t('rooms.voice.volume')}</div>
        <div className="vsm-row">
          <span className="vsm-label">{t('rooms.voice.inputGain')}</span>
          <input
            type="range" min={0} max={200} step={5} className="vsm-range"
            value={Math.round(prefs.inputGain * 100)}
            onChange={(e) => update({ inputGain: Number(e.target.value) / 100 })}
          />
          <span className="vsm-val">{Math.round(prefs.inputGain * 100)}%</span>
        </div>
        <div className="vsm-row">
          <span className="vsm-label">{t('rooms.voice.outputVolume')}</span>
          <input
            type="range" min={0} max={100} step={5} className="vsm-range"
            value={Math.round(prefs.masterVolume * 100)}
            onChange={(e) => update({ masterVolume: Number(e.target.value) / 100 })}
          />
          <span className="vsm-val">{Math.round(prefs.masterVolume * 100)}%</span>
        </div>
      </div>

      {/* Input mode + PTT key + VAD sensitivity */}
      <div className="vsm-section">
        <div className="vsm-section-title">{t('rooms.voice.mode')}</div>
        <div className="vsm-modes">
          {modes.map((m) => (
            <button
              key={m.id}
              className={`vsm-mode${prefs.inputMode === m.id ? ' active' : ''}`}
              onClick={() => update({ inputMode: m.id })}
            >{m.label}</button>
          ))}
        </div>
        {prefs.inputMode === 'ptt' && (
          <>
            <div className="vsm-row">
              <span className="vsm-label">{t('rooms.voice.pttKey')}</span>
              <button className={`vsm-key${capturing ? ' capturing' : ''}`} onClick={() => setCapturing(true)}>
                {capturing ? t('rooms.voice.pressKey') : keyLabel(prefs.pttKey)}
              </button>
            </div>
            <div className="vsm-row" title={t('rooms.voice.globalPttHint')}>
              <span className="vsm-label">{t('rooms.voice.globalPtt')}</span>
              <Toggle
                size="small"
                checked={prefs.globalPtt}
                disabled={globalInfo ? !globalInfo.available || !globalInfo.supported : false}
                onChange={(v) => update({ globalPtt: v })}
                ariaLabel={t('rooms.voice.globalPtt')}
              />
            </div>
            {globalInfo && !globalInfo.available && <div className="vsm-hint">{t('rooms.voice.globalPttUnavailable')}</div>}
            {globalInfo && globalInfo.available && !globalInfo.supported && <div className="vsm-hint">{t('rooms.voice.globalPttUnsupported')}</div>}
            {prefs.globalPtt && <div className="vsm-hint">{t('rooms.voice.globalPttHint')}</div>}
          </>
        )}
        {prefs.inputMode === 'vad' && (
          <div className="vsm-row" title={t('rooms.voice.vadHint')}>
            <span className="vsm-label">{t('rooms.voice.vadSensitivity')}</span>
            <input
              type="range" min={2} max={48} step={1} className="vsm-range"
              value={prefs.vadThreshold}
              onChange={(e) => update({ vadThreshold: Number(e.target.value) })}
            />
            <span className="vsm-val">{prefs.vadThreshold}</span>
          </div>
        )}
      </div>

      {/* Processing + chimes */}
      <div className="vsm-section">
        <div className="vsm-section-title">{t('rooms.voice.processing')}</div>
        <div className="vsm-row">
          <span className="vsm-label">{t('rooms.voice.echoCancellation')}</span>
          <Toggle size="small" checked={prefs.echoCancellation} onChange={(v) => update({ echoCancellation: v })} ariaLabel={t('rooms.voice.echoCancellation')} />
        </div>
        <div className="vsm-field">
          <span className="vsm-label">{t('rooms.voice.noiseSuppression')}</span>
          <div className="vsm-modes">
            {nsModes.map((m) => (
              <button
                key={m.id}
                className={`vsm-mode${prefs.noiseSuppressionMode === m.id ? ' active' : ''}`}
                onClick={() => update({ noiseSuppressionMode: m.id })}
              >{m.label}</button>
            ))}
          </div>
          {prefs.noiseSuppressionMode === 'enhanced' && <span className="vsm-hint">{t('rooms.voice.nsHint')}</span>}
        </div>
        <div className="vsm-row">
          <span className="vsm-label">{t('rooms.voice.autoGainControl')}</span>
          <Toggle size="small" checked={prefs.autoGainControl} onChange={(v) => update({ autoGainControl: v })} ariaLabel={t('rooms.voice.autoGainControl')} />
        </div>
        <div className="vsm-row">
          <span className="vsm-label">{t('rooms.voice.chimes')}</span>
          <Toggle size="small" checked={prefs.chimes} onChange={(v) => update({ chimes: v })} ariaLabel={t('rooms.voice.chimes')} />
        </div>
      </div>
    </>
  );

  // Detached: the content lives in its own OS window with a slim header; the
  // React tree (and every IPC subscription) stays in the main renderer realm.
  // Closing the OS window returns to the modal; the ✕ closes settings entirely.
  if (popout && !popout.closed) {
    return createPortal(
      <div className="vsm-popout">
        <div className="vsm-popout-head">
          <span className="vsm-popout-title"><Icon name="headphones" size={14} /> {t('rooms.voice.settings')}</span>
          <span className="vsm-popout-acts">
            <button className="vsm-popout-btn" onClick={closePopout} title={t('rooms.voice.popIn')}>
              <Icon name="minimize" size={13} />
            </button>
            <button className="vsm-popout-btn" onClick={() => { closePopout(); onClose(); }} title={t('common.close')}>
              <Icon name="x" size={13} />
            </button>
          </span>
        </div>
        <div className="vsm-body vsm-popout-body">{content}</div>
      </div>,
      popout.document.body,
    );
  }

  // Docked: portal to <body> — the opener (voice panel) lives inside the room's
  // container-query subtree, whose containment would trap the fixed backdrop.
  return createPortal(
    <Modal
      onClose={onClose} title={t('rooms.voice.settings')} icon="headphones" size="md" bodyClassName="vsm-body"
      footer={
        <button className="vsm-detach" onClick={openPopout} title={t('rooms.voice.popOut')}>
          <Icon name="external-link" size={13} /> {t('rooms.voice.popOut')}
        </button>
      }
    >
      {content}
    </Modal>,
    document.body,
  );
};
