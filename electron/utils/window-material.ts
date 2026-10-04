import type { AcrylicStatus } from '../../shared/appearance';
/** Register only the app shell and allowlisted UI popouts, never a website or room engine. */
export interface MaterialWindow {
  isDestroyed(): boolean;
  setBackgroundMaterial(material: 'none' | 'acrylic'): void;
  setBackgroundColor(color: string): void;
  once(event: 'closed', listener: () => void): unknown;
}
export class WindowMaterial {
  private windows = new Set<MaterialWindow>();
  private enabled = false;
  private failed = false;
  constructor(private supported: boolean) {}
  register(win: MaterialWindow): void {
    this.windows.add(win);
    win.once('closed', () => this.windows.delete(win));
    this.apply(win);
  }
  setEnabled(enabled: boolean): AcrylicStatus {
    this.enabled = enabled;
    this.failed = false;
    for (const win of this.windows) this.apply(win);
    return this.status();
  }
  status(): AcrylicStatus {
    return { enabled: this.enabled, active: this.enabled && this.supported && !this.failed,
      reason: !this.supported ? 'unsupported' : !this.enabled ? 'off' : this.failed ? 'failed' : 'active' };
  }
  private apply(win: MaterialWindow): void {
    if (win.isDestroyed()) return;
    try {
      if (this.supported) win.setBackgroundMaterial(this.enabled ? 'acrylic' : 'none');
      win.setBackgroundColor(this.enabled && this.supported ? '#00000000' : '#141519');
    } catch {
      this.failed = true;
      try { win.setBackgroundMaterial('none'); win.setBackgroundColor('#141519'); } catch { /* closing */ }
    }
  }
}
