/**
 * Unit tests for the global-PTT shared logic: the DOM-code → UiohookKey-name map
 * and the pure hook-lifecycle decision (the native module itself is smoke-only).
 */
import { describe, it, expect } from 'vitest';
import { domCodeToUiohookName, decideGlobalPtt } from './uiohook-keymap';

describe('domCodeToUiohookName', () => {
  it('maps letters, digits, F-keys and numpad digits structurally', () => {
    expect(domCodeToUiohookName('KeyA')).toBe('A');
    expect(domCodeToUiohookName('KeyZ')).toBe('Z');
    expect(domCodeToUiohookName('Digit0')).toBe('0');
    expect(domCodeToUiohookName('Digit9')).toBe('9');
    expect(domCodeToUiohookName('F1')).toBe('F1');
    expect(domCodeToUiohookName('F24')).toBe('F24');
    expect(domCodeToUiohookName('Numpad5')).toBe('Numpad5');
  });

  it('maps sided modifiers to their uiohook names', () => {
    expect(domCodeToUiohookName('ShiftLeft')).toBe('Shift');
    expect(domCodeToUiohookName('ShiftRight')).toBe('ShiftRight');
    expect(domCodeToUiohookName('ControlLeft')).toBe('Ctrl');
    expect(domCodeToUiohookName('AltRight')).toBe('AltRight');
    expect(domCodeToUiohookName('MetaLeft')).toBe('Meta');
  });

  it('maps punctuation and the default PTT key', () => {
    expect(domCodeToUiohookName('Backquote')).toBe('Backquote');
    expect(domCodeToUiohookName('Space')).toBe('Space');
    expect(domCodeToUiohookName('BracketLeft')).toBe('BracketLeft');
  });

  it('returns null for inexpressible or garbage codes', () => {
    expect(domCodeToUiohookName('')).toBeNull();
    expect(domCodeToUiohookName('F25')).toBeNull();
    expect(domCodeToUiohookName('MediaPlayPause')).toBeNull();
    expect(domCodeToUiohookName('KeyAA')).toBeNull();
    expect(domCodeToUiohookName('lol')).toBeNull();
  });
});

describe('decideGlobalPtt', () => {
  const rooms = (over: Array<Partial<{ roomId: string; inVoice: boolean; inputMode: string }>>) =>
    over.map((r, i) => ({ roomId: r.roomId ?? 'r' + i, inVoice: r.inVoice ?? false, inputMode: r.inputMode ?? 'always' }));

  it('does not run when disabled, keyless, or nobody is in PTT voice', () => {
    expect(decideGlobalPtt({ enabled: false, keycode: 41 }, rooms([{ inVoice: true, inputMode: 'ptt' }]))).toEqual({ run: false });
    expect(decideGlobalPtt({ enabled: true, keycode: null }, rooms([{ inVoice: true, inputMode: 'ptt' }]))).toEqual({ run: false });
    expect(decideGlobalPtt({ enabled: true, keycode: 41 }, rooms([]))).toEqual({ run: false });
    expect(decideGlobalPtt({ enabled: true, keycode: 41 }, rooms([{ inVoice: true, inputMode: 'vad' }]))).toEqual({ run: false });
    expect(decideGlobalPtt({ enabled: true, keycode: 41 }, rooms([{ inVoice: false, inputMode: 'ptt' }]))).toEqual({ run: false });
  });

  it('targets the room that is in voice in PTT mode', () => {
    const d = decideGlobalPtt({ enabled: true, keycode: 41 }, rooms([
      { roomId: 'idle', inVoice: false, inputMode: 'ptt' },
      { roomId: 'talking', inVoice: true, inputMode: 'ptt' },
    ]));
    expect(d).toEqual({ run: true, roomId: 'talking', keycode: 41 });
  });
});
