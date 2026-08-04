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
import {
  serverErrorCode,
  serverErrorDetail,
  unwrapErrorMessage,
  classifySystemError,
  clipErrorDetail,
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
 *   3. the unwrapped technical text, clipped so a toast stays inside the window
 *
 * A fault with no code — a reset connection, a mirror answering 404 — comes back
 * AS IS (clipped) with `code: null`. Substituting a friendly-but-invented sentence
 * for a real upstream error would cost the user the only clue they had.
 */
export function useServerErrorParts(): (err: unknown) => { text: string; code: ServerErrorCode | null } {
  const { t } = useTranslation();
  return useCallback((err: unknown) => {
    const tagged = serverErrorCode(err);
    const raw = unwrapErrorMessage(err);
    const code = tagged ?? classifySystemError(raw);
    if (code) {
      const text = t(`rooms.server.err.${code}` as never);
      // Only intentional details (byte counts, version ids) ride along. The raw
      // ENOTEMPTY path dump is what blew past the window edge — dropping it once
      // we have a translated sentence is the whole point of classifying it.
      const detail = tagged ? serverErrorDetail(err) : null;
      if (detail) {
        const clipped = clipErrorDetail(detail, 120);
        if (clipped && clipped !== text) return { text: `${text} (${clipped})`, code };
      }
      return { text, code };
    }
    return { text: clipErrorDetail(raw || String(err)), code: null };
  }, [t]);
}

/** The same, for the many call sites that only want something to put in a toast. */
export function useServerError(): (err: unknown) => string {
  const parts = useServerErrorParts();
  return useCallback((err: unknown): string => parts(err).text, [parts]);
}
