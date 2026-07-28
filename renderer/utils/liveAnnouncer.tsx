/**
 * liveAnnouncer — say something to a screen reader, in the window that said it.
 *
 * Some state changes are only visible. Moving a dock panel is the sharp case: the
 * panel is gone from one column and present in another, and a sighted user sees
 * that instantly, while a reader is told nothing beyond whatever the focus move
 * happens to announce. An `aria-live` region is the fix — but a live region is a
 * DOM node in ONE document, and a screen reader only voices the regions of the
 * window its virtual cursor is in. So "mount one at the app root" is wrong here:
 * a panel torn off onto the second monitor would raise its announcement into a
 * region in the main window, where the reader is not.
 *
 * Hence a REALM-ROUTED announcer, the same shape as hostToast:
 *
 *   per window   <LiveAnnouncer />            once, inside that window's subtree
 *   anywhere     const say = useAnnounce();   say(alreadyTranslatedMessage)
 *
 * and the message is delivered to the region living in the caller's own host
 * window. Nothing else has to be plumbed: the realm key IS `useHostWindow().window`,
 * so a subtree already wrapped for its window (usePopout's `portal()`, or the dock's
 * `<HostWindowRealm>` around a hoisted panel) routes correctly for free, and the
 * main window — no provider, REAL_HOST — is the plain default case.
 *
 * WHY A HUB AND NOT CONTEXT. React context would find the NEAREST provider in the
 * REACT tree, and the dock's hoisted panels are mounted in the MAIN tree while their
 * DOM lives in a child window — the nearest provider is the wrong one, by
 * construction. The realm key is a property of the DOM, so the delivery must be too.
 * (Same reason `toast()` needed `toasterId` rather than a context-scoped store.)
 *
 * ALREADY TRANSLATED, always. Like the whole dock folder, this takes finished user
 * strings; it never calls `t()`.
 *
 * POLITE ONLY, deliberately. Every announcement this app has is a confirmation of
 * something the user just did. `assertive` interrupts whatever the reader is
 * currently saying, which is for errors and alarms, and offering the choice here
 * would mean picking it at call sites that have no reason to think about it.
 *
 * DOM-LESS SAFETY: no global is dereferenced at module load or during render — the
 * realm is read inside the callback / the subscribe effect, neither of which runs
 * under `renderToStaticMarkup`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useHostWindow } from './hostWindow';

/** The window an announcement belongs to. `undefined` = no DOM (Node tests). */
export type AnnouncerRealm = Window | undefined;

export type AnnounceListener = (message: string) => void;

export interface AnnouncerHub {
  /** Register a region for `realm`. Returns its unsubscriber. */
  subscribe(realm: AnnouncerRealm, listener: AnnounceListener): () => void;
  /** Deliver to `realm`'s regions. False = nobody is listening there. */
  announce(realm: AnnouncerRealm, message: string): boolean;
}

/**
 * `impl` for tests and a module singleton for the app — the routing rule is the
 * interesting part and it is provable with no DOM and no React.
 *
 * DELIVERS TO EVERY listener of a realm rather than the last one registered: React
 * StrictMode double-invokes effects in dev, and a subscribe/unsubscribe pair that
 * assumed one listener per realm would leave the region deaf after the replay.
 */
export function createAnnouncerHub(): AnnouncerHub {
  const listeners = new Map<AnnouncerRealm, Set<AnnounceListener>>();
  return {
    subscribe(realm, listener) {
      let set = listeners.get(realm);
      if (!set) { set = new Set(); listeners.set(realm, set); }
      set.add(listener);
      return () => {
        const s = listeners.get(realm);
        if (!s) return;
        s.delete(listener);
        // Drop the empty bucket: realms are WINDOWS, and a pool slot that is torn
        // off and docked back all afternoon would otherwise accumulate one dead
        // Map entry per window, each holding that window alive.
        if (s.size === 0) listeners.delete(realm);
      };
    },
    announce(realm, message) {
      const text = message.trim();
      if (!text) return false;
      const set = listeners.get(realm);
      if (!set || set.size === 0) return false;
      // Copy: a listener that unsubscribes while being called (a window closing on
      // the same tick) must not perturb the iteration.
      for (const l of Array.from(set)) l(text);
      return true;
    },
  };
}

/** The app's announcer. One per JS realm, which is one per renderer process. */
export const announcerHub: AnnouncerHub = createAnnouncerHub();

/**
 * What one <LiveAnnouncer> is showing: TWO regions and which one is written next.
 *
 * Two, because a screen reader announces a live region when its CONTENT CHANGES.
 * Writing the same string into the same node twice is not a change, so the second
 * "Chat moved to Centre" — after a move there and back and there again — would be
 * silent. Alternating between two regions guarantees a change in whichever one is
 * written, for any sequence of messages including a repeat.
 *
 * The other region is CLEARED in the same step, so a reader that later navigates to
 * the region cannot find a stale announcement sitting there. Removing text does not
 * itself announce (the default `aria-relevant` is `additions text`).
 */
export interface AnnouncerState {
  readonly slots: readonly [string, string];
  readonly next: 0 | 1;
}

export const EMPTY_ANNOUNCEMENT: AnnouncerState = { slots: ['', ''], next: 0 };

/**
 * Pure: fold one message into the two-region state.
 * An empty or whitespace-only message returns the state UNCHANGED, by identity —
 * clearing a live region is not an announcement and must not consume a slot.
 */
export function nextAnnouncement(state: AnnouncerState, message: string): AnnouncerState {
  const text = message.trim();
  if (!text) return state;
  const slots: [string, string] = state.next === 0 ? [text, ''] : ['', text];
  return { slots, next: state.next === 0 ? 1 : 0 };
}

/**
 * Announce into THIS subtree's host window. Stable across renders for a stable
 * realm, so it is safe in a dependency array.
 *
 * The realm is read at CALL time, not at render time: `REAL_HOST.window` is a lazy
 * getter (there is no DOM during a `renderToStaticMarkup` test), and a panel whose
 * realm changed between render and click should announce where it is NOW.
 */
export function useAnnounce(): (message: string) => void {
  const host = useHostWindow();
  return useCallback((message: string) => {
    announcerHub.announce(host.window, message);
  }, [host]);
}

export interface LiveAnnouncerProps {
  /**
   * Override the realm this region serves. Omit — always, in practice — to serve
   * the window this component is rendered into, which is what makes "mount one per
   * window" the entire configuration.
   */
  realm?: AnnouncerRealm;
  /** For tests and stories. Defaults to the module singleton. */
  hub?: AnnouncerHub;
}

/**
 * One window's announcement surface. Mount it ONCE inside each window's subtree —
 * the app root for the main window, the dock window shell for a torn-off group —
 * and it costs two empty, visually hidden divs until something is said.
 *
 * `.sr-only` (styles/base.css) is cloned into every pop-out by usePopout's
 * stylesheet mirroring, so the regions are hidden in a child window too.
 */
export const LiveAnnouncer: React.FC<LiveAnnouncerProps> = ({ realm, hub = announcerHub }) => {
  const host = useHostWindow();
  const [state, setState] = useState<AnnouncerState>(EMPTY_ANNOUNCEMENT);

  useEffect(() => {
    const key = realm !== undefined ? realm : host.window;
    return hub.subscribe(key, (message) => {
      setState((prev) => nextAnnouncement(prev, message));
    });
  }, [hub, realm, host]);

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{state.slots[0]}</div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{state.slots[1]}</div>
    </>
  );
};
