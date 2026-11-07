import { describe, expect, it, vi } from 'vitest';
import { loadDevelopmentRenderer } from './load-renderer';

const networkError = (code = 'ERR_FAILED') => Object.assign(new Error(`${code} loading renderer`), { code });

describe('development window startup', () => {
  it('recovers a transient Chromium failure at the exact local renderer URL', async () => {
    const loadURL = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValue(undefined), retry = vi.fn();
    await loadDevelopmentRenderer({ loadURL, isDestroyed: () => false }, retry);
    expect(loadURL.mock.calls).toEqual([['http://127.0.0.1:3000/'], ['http://127.0.0.1:3000/']]);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('fails after three attempts instead of hanging startup forever', async () => {
    const error = networkError(), loadURL = vi.fn().mockRejectedValue(error), retry = vi.fn();
    await expect(loadDevelopmentRenderer({ loadURL, isDestroyed: () => false }, retry)).rejects.toBe(error);
    expect(loadURL).toHaveBeenCalledTimes(3);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it.each(['ERR_BLOCKED_BY_CLIENT', 'ERR_ACCESS_DENIED', 'ERR_ABORTED', 'ERR_CERT_AUTHORITY_INVALID'])('does not retry policy/certificate denial or canceled navigation: %s', async code => {
    const error = networkError(code), loadURL = vi.fn().mockRejectedValue(error), retry = vi.fn();
    await expect(loadDevelopmentRenderer({ loadURL, isDestroyed: () => false }, retry)).rejects.toBe(error);
    expect(loadURL).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does not reopen an app window closed during the retry delay', async () => {
    let destroyed = false;
    const error = networkError(), loadURL = vi.fn().mockRejectedValue(error);
    await expect(loadDevelopmentRenderer({ loadURL, isDestroyed: () => destroyed }, () => { destroyed = true; })).rejects.toBe(error);
    expect(loadURL).toHaveBeenCalledOnce();
  });
});
