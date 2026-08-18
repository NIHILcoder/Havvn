/**
 * AudioSettings — the music player's own settings surface.
 *
 * Presentation only: it draws sliders and switches and hands changes back. The
 * WebAudio graph, the queue and the output device all live in RoomPlayer, which is
 * where the media element is — a settings panel that reached for the audio graph
 * would break the moment the player moved to another window and rebuilt it.
 *
 * `canEq` is false when the spectrum tap could not be created (a tainted
 * cross-origin stream, or a browser that refused a second MediaElementSource). The
 * equaliser rides the SAME graph, so it is honestly disabled rather than silently
 * doing nothing.
 */
import React from 'react';
import { Icon } from '../../components';
import { useTranslation } from '../../utils/i18nContext';
import {
  AudioPrefs, RepeatMode, EQ_FREQS, EQ_LIMIT, EQ_PRESETS, presetFor,
} from '../../utils/audioPrefs';

export interface AudioOutputDevice { deviceId: string; label: string }

interface AudioSettingsProps {
  prefs: AudioPrefs;
  onChange: (patch: Partial<AudioPrefs>) => void;
  /** Output devices, or an empty list where the platform exposes none. */
  devices: readonly AudioOutputDevice[];
  /** The equaliser needs the audio graph; without the tap there is none. */
  canEq: boolean;
}

const fmtFreq = (hz: number): string => (hz >= 1000 ? `${Math.round(hz / 100) / 10}k` : String(hz));

export const AudioSettings: React.FC<AudioSettingsProps> = ({ prefs, onChange, devices, canEq }) => {
  const { t } = useTranslation();
  const preset = presetFor(prefs.bands);

  const setBand = (i: number, v: number) => {
    const bands = prefs.bands.slice();
    bands[i] = v;
    onChange({ bands, eqOn: true });
  };

  return (
    <div className="room-audio-settings" role="dialog" aria-label={t('audio.title')}>
      {/* No ✕ of its own: the toolbar button that opened the panel closes it, and a
          second way to do the same thing is one more control to read past. */}
      <div className="ras-head">
        <span className="ras-title"><Icon name="sliders" size={13} /> {t('audio.title')}</span>
      </div>

      {/* ── Equaliser ─────────────────────────────────────────────── */}
      <div className="ras-section">
        <div className="ras-row">
          <span className="ras-label">{t('audio.eq')}</span>
          <button
            className={`ras-switch${prefs.eqOn ? ' on' : ''}`}
            onClick={() => onChange({ eqOn: !prefs.eqOn })}
            disabled={!canEq}
            aria-pressed={prefs.eqOn}
          >
            {prefs.eqOn ? t('audio.on') : t('audio.off')}
          </button>
        </div>

        {!canEq && <div className="ras-note">{t('audio.eqUnavailable')}</div>}

        <div className={`ras-eq${prefs.eqOn && canEq ? '' : ' muted'}`}>
          {EQ_FREQS.map((hz, i) => (
            <label key={hz} className="ras-band" title={`${hz} Hz · ${prefs.bands[i] > 0 ? '+' : ''}${prefs.bands[i]} dB`}>
              <input
                type="range"
                min={-EQ_LIMIT}
                max={EQ_LIMIT}
                step={1}
                value={prefs.bands[i]}
                disabled={!canEq}
                onChange={(e) => setBand(i, Number(e.target.value))}
                /* Vertical sliders: the appearance is set in CSS, the orientation
                   attribute is what tells the browser which way the arrow keys go. */
                {...{ orient: 'vertical' }}
              />
              <span className="ras-band-hz">{fmtFreq(hz)}</span>
            </label>
          ))}
        </div>

        <div className="ras-presets">
          {Object.keys(EQ_PRESETS).map((name) => (
            <button
              key={name}
              className={`ras-preset${preset === name ? ' on' : ''}`}
              disabled={!canEq}
              onClick={() => onChange({ bands: EQ_PRESETS[name].slice(), eqOn: name !== 'flat' })}
            >
              {t(`audio.preset.${name}` as 'audio.preset.flat')}
            </button>
          ))}
        </div>

        <label className="ras-row ras-slider-row">
          <span className="ras-label">{t('audio.preamp')}</span>
          <input
            type="range"
            min={-EQ_LIMIT}
            max={EQ_LIMIT}
            step={1}
            value={prefs.preamp}
            disabled={!canEq}
            onChange={(e) => onChange({ preamp: Number(e.target.value) })}
          />
          <span className="ras-val">{prefs.preamp > 0 ? '+' : ''}{prefs.preamp} dB</span>
        </label>

        <div className="ras-row">
          <span className="ras-label" title={t('audio.normalizeHint')}>{t('audio.normalize')}</span>
          <button
            className={`ras-switch${prefs.normalize ? ' on' : ''}`}
            onClick={() => onChange({ normalize: !prefs.normalize })}
            disabled={!canEq}
            aria-pressed={prefs.normalize}
          >
            {prefs.normalize ? t('audio.on') : t('audio.off')}
          </button>
        </div>
      </div>

      {/* ── Queue ─────────────────────────────────────────────────── */}
      <div className="ras-section">
        <div className="ras-row">
          <span className="ras-label">{t('audio.repeat')}</span>
          <div className="ras-seg">
            {(['off', 'one', 'all'] as RepeatMode[]).map((m) => (
              <button
                key={m}
                className={`ras-seg-btn${prefs.repeat === m ? ' on' : ''}`}
                onClick={() => onChange({ repeat: m })}
                aria-pressed={prefs.repeat === m}
              >
                {t(`audio.repeat.${m}` as 'audio.repeat.off')}
              </button>
            ))}
          </div>
        </div>
        <div className="ras-row">
          <span className="ras-label">{t('audio.shuffle')}</span>
          <button
            className={`ras-switch${prefs.shuffle ? ' on' : ''}`}
            onClick={() => onChange({ shuffle: !prefs.shuffle })}
            aria-pressed={prefs.shuffle}
          >
            {prefs.shuffle ? t('audio.on') : t('audio.off')}
          </button>
        </div>
      </div>

      {/* ── Output & window ───────────────────────────────────────── */}
      <div className="ras-section">
        {devices.length > 0 && (
          <label className="ras-row">
            <span className="ras-label">{t('audio.output')}</span>
            <select
              className="ras-select"
              value={prefs.sinkId}
              onChange={(e) => onChange({ sinkId: e.target.value })}
            >
              <option value="">{t('audio.outputDefault')}</option>
              {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
          </label>
        )}
        <div className="ras-row">
          <span className="ras-label" title={t('audio.detachHint')}>{t('audio.detach')}</span>
          <button
            className={`ras-switch${prefs.detachOnOpen ? ' on' : ''}`}
            onClick={() => onChange({ detachOnOpen: !prefs.detachOnOpen })}
            aria-pressed={prefs.detachOnOpen}
          >
            {prefs.detachOnOpen ? t('audio.on') : t('audio.off')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AudioSettings;
