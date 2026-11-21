import { beforeAll, describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ru from '../i18n/ru.json';
import { localizeKnownText, readableError, registerErrorTranslations } from './error-messages';
import { USER_ERRORS } from '../../shared/user-errors';
import { cleanError } from './format-helpers';

beforeAll(() => { registerErrorTranslations('en', en); registerErrorTranslations('ru', ru); });
describe('error presentation follows the selected language', () => {
  it('keeps useful existing localized messages and translates old saved ones', () => {
    expect(readableError(ru['rooms.sync.workCanceled'], 'ru')).toBe(ru['rooms.sync.workCanceled']);
    expect(readableError(ru['rooms.sync.workCanceled'], 'en')).toBe(en['rooms.sync.workCanceled']);
    expect(readableError(en['common.copyFailed'], 'ru')).toBe(ru['common.copyFailed']);
  });
  it('preserves translated action context while replacing the technical cause', () => {
    expect(readableError(ru['downloads.failAddTorrent'] + ': Error invoking remote method \'downloads:add\': Error: DUPLICATE', 'en'))
      .toBe(en['downloads.failAddTorrent'] + ': ' + USER_ERRORS.duplicate[1]);
  });
  it('translates template parameters without changing user data', () => {
    registerErrorTranslations('en', { ...en, 'test.failed': 'Could not open {name}. Try again.' });
    registerErrorTranslations('ru', { ...ru, 'test.failed': 'Не удалось открыть {name}. Повторите попытку.' });
    expect(readableError('Could not open my-file.bin. Try again.', 'ru')).toBe('Не удалось открыть my-file.bin. Повторите попытку.');
  });
  it('uses an honest fallback for unknown failures in either language', () => {
    expect(readableError('TypeError: strangeInternalFunction is not defined', 'ru')).toBe(USER_ERRORS.unexpected[0]);
    expect(readableError({ message: 'vendor opaque exception' }, 'en')).toBe(USER_ERRORS.unexpected[1]);
    expect(readableError({ code: 'EACCES', message: '' }, 'ru')).toBe(USER_ERRORS.permission[0]);
  });
  it('does not alter the raw parser used by room joining and other control flow', () => {
    const raw = "Error invoking remote method 'rooms:join': Error: Rooms are paused by VPN";
    expect(cleanError(raw)).toBe('Rooms are paused by VPN');
    expect(readableError(raw, 'ru')).toBe(USER_ERRORS.transferBlocked[0]);
  });
  it('also translates a queued dialog title instead of treating it as an unknown failure', () => {
    expect(localizeKnownText(ru['rss.error.title'], 'en')).toBe(en['rss.error.title']);
    expect(localizeKnownText('Custom user title', 'en')).toBe('Custom user title');
  });
});
