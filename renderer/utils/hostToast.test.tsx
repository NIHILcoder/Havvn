import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toast as globalToast } from 'react-hot-toast';

import {
  withToasterId,
  bindToastRealm,
  useHostToast,
  useToastRealm,
  ToastRealmProvider,
  HostToaster,
  TOAST_OPTIONS,
  TOAST_POSITION,
  type ToastApi,
} from './hostToast';

// No jsdom: the routing rule is the whole point and it is provable against a spy
// with no DOM, no store and no rendered toast.

const spyToast = (): ToastApi & { calls: [string, unknown, unknown][] } => {
  const calls: [string, unknown, unknown][] = [];
  const rec = (name: string) => (a: unknown, b: unknown) => { calls.push([name, a, b]); return `${name}-id`; };
  const api = rec('toast') as unknown as ToastApi & { calls: typeof calls };
  api.error = rec('error') as ToastApi['error'];
  api.success = rec('success') as ToastApi['success'];
  api.loading = rec('loading') as ToastApi['loading'];
  api.custom = rec('custom') as ToastApi['custom'];
  api.dismiss = rec('dismiss') as unknown as ToastApi['dismiss'];
  api.dismissAll = ((id?: string) => { calls.push(['dismissAll', id, undefined]); }) as ToastApi['dismissAll'];
  api.remove = rec('remove') as unknown as ToastApi['remove'];
  api.removeAll = ((id?: string) => { calls.push(['removeAll', id, undefined]); }) as ToastApi['removeAll'];
  api.promise = ((p: unknown, m: unknown, o: unknown) => { calls.push(['promise', m, o]); return p; }) as unknown as ToastApi['promise'];
  api.calls = calls;
  return api;
};

describe('withToasterId', () => {
  it('returns the caller\'s own options object when there is no realm', () => {
    // Identity, not a copy: this is what makes the main window bit-for-bit the
    // behaviour it had before routing existed.
    const opts = { duration: 10 };
    expect(withToasterId(opts, undefined)).toBe(opts);
    expect(withToasterId(undefined, undefined)).toBeUndefined();
  });

  it('stamps the realm onto options, inventing them when there are none', () => {
    expect(withToasterId(undefined, 'havvn-dock-1')).toEqual({ toasterId: 'havvn-dock-1' });
    expect(withToasterId({ duration: 10 }, 'havvn-dock-1')).toEqual({ duration: 10, toasterId: 'havvn-dock-1' });
  });

  it('yields to an explicit toasterId — aiming a toast elsewhere is deliberate', () => {
    const opts = { toasterId: 'havvn-dock-2' };
    expect(withToasterId(opts, 'havvn-dock-1')).toBe(opts);
  });
});

describe('bindToastRealm', () => {
  it('returns the singleton ITSELF when there is no realm', () => {
    // Not an equivalent wrapper — the same object, so an undetached app has no
    // extra indirection and cannot behave differently.
    expect(bindToastRealm(undefined)).toBe(globalToast);
    expect(bindToastRealm('')).toBe(globalToast);
  });

  it('routes every message call to its realm', () => {
    const impl = spyToast();
    const t = bindToastRealm('havvn-dock-1', impl);
    t('hello');
    t.error('boom');
    t.success('yay', { duration: 1 });
    t.loading('wait');
    t.custom('thing');
    expect(impl.calls).toEqual([
      ['toast', 'hello', { toasterId: 'havvn-dock-1' }],
      ['error', 'boom', { toasterId: 'havvn-dock-1' }],
      ['success', 'yay', { duration: 1, toasterId: 'havvn-dock-1' }],
      ['loading', 'wait', { toasterId: 'havvn-dock-1' }],
      ['custom', 'thing', { toasterId: 'havvn-dock-1' }],
    ]);
  });

  it('defaults the realm on dismiss/remove, which take it as a second argument', () => {
    const impl = spyToast();
    const t = bindToastRealm('havvn-dock-1', impl);
    t.dismiss('abc');
    t.dismiss();
    t.remove('abc');
    t.dismissAll();
    t.removeAll();
    expect(impl.calls).toEqual([
      ['dismiss', 'abc', 'havvn-dock-1'],
      ['dismiss', undefined, 'havvn-dock-1'],
      ['remove', 'abc', 'havvn-dock-1'],
      ['dismissAll', 'havvn-dock-1', undefined],
      ['removeAll', 'havvn-dock-1', undefined],
    ]);
  });

  it('lets an explicit realm through on both shapes of call', () => {
    const impl = spyToast();
    const t = bindToastRealm('havvn-dock-1', impl);
    t.error('boom', { toasterId: 'havvn-dock-3' });
    t.dismiss('abc', 'havvn-dock-3');
    expect(impl.calls).toEqual([
      ['error', 'boom', { toasterId: 'havvn-dock-3' }],
      ['dismiss', 'abc', 'havvn-dock-3'],
    ]);
  });

  it('carries the realm through toast.promise', () => {
    const impl = spyToast();
    const t = bindToastRealm('havvn-dock-1', impl);
    const p = Promise.resolve(1);
    t.promise(p, { loading: 'l', success: 's', error: 'e' });
    expect(impl.calls[0][2]).toEqual({ toasterId: 'havvn-dock-1' });
    return p;
  });
});

