/**
 * Turning a game-server failure from the main process into a sentence in the
 * user's language.
 *
 * The main process holds no dictionary, which is why the game modules return
 * translation keys rather than English prose. The MANAGER layer did not follow
 * that rule: it threw `new Error('stop the server before reinstalling')` and the
 * renderer toasted the string verbatim, so a Russian UI had a dozen English
 * sentences in it. shared/gameserver-errors.ts now answers with codes, and this is
 * the one place that maps them to text.
 *
 * Lives in its own file rather than in RoomServerPanel because ServerConfigForm
 * needs it too, and RoomServerPanel imports ServerConfigForm — putting it there
 * would make the pair circular.
 */
import { useCallback } from 'react';
import { useTranslation } from '../../utils/i18nContext';
import { readableError } from '../../utils/error-messages';
import {
  serverErrorCode,
  unwrapErrorMessage,
  classifySystemError,
} from '../../../shared/gameserver-errors';
import type { ServerErrorCode } from '../../../shared/gameserver-errors';

/**
 * `(err) => { text, code }`, accepting anything that can arrive: a thrown Error,
 * the message Electron rewrapped it into, or a bare `reason` code from a
 * `{ ok: false }` result.
 *
 * Order of preference:
 *   1. an intentional refusal code (havvn-server-err:…)
 *   2. a recognised OS shape (ENOTEMPTY → files-busy)
 *   3. the shared localized explanation, with an honest unknown-error fallback.
 * Original errors remain in IPC/service logs; raw upstream text is not a UI label.
 */
export function useServerErrorParts(): (err: unknown) => { text: string; code: ServerErrorCode | null } {
  const { t, language } = useTranslation();
  return useCallback((err: unknown) => {
    const tagged = serverErrorCode(err);
    const raw = unwrapErrorMessage(err);
    const code = tagged ?? classifySystemError(raw);
    if (code) {
      const text = t(`rooms.server.err.${code}` as never);
      return { text, code };
    }
    return { text: readableError(err, language), code: null };
  }, [t, language]);
}

/** The same, for the many call sites that only want something to put in a toast. */
export function useServerError(): (err: unknown) => string {
  const parts = useServerErrorParts();
  return useCallback((err: unknown): string => parts(err).text, [parts]);
}
