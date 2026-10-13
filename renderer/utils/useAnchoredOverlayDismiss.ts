import { useEffect, type RefObject } from 'react';

/** Keep portaled overlays tied to a visible anchor in its owning window. */
export function useAnchoredOverlayDismiss(
  anchor: HTMLElement | null,
  overlay: RefObject<HTMLElement>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active || !anchor) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    if (!win) { onClose(); return; }
    const checkAnchor = () => {
      const rect = anchor.getBoundingClientRect();
      if (!anchor.isConnected || anchor.ownerDocument !== doc || !anchor.getClientRects().length || !rect.width || !rect.height) onClose();
    };
    const onScroll = (event: Event) => {
      // Scrolling a long profile/menu must not dismiss its own controls.
      if (!overlay.current?.contains(event.target as Node)) onClose();
    };
    const realm = win as Window & typeof globalThis;
    const visibility = new realm.IntersectionObserver(entries => {
      if (entries.some(entry => !entry.isIntersecting)) onClose();
      else checkAnchor();
    });
    visibility.observe(anchor);
    // Removing/reparenting the trigger can preserve its last intersection ratio.
    const removal = new realm.MutationObserver(checkAnchor);
    if (anchor.parentNode) removal.observe(anchor.parentNode, { childList: true, subtree: true });
    checkAnchor();
    doc.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', onClose);
    return () => {
      visibility.disconnect();
      removal.disconnect();
      doc.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onClose);
    };
  }, [anchor, overlay, active, onClose]);
}
