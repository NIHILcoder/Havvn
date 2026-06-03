import React, { useState } from 'react';
import { Icon } from './Icon';
import './HotkeySettings.css';

interface Hotkey {
  id: string;
  label: string;
  description: string;
  keys: string[];
  category: string;
}

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
  const [editingHotkey, setEditingHotkey] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  const categories = Array.from(new Set(hotkeys.map((h) => h.category)));

  const handleStartRecording = (hotkeyId: string) => {
    setEditingHotkey(hotkeyId);
    setRecordedKeys([]);
    setIsRecording(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;
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
      if (hasMainKey && editingHotkey) {
        onHotkeyChange(editingHotkey, keys);
        setIsRecording(false);
        setEditingHotkey(null);
        setRecordedKeys([]);
      }
    }
  };

  const handleKeyUp = (e: React.KeyboardEvent) => {
    // No longer needed since we save in handleKeyDown
    e.preventDefault();
    e.stopPropagation();
  };

  const handleCancel = () => {
    setIsRecording(false);
    setEditingHotkey(null);
    setRecordedKeys([]);
  };

  return (
    <div className="hotkey-settings">
      <div className="hotkey-header">
        <div className="hotkey-header-info">
          <Icon name="keyboard" size={20} />
          <div>
            <h3>Keyboard Shortcuts</h3>
            <p>Customize key combinations for quick access to features</p>
          </div>
        </div>
        <button className="btn-reset-hotkeys" onClick={onResetHotkeys}>
          <Icon name="rotate-ccw" size={16} />
          Reset All
        </button>
      </div>

      {categories.map((category) => (
        <div key={category} className="hotkey-category">
          <div className="hotkey-category-title">{category}</div>
          <div className="hotkey-list">
            {hotkeys
              .filter((h) => h.category === category)
              .map((hotkey) => (
                <div key={hotkey.id} className="hotkey-item">
                  <div className="hotkey-info">
                    <div className="hotkey-label">{hotkey.label}</div>
                    <div className="hotkey-description">{hotkey.description}</div>
                  </div>
                  <div className="hotkey-control">
                    {editingHotkey === hotkey.id ? (
                      <div
                        className="hotkey-recorder"
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                        tabIndex={0}
                        autoFocus
                      >
                        <span className="hotkey-recorder-text">
                          {recordedKeys.length > 0
                            ? recordedKeys.map(k => codeToDisplayName(k)).join(' + ')
                            : 'Press keys...'}
                        </span>
                        <button className="btn-cancel-recording" onClick={handleCancel}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="hotkey-display"
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
                          <span className="hotkey-empty">Not Assigned</span>
                        )}
                        <Icon name="edit-2" size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
};

// Default hotkeys for the settings page
export const defaultHotkeys: Hotkey[] = [
  {
    id: 'open-downloads',
    label: 'Open Downloads',
    description: 'Switch to the downloads page',
    keys: ['Ctrl', 'KeyD'],
    category: 'Navigation',
  },
  {
    id: 'open-settings',
    label: 'Open Settings',
    description: 'Open the settings page',
    keys: ['Ctrl', 'Comma'],
    category: 'Navigation',
  },
  {
    id: 'add-torrent',
    label: 'Add Torrent',
    description: 'Open the add torrent dialog',
    keys: ['Ctrl', 'KeyO'],
    category: 'Torrents',
  },
  {
    id: 'create-torrent',
    label: 'Create Torrent',
    description: 'Navigate to torrent creation',
    keys: ['Ctrl', 'KeyN'],
    category: 'Torrents',
  },
  {
    id: 'pause-all',
    label: 'Pause All',
    description: 'Pause all active downloads',
    keys: ['Ctrl', 'Shift', 'KeyP'],
    category: 'Torrents',
  },
  {
    id: 'resume-all',
    label: 'Resume All',
    description: 'Resume all paused downloads',
    keys: ['Ctrl', 'Shift', 'KeyR'],
    category: 'Torrents',
  },
];
