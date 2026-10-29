import { describe, expect, it } from 'vitest';
import { describeUserError, errorMessage, unwrapUserError, userErrorCode, userErrorDetails, USER_ERRORS, type UserErrorCode } from './user-errors';

describe('plain-language errors without changing source errors', () => {
  it.each(['deletionExpired', 'deletionChanged', 'deletionUnsafe', 'deletionMetadata', 'deletionBusy'] as const)('explains %s in both languages across the IPC wrapper', code => {
    const error = new Error("Error invoking remote method 'downloads:remove': Error: " + USER_ERRORS[code][1]);
    expect(describeUserError(error, 'ru')).toBe(USER_ERRORS[code][0]);
    expect(describeUserError(error, 'en')).toBe(USER_ERRORS[code][1]);
  });
  const cases: Array<[string, UserErrorCode]> = [
    ["Error invoking remote method 'downloads:add': Error: TransmissionRpcError: transmission rpc torrent-set: piece to sequentially download from is outside pieces range", 'sequential'],
    ['Torrent metadata is unavailable; cannot delete its files yet (NOT_ACTIVE)', 'metadata'],
    ['Torrent already exists (DUPLICATE)', 'duplicate'], ['Invalid magnet URI', 'invalidMagnet'], ['Invalid torrent file', 'invalidTorrent'],
    ['transmission binary missing at C:/engine', 'engine'], ['Room engine crashed', 'roomEngine'], ['download not found', 'downloadMissing'],
    ['Media unavailable: resume the download manually (NOT_ACTIVE)', 'notActive'], ['must be complete before sharing (NOT_COMPLETE)', 'incomplete'],
    ['ENOSPC: no space left on device, write', 'diskFull'], ['EACCES: permission denied, open', 'permission'], ['EPERM: operation not permitted', 'permission'],
    ['ENOTEMPTY: directory not empty, rmdir', 'fileBusy'], ['EBUSY: resource busy or locked', 'fileBusy'], ['EROFS: read-only file system', 'readOnly'],
    ['ENOENT: no such file or directory', 'fileMissing'], ['EEXIST: file already exists', 'fileExists'], ['EADDRINUSE: address already in use', 'portBusy'],
    ['ENOTFOUND: getaddrinfo failed', 'dns'], ['ETIMEDOUT: request failed', 'timeout'], ['ECONNRESET: socket closed', 'network'],
    ['CERT_HAS_EXPIRED: certificate has expired', 'tls'], ['HTTP 407: authentication required', 'proxy'], ['HTTP 401', 'auth'],
    ['HTTP 403', 'forbidden'], ['HTTP 404', 'sourceMissing'], ['HTTP 429', 'rateLimit'], ['HTTP 503', 'remoteServer'],
    ['Unexpected token < in JSON at position 0', 'invalidResponse'], ['captcha required', 'captcha'], ['Python 3 is required for this source', 'python'],
    ['Protected documents unavailable; restart after restoring storage access', 'protectedStorage'], ['Only the owner can create a sync folder', 'ownerOnly'],
    ['Document session expired', 'expired'], ['Document rights changed; review again', 'changed'], ['Ambiguous sync conflict requires manual inspection', 'conflict'],
    ['Sync maintenance in progress', 'busy'], ['Document catalog capacity reached', 'capacity'], ['Invalid sync folder name', 'validation'],
    ['Requested device not found', 'micMissing'], ['NotAllowedError: Permission denied', 'permission'], ['ffmpeg probe failed', 'mediaProbe'],
    ['No supported source was found', 'media'], ['External player executable not found', 'playerMissing'], ['Sync preparation canceled', 'cancelled'],
    ['Protocol version is not supported', 'unsupported'], ['Some private internal exception', 'unexpected'],
  ];
  it.each(cases)('explains %s', (message, code) => {
    const error = new Error(message), before = error.message;
    expect(userErrorCode(error)).toBe(code);
    expect(describeUserError(error, 'ru')).toBe(USER_ERRORS[code][0]);
    expect(describeUserError(error, 'en')).toBe(USER_ERRORS[code][1]);
    expect(error.message).toBe(before);
  });
  it('trusts a structured OS code over misleading file names', () => {
    expect(userErrorCode({ code: 'ENOENT', message: 'Could not open C:/ENOSPC.txt' })).toBe('fileMissing');
    expect(userErrorCode({ code: 'EACCES', message: '' })).toBe('permission');
  });
  it('accepts cross-realm message objects and harmless empty/unknown thrown values', () => {
    expect(errorMessage({ message: 'HTTP 429' })).toBe('HTTP 429');
    for (const value of [null, undefined, false, 42, {}, { message: 23 }]) expect(userErrorCode(value)).toBe('unexpected');
    expect(unwrapUserError('Error: Error invoking remote method \'x\': TorrentError: DUPLICATE')).toBe('DUPLICATE');
  });
  it('redacts credentials and bounds opt-in diagnostic text', () => {
    const detail = userErrorDetails(new Error('https://alice:password@example.invalid/?token=secret&api_key=key\nAuthorization: Bearer private\n' + 'x'.repeat(5000)));
    expect(detail).not.toContain('password'); expect(detail).not.toContain('=secret'); expect(detail).not.toContain('=key'); expect(detail).not.toContain('Bearer private');
    expect(detail.length).toBeLessThanOrEqual(2000);
    expect(userErrorDetails('{"password":"my private password", "token":"private-token"}')).not.toContain('private');
  });
});
