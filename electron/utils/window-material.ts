import type { AcrylicStatus, NativeMaterial } from '../../shared/appearance';
/** Register only the app shell and allowlisted UI popouts, never a website or room engine. */
export interface MaterialWindow {
  isDestroyed(): boolean;
  setBackgroundMaterial(material: 'none' | NativeMaterial): void;
  setBackgroundColor(color: string): void;
  once(event: 'closed', listener: () => void): unknown;
}
export class WindowMaterial {
  private windows = new Map<MaterialWindow, { key: string; failed: boolean }>();
  private enabled = false;
  private material: NativeMaterial = 'acrylic';
  private allowed = true;
  constructor(private supported: boolean) {}
  register(win: MaterialWindow): void {
    if (win.isDestroyed() || this.windows.has(win)) return;
    this.windows.set(win, { key: '', failed: false });
    win.once('closed', () => this.windows.delete(win));
    this.apply(win);
  }
  setEnabled(enabled: boolean, material: NativeMaterial = this.material): AcrylicStatus {
    this.enabled = enabled; this.material = material;
    for (const win of this.windows.keys()) this.apply(win);
    return this.status();
  }
  setTransparencyAllowed(allowed: boolean): AcrylicStatus {
    this.allowed = allowed;
    for (const win of this.windows.keys()) this.apply(win);
    return this.status();
  }
  /** Resume can recreate the compositor; reapply once, never on a timer or during dragging. */
  refresh(): AcrylicStatus {
    for (const [win, state] of this.windows) { state.key = ''; this.apply(win); }
    return this.status();
  }
  status(win?: MaterialWindow): AcrylicStatus {
    const primary = win ?? [...this.windows.keys()].find(w => !w.isDestroyed());
    const failed = primary ? this.windows.get(primary)?.failed === true : false;
    const reason = !this.supported ? 'unsupported' : !this.enabled ? 'off' : !this.allowed ? 'system' : failed ? 'failed' : 'active';
    return { enabled: this.enabled, active: reason === 'active', reason, material: this.material };
  }
  private apply(win: MaterialWindow): void {
    if (win.isDestroyed()) { this.windows.delete(win); return; }
    const state = this.windows.get(win)!;
    const active = this.enabled && this.supported && this.allowed;
    const material = active ? this.material : 'none';
    const key = `${material}:${this.supported}`;
    if (state.key === key && !state.failed) return;
    try {
      // An opaque Chromium background would hide DWM even when its material is enabled.
      win.setBackgroundColor(active ? '#00000000' : '#141519');
      if (this.supported) win.setBackgroundMaterial(material);
      state.key = key; state.failed = false;
    } catch {
      state.key = ''; state.failed = true;
      try { if (this.supported) win.setBackgroundMaterial('none'); win.setBackgroundColor('#141519'); } catch { /* closing */ }
    }
  }
}
