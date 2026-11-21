const copies = new WeakMap<HTMLElement, { pending: boolean; original: string }>();

/** Keep guest copy failures visible, without updating a replaced chat row. */
export async function copyGuestText(target: HTMLElement, text: string, labels: { copied: string; failed: string }): Promise<boolean> {
  if (copies.get(target)?.pending) return false;
  const original = copies.get(target)?.original ?? target.textContent ?? '';
  const task = { pending: true, original }; copies.set(target, task);
  target.textContent = original;
  target.parentElement?.querySelector('[data-copy-status]')?.remove();
  target.setAttribute('aria-busy', 'true');
  const active = () => target.isConnected && copies.get(target) === task;
  try {
    const win = target.ownerDocument.defaultView;
    if (!win?.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await win.navigator.clipboard.writeText(text);
    if (active()) {
      target.textContent = labels.copied;
      setTimeout(() => { if (active()) target.textContent = original; }, 1200);
    }
    return true;
  } catch {
    if (active()) {
      const notice = target.ownerDocument.createElement('span');
      notice.dataset.copyStatus = ''; notice.className = 'hint error'; notice.setAttribute('role', 'alert');
      notice.textContent = labels.failed; target.after(notice);
    }
    return false;
  } finally {
    task.pending = false;
    if (active()) target.removeAttribute('aria-busy');
  }
}
