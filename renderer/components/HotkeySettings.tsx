import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { useTranslation } from '../utils/i18nContext';
import type { Hotkey } from '../utils/hotkeys';
import './HotkeySettings.css';

// The type and defaults now live in utils/hotkeys.ts (shared with App.tsx's
// global keydown handler); re-exported here for existing imports.
export { defaultHotkeys } from '../utils/hotkeys';
export type { Hotkey } from '../utils/hotkeys';

interface HotkeySettingsProps {
  hotkeys: Hotkey[];
  onHotkeyChange: (hotkeyId: string, keys: string[]) => void;
  onResetHotkeys: () => void;
}

// Convert event.code to display name
const codeToDisplayName = (code: string): string => {
  const mapping: Record<string, string> = {
    // Letters
    KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F',
    KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L',
    KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R',
    KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
    KeyY: 'Y', KeyZ: 'Z',
    // Numbers
    Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
    // Special keys
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
    Backquote: '`', Minus: '-', Equal: '=',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Escape: 'Esc', Insert: 'Insert', Home: 'Home',
    End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    // Function keys
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  };
  return mapping[code] || code;
};

export const HotkeySettings: React.FC<HotkeySettingsProps> = ({
  hotkeys,
  onHotkeyChange,
  onResetHotkeys,
}) => {
  const { t } = useTranslation();
  const labelPrefix = useId();
  const [editingHotkey, setEditingHotkey] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const recorder = useRef<HTMLDivElement>(null);
  const lastEdit = useRef<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (editingHotkey) recorder.current?.focus();
    else editButton.current?.focus();
  }, [editingHotkey]);

  const categories = Array.from(new Set(hotkeys.map((h) => h.category)));

  const categoryLabels: Record<string, string> = {
    Navigation: t('hotkeys.categoryNavigation'),
    Torrents: t('hotkeys.categoryTorrents'),
    Voice: t('hotkeys.categoryVoice'),
  };
  const hotkeyLabels: Record<string, string> = {
    'open-command-palette': t('commands.title'),
    'open-downloads': t('hotkeys.openDownloads'),
    'open-settings': t('hotkeys.openSettings'),
    'add-torrent': t('btn.addTorrent'),
    'create-torrent': t('nav.create'),
    'pause-all': t('hotkeys.pauseAll'),
    'resume-all': t('hotkeys.resumeAll'),
    'voice-mute': t('hotkeys.voiceMute'),
    'voice-deafen': t('hotkeys.voiceDeafen'),
  };
  const hotkeyDescriptions: Record<string, string> = {
    'open-command-palette': t('commands.placeholder'),
    'open-downloads': t('hotkeys.openDownloadsDesc'),
    'open-settings': t('hotkeys.openSettingsDesc'),
    'add-torrent': t('hotkeys.addTorrentDesc'),
    'create-torrent': t('hotkeys.createTorrentDesc'),
    'pause-all': t('hotkeys.pauseAllDesc'),
    'resume-all': t('hotkeys.resumeAllDesc'),
    'voice-mute': t('hotkeys.voiceMuteDesc'),
    'voice-deafen': t('hotkeys.voiceDeafenDesc'),
  };

  const handleStartRecording = (hotkeyId: string) => {
    lastEdit.current = hotkeyId;
    setEditingHotkey(hotkeyId);
    setRecordedKeys([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!editingHotkey || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();

    const keys: string[] = [];
    
    // Add modifiers
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.shiftKey) keys.push('Shift');
    if (e.altKey) keys.push('Alt');
    if (e.metaKey) keys.push('Meta');

    // Use event.code for keyboard layout independence
    const code = e.code;
    if (code && !['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(code)) {
      keys.push(code);
    }

    if (keys.length > 0) {
      setRecordedKeys(keys);
      
      // Save immediately if there's at least one non-modifier key
      const hasMainKey = keys.some(k => !['Ctrl', 'Shift', 'Alt', 'Meta'].includes(k));
      if (hasMainKey) {
        onHotkeyChange(editingHotkey, keys);
        setEditingHotkey(null);
        setRecordedKeys([]);
      }
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const handleCancel = () => {
    setEditingHotkey(null);
    setRecordedKeys([]);
  };

  return (
    <div className="hotkey-settings">
      {categories.map((category) => (
        <div key={category} className="hotkey-category">
          <h3 className="hotkey-category-title">{categoryLabels[category] ?? category}</h3>
          <div className="hotkey-list">
            {hotkeys
              .filter((h) => h.category === category)
              .map((hotkey) => (
                <div key={hotkey.id} className="hotkey-item" data-setting-label={hotkeyLabels[hotkey.id] || hotkey.description}>
                  <div className="hotkey-info">
                    <div id={`${labelPrefix}-${hotkey.id}`} className="hotkey-label">{hotkeyLabels[hotkey.id] ?? hotkey.label}</div>
                    <div className="hotkey-description">{hotkeyDescriptions[hotkey.id] ?? hotkey.description}</div>
                  </div>
                  <div className="hotkey-control">
                    {editingHotkey === hotkey.id ? (
                      <div
                        className="hotkey-recorder"
                        ref={recorder}
                        role="group"
                        aria-label={t('hotkeys.pressKeys')}
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                        tabIndex={0}
                      >
                        <span className="hotkey-recorder-text">
                          {recordedKeys.length > 0
                            ? recordedKeys.map(k => codeToDisplayName(k)).join(' + ')
                            : t('hotkeys.pressKeys')}
                        </span>
                        <button type="button" className="btn-cancel-recording" aria-label={t('common.cancel')} onClick={handleCancel}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="hotkey-display"
                        type="button"
                        ref={lastEdit.current === hotkey.id ? editButton : undefined}
                        aria-describedby={`${labelPrefix}-${hotkey.id}`}
                        onClick={() => handleStartRecording(hotkey.id)}
                      >
                        {hotkey.keys.length > 0 ? (
                          <span className="hotkey-keys">
                            {hotkey.keys.map((key, idx) => (
                              <React.Fragment key={idx}>
                                {idx > 0 && <span className="hotkey-plus">+</span>}
                                <kbd className="hotkey-key">{codeToDisplayName(key)}</kbd>
                              </React.Fragment>
                            ))}
                          </span>
                        ) : (
                          <span className="hotkey-empty">{t('hotkeys.notAssigned')}</span>
                        )}
                        <span className="hotkey-edit"><Icon name="edit-2" size={14} />{t('common.edit')}</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
      <div className="hotkey-toolbar">
        <Button variant="secondary" size="sm" icon={<Icon name="rotate-ccw" size={14} />} onClick={onResetHotkeys}>
          {t('hotkeys.resetAll')}
        </Button>
      </div>
    </div>
  );
};
