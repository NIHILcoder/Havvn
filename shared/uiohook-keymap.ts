/**
 * KeyboardEvent.code → UiohookKey enum NAME (uiohook-napi's keycode table).
 *
 * The renderer stores the PTT key as a DOM `code` (layout-independent); the main
 * process resolves the name returned here against the actual UiohookKey enum at
 * runtime (never hardcoded numbers, so an enum change can't silently mis-key).
 * Returns null for codes the global hook can't express — the UI then disables
 * the global toggle for that key and falls back to the in-app listener.
 */
/** Pure global-PTT lifecycle decision (kept here — shared/ — so it unit-tests
 *  without the native module or electron imports). The OS key hook should run
 *  iff the toggle is on, the key resolves, and SOME room is in voice in
 *  push-to-talk mode; PTT edges go to the first such room. */
export function decideGlobalPtt(
  prefs: { enabled: boolean; keycode: number | null },
  rooms: Array<{ roomId: string; inVoice: boolean; inputMode: string }>,
): { run: false } | { run: true; roomId: string; keycode: number } {
  if (!prefs.enabled || !prefs.keycode) return { run: false };
  const target = rooms.find((r) => r.inVoice && r.inputMode === 'ptt');
  return target ? { run: true, roomId: target.roomId, keycode: prefs.keycode } : { run: false };
}

export function domCodeToUiohookName(code: string): string | null {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);          // KeyA..KeyZ → A..Z
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);        // Digit0..9 → '0'..'9'
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;     // F1..F24
  if (/^Numpad[0-9]$/.test(code)) return code;                // Numpad0..9
  const map: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'CapsLock',
    Escape: 'Escape', PageUp: 'PageUp', PageDown: 'PageDown', End: 'End', Home: 'Home',
    Insert: 'Insert', Delete: 'Delete', NumLock: 'NumLock', ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ShiftLeft: 'Shift', ShiftRight: 'ShiftRight',
    ControlLeft: 'Ctrl', ControlRight: 'CtrlRight',
    AltLeft: 'Alt', AltRight: 'AltRight',
    MetaLeft: 'Meta', MetaRight: 'MetaRight',
    Semicolon: 'Semicolon', Equal: 'Equal', Comma: 'Comma', Minus: 'Minus', Period: 'Period',
    Slash: 'Slash', Backquote: 'Backquote', BracketLeft: 'BracketLeft', Backslash: 'Backslash',
    BracketRight: 'BracketRight', Quote: 'Quote',
    NumpadMultiply: 'NumpadMultiply', NumpadAdd: 'NumpadAdd', NumpadSubtract: 'NumpadSubtract',
    NumpadDecimal: 'NumpadDecimal', NumpadDivide: 'NumpadDivide', NumpadEnter: 'NumpadEnter',
  };
  return map[code] ?? null;
}
