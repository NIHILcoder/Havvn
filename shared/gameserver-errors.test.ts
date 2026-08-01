/**
 * The reason these tests exist at all is that the round trip they cover is the
 * ONLY thing keeping the server panel's error messages translatable: a code
 * written in the main process has to survive Electron rewrapping the message, and
 * neither half can be observed from the other. If the prefix or the parse drifts,
 * every refusal silently degrades back to English prose in a Russian UI — which
 * is exactly the bug this file was added to close.
 */
import { describe, it, expect } from 'vitest';
import {
  ServerActionError, serverErrorCode, serverErrorDetail, isServerErrorCode,
  SERVER_ERR_PREFIX, unwrapErrorMessage, classifySystemError, clipErrorDetail,
} from './gameserver-errors';

/** What ipcRenderer.invoke() actually delivers to the renderer: our message,
 *  wrapped in Electron's own text on both sides. */
const throughIpc = (err: Error): string =>
  `Error invoking remote method 'rooms:srvInstall': Error: ${err.message}`;

describe('a refusal survives the trip through IPC', () => {
  it('recovers the code from the rewrapped message', () => {
    const wire = throughIpc(new ServerActionError('stop-first'));
    expect(serverErrorCode(wire)).toBe('stop-first');
    expect(serverErrorDetail(wire)).toBeNull();
  });

  it('keeps the detail separate from the code even when it has spaces', () => {
    const wire = throughIpc(new ServerActionError('disk-space', '1.2 GB free, ~3.0 GB needed'));
    expect(serverErrorCode(wire)).toBe('disk-space');
    expect(serverErrorDetail(wire)).toBe('1.2 GB free, ~3.0 GB needed');
  });

  it('reads a thrown error directly, without the IPC hop', () => {
    const err = new ServerActionError('unknown-version', 'paper 1.21.4');
    expect(serverErrorCode(err)).toBe('unknown-version');
    expect(serverErrorDetail(err)).toBe('paper 1.21.4');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('unknown-version');
  });

  it('reads a bare code, for the results that come back as a value', () => {
    // supervisor.sendCommand answers `{ ok: false, reason: 'not-running' }`;
    // there is no message for a prefix to live in.
    expect(serverErrorCode('not-running')).toBe('not-running');
    expect(isServerErrorCode('not-running')).toBe(true);
  });
});

describe('a genuine upstream fault is left alone', () => {
  it('reports no code for an ordinary network error', () => {
    expect(serverErrorCode(new Error('fetch failed: ECONNRESET'))).toBeNull();
    expect(serverErrorCode(new Error('HTTP 404 for https://example.invalid/x.jar'))).toBeNull();
    expect(serverErrorDetail(new Error('fetch failed'))).toBeNull();
  });

  it('reports no code for nullish and non-error values', () => {
    expect(serverErrorCode(undefined)).toBeNull();
    expect(serverErrorCode(null)).toBeNull();
    expect(serverErrorCode(42)).toBeNull();
    expect(serverErrorCode({ code: 'stop-first' })).toBeNull();
  });

  it('refuses a marker carrying something that is not one of our codes', () => {
    // Upstream text could contain the prefix by accident or by malice; only the
    // closed set is honoured, so the renderer never asks for a missing key.
    expect(serverErrorCode(`${SERVER_ERR_PREFIX}rm-rf`)).toBeNull();
    expect(isServerErrorCode('rm-rf')).toBe(false);
  });
});

describe('unwrapErrorMessage', () => {
  it('strips the Electron IPC wrapper and repeated Error: prefixes', () => {
    const wire = throughIpc(new Error('ENOTEMPTY, Directory not empty: C:\\Servers\\x'));
    expect(unwrapErrorMessage(wire)).toBe('ENOTEMPTY, Directory not empty: C:\\Servers\\x');
    expect(unwrapErrorMessage(new Error('Error: Error: boom'))).toBe('boom');
  });
});

describe('classifySystemError', () => {
  it('maps the Windows delete failures that used to overflow the toast', () => {
    expect(classifySystemError('ENOTEMPTY, Directory not empty: \\\\?\\C:\\Users\\x\\AppData\\Roaming\\havvn\\servers\\abc')).toBe('files-busy');
    expect(classifySystemError('EBUSY: resource busy or locked')).toBe('files-busy');
    expect(classifySystemError('EPERM: operation not permitted')).toBe('files-locked');
    expect(classifySystemError('no such server instance: abc')).toBe('unknown-instance');
    expect(classifySystemError('fetch failed: ECONNRESET')).toBeNull();
  });
});

describe('clipErrorDetail', () => {
  it('collapses a long havvn path and hard-caps length', () => {
    const long = 'ENOTEMPTY, Directory not empty: \\\\?\\C:\\Users\\PRXNHL\\AppData\\Roaming\\havvn\\servers\\9992feff94344d24b4bf50084324ffca';
    const clipped = clipErrorDetail(long, 80);
    expect(clipped.length).toBeLessThanOrEqual(80);
    expect(clipped).toContain('…/');
    expect(clipped).not.toContain('AppData');
  });
});
