import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Modal consumes the i18n context for its close-button label; markup tests don't
// need real locale loading, so t() just echoes the key.
vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { Modal, resolveTrapMove, type TrapState } from './Modal';

// The focus trap itself needs a live DOM (activeElement, Tab keys), which this
// harness has none of — so its decision table is extracted as a pure function.
// The flags are facts read off ONE document's activeElement; feeding it flags
// from the wrong document is precisely the child-window bug, and the last test
// pins that failure shape.

const state = (over: Partial<TrapState> = {}): TrapState => ({
  hasActive: true, insideDialog: true, isDialog: false, isFirst: false, isLast: false, ...over,
});

describe('resolveTrapMove', () => {
  it('pulls stray focus back into the dialog', () => {
    expect(resolveTrapMove(state({ insideDialog: false }), false)).toBe('first');
    expect(resolveTrapMove(state({ insideDialog: false }), true)).toBe('first');
  });

  it('wraps forward off the last control and backward off the first', () => {
    expect(resolveTrapMove(state({ isLast: true }), false)).toBe('first');
    expect(resolveTrapMove(state({ isFirst: true }), true)).toBe('last');
  });

  it('leaves ordinary movement to the browser', () => {
    expect(resolveTrapMove(state(), false)).toBeNull();
    expect(resolveTrapMove(state(), true)).toBeNull();
    expect(resolveTrapMove(state({ isFirst: true }), false)).toBeNull();
    expect(resolveTrapMove(state({ isLast: true }), true)).toBeNull();
  });

  it('treats Shift+Tab on the dialog card itself as wrapping to the end', () => {
    // The card is tabIndex={-1} and takes focus when a dialog has no fields.
    expect(resolveTrapMove(state({ isDialog: true }), true)).toBe('last');
    expect(resolveTrapMove(state({ isDialog: true }), false)).toBeNull();
  });

  it('keeps focus put in a dialog with a single focusable control', () => {
    // first AND last are the same element — both directions must still be
    // intercepted, or Tab escapes the dialog into the window chrome.
    const only = state({ isFirst: true, isLast: true });
    expect(resolveTrapMove(only, false)).toBe('first');
    expect(resolveTrapMove(only, true)).toBe('last');
  });

  it('does nothing when the document reports no activeElement', () => {
    expect(resolveTrapMove(state({ hasActive: false, insideDialog: false }), false)).toBeNull();
  });

  it('reading activeElement from the WRONG window turns the trap into a cage', () => {
    // A dialog living in a detached window, measured against the main document:
    // focus is never seen inside, so every Tab — in both directions — snaps back
    // to the first control instead of moving through the dialog.
    const asSeenFromTheWrongRealm = state({ insideDialog: false, isFirst: true, isLast: false });
    expect(resolveTrapMove(asSeenFromTheWrongRealm, false)).toBe('first');
    expect(resolveTrapMove(asSeenFromTheWrongRealm, true)).toBe('first');
    // Same element, read from its OWN document: Shift+Tab wraps to the end.
    expect(resolveTrapMove(state({ isFirst: true }), true)).toBe('last');
  });
});

describe('Modal markup', () => {
  const render = (props: Partial<React.ComponentProps<typeof Modal>> = {}) =>
    renderToStaticMarkup(
      <Modal onClose={() => {}} title="Settings" {...props}>
        <p>body</p>
      </Modal>,
    );

  // The host-window work only touches effects and listeners; the rendered shell
  // must come out exactly as before — including with no HostWindowProvider above
  // it, which is how the whole main-window tree runs.
  it('renders the backdrop, card, head and body without a HostWindowProvider', () => {
    const html = render();
    expect(html).toContain('class="um-backdrop"');
    expect(html).toContain('class="um-card um-md "');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('<p>body</p>');
    expect(html).not.toContain('um-foot');
  });

  it('carries size, extra classes and the footer through', () => {
    const html = render({ size: 'lg', className: 'ssp', backdropClassName: 'confirm-layer', footer: <button>OK</button> });
    expect(html).toContain('class="um-backdrop confirm-layer"');
    expect(html).toContain('class="um-card um-lg ssp"');
    expect(html).toContain('<div class="um-foot"><button>OK</button></div>');
  });

  it('drops the close button when hidden and keeps the aria-label fallback', () => {
    const html = render({ title: undefined, hideClose: true, ariaLabel: 'Preview' });
    expect(html).not.toContain('um-x');
    expect(html).not.toContain('um-head');
    expect(html).toContain('aria-label="Preview"');
  });

  it('disables the close button while busy', () => {
    expect(render({ busy: true })).toMatch(/class="um-x"[^>]*disabled/);
  });
});