describe('useHostToast / useToastRealm', () => {
  const Probe: React.FC = () => {
    const realm = useToastRealm();
    const toast = useHostToast();
    return <i>{`${realm ?? 'none'}:${toast === globalToast ? 'singleton' : 'bound'}`}</i>;
  };

  it('is the plain singleton with no realm provider above (the main window)', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<i>none:singleton</i>');
  });

  it('is bound to the realm inside a detached window\'s subtree', () => {
    expect(renderToStaticMarkup(
      <ToastRealmProvider toasterId="havvn-dock-1"><Probe /></ToastRealmProvider>,
    )).toBe('<i>havvn-dock-1:bound</i>');
  });
});

describe('HostToaster', () => {
  it('renders in place with the default store when given no id or target', () => {
    // The main window's surface: same position, same options, same empty
    // data-rht-toaster as before this module existed.
    const html = renderToStaticMarkup(<HostToaster />);
    expect(html).toContain('data-rht-toaster=""');
    expect(html).toContain('position:fixed');
  });

  it('tags a detached window\'s surface with its store id', () => {
    expect(renderToStaticMarkup(<HostToaster toasterId="havvn-dock-1" />))
      .toContain('data-rht-toaster="havvn-dock-1"');
  });

  it('keeps one description of how a toast looks, wherever it is drawn', () => {
    expect(TOAST_POSITION).toBe('bottom-right');
    expect(TOAST_OPTIONS.duration).toBe(4000);
    expect(TOAST_OPTIONS.style?.background).toBe('var(--color-bg-secondary)');
  });
});

describe('the shadowing contract', () => {
  it('a bound realm exposes every member of the module export', () => {
    // `const toast = useHostToast();` shadows the import, so any member a call
    // site reaches for must exist — including ones the app does not use today.
    const bound = bindToastRealm('havvn-dock-1', spyToast()) as unknown as Record<string, unknown>;
    for (const key of Object.keys(globalToast as unknown as Record<string, unknown>)) {
      expect(typeof bound[key], `toast.${key}`).toBe('function');
    }
    expect(typeof bound).toBe('function');
  });
});

// Guard the assumption the whole design rests on: react-hot-toast 2.6 routes per
// toaster id. If a future bump drops `toasterId`, detached windows silently go
// back to drawing their toasts in the main window — a regression with no error.
describe('library contract', () => {
  it('accepts a toasterId on both the dispatch and the surface', () => {
    const opts = withToasterId(undefined, 'havvn-dock-1');
    expect(opts).toHaveProperty('toasterId');
    const html = renderToStaticMarkup(<HostToaster toasterId="x" />);
    expect(html).toContain('data-rht-toaster="x"');
    expect(vi.isMockFunction(globalToast)).toBe(false);
  });
});
