/** Presentation only. Keep original errors/codes in services, IPC and saved records. */
export type ErrorLanguage = 'ru' | 'en';

// Each entry explains what happened and gives an available next step. Unknown
// failures deliberately do not guess a cause or claim that an action succeeded.
export const USER_ERRORS = {
  deletionExpired: ['Список для удаления устарел. Нажмите «Обновить список файлов» и подтвердите удаление заново.', 'The deletion preview expired. Refresh the file list and confirm deletion again.'],
  deletionChanged: ['Файлы или параметры загрузки изменились. Обновите список файлов и проверьте удаление заново.', 'The files or download settings changed. Refresh the file list and review deletion again.'],
  deletionUnsafe: ['Путь файла изменился или заменён ссылкой. Удаление остановлено. Проверьте файлы на диске и обновите список; уже удалённые файлы не восстанавливаются.', 'A file path changed or was replaced by a link. Deletion stopped. Check the files on disk and refresh the list; files already deleted are not restored.'],
  deletionMetadata: ['Не удалось получить список файлов торрента. Пока можно убрать только запись из списка, оставив файлы на диске.', 'Torrent metadata is unavailable, so its file list could not be verified. Remove the entry from the list and keep its files on disk.'],
  deletionBusy: ['Открыто слишком много проверок удаления. Закройте другие окна проверки и повторите попытку.', 'Too many deletion previews are open. Close other preview windows and try again.'],
  unexpected: ['Не удалось выполнить действие. Повторите попытку. Если ошибка повторяется, сохраните технические подробности и сообщите о проблеме.', 'The action could not be completed. Try again. If it keeps failing, save the technical details and report the problem.'],
  cancelled: ['Действие отменено. При необходимости запустите его снова.', 'The action was cancelled. Start it again if needed.'],
  diskFull: ['На диске недостаточно свободного места. Освободите место или выберите другой диск и повторите действие.', 'There is not enough free disk space. Free some space or choose another drive, then try again.'],
  permission: ['Нет разрешения на это действие. Проверьте права доступа к файлу, папке или устройству и повторите попытку.', 'Permission was denied. Check access to the file, folder or device, then try again.'],
  fileBusy: ['Файл или папка заняты другой программой. Закройте плеер и другие программы, использующие эти файлы, и повторите действие.', 'The file or folder is in use. Close the player and other programs using these files, then try again.'],
  fileMissing: ['Файл или папка не найдены. Возможно, их переместили или удалили. Проверьте путь и выберите существующий файл или папку.', 'The file or folder was not found. It may have been moved or deleted. Check the path and select an existing file or folder.'],
  fileExists: ['В выбранном месте уже есть такой файл или папка. Выберите другое имя или место сохранения.', 'A file or folder with this name already exists. Choose another name or destination.'],
  readOnly: ['В это место нельзя записывать файлы. Выберите доступную для записи папку или снимите защиту от записи.', 'This location is read-only. Choose a writable folder or remove write protection.'],
  invalidPath: ['Неверный путь или имя файла. Выберите папку заново и уберите из имени запрещённые символы.', 'The path or file name is invalid. Select the folder again and remove invalid characters from the name.'],
  timeout: ['Ответ не получен вовремя. Проверьте соединение и повторите попытку. Недоступный источник может потребовать больше времени.', 'The request timed out. Check the connection and try again. An unavailable source may need more time.'],
  dns: ['Не удалось найти адрес сервера. Проверьте интернет, DNS и адрес источника или выберите другое зеркало.', 'The server address could not be resolved. Check the internet connection, DNS and source address, or choose another mirror.'],
  network: ['Соединение прервалось или недоступно. Проверьте интернет, VPN, прокси и доступность источника, затем повторите попытку.', 'The connection was interrupted or is unavailable. Check the internet connection, VPN, proxy and source availability, then try again.'],
  tls: ['Не удалось установить защищённое соединение. Проверьте дату на компьютере, адрес сайта и его сертификат.', 'A secure connection could not be established. Check the computer date, site address and certificate.'],
  proxy: ['Не удалось подключиться через прокси. Проверьте его адрес, порт, имя пользователя и пароль в настройках соединения.', 'The proxy connection failed. Check its address, port, username and password in connection settings.'],
  auth: ['Для доступа требуется вход или срок сессии истёк. Откройте настройки источника и войдите заново.', 'Sign-in is required or the session has expired. Open the source settings and sign in again.'],
  forbidden: ['Источник отказал в доступе. Проверьте вход на сайт и его ограничения; при необходимости выберите другое зеркало.', 'The source refused access. Check your sign-in and the site restrictions; choose another mirror if needed.'],
  rateLimit: ['Слишком много запросов за короткое время. Подождите немного и повторите попытку.', 'Too many requests were sent in a short time. Wait a little, then try again.'],
  remoteServer: ['Сервер источника временно не может выполнить запрос. Повторите попытку позже или выберите другое зеркало.', 'The source server cannot complete the request right now. Try again later or choose another mirror.'],
  sourceMissing: ['Запрошенный ресурс не найден на сервере. Проверьте ссылку или найдите раздачу заново.', 'The requested resource was not found on the server. Check the link or search for the torrent again.'],
  invalidResponse: ['Источник вернул неподходящий ответ. Проверьте адрес, вход на сайт и зеркало; возможно, плагин источника требует обновления.', 'The source returned an unexpected response. Check the address, sign-in and mirror; the source plugin may need an update.'],
  captcha: ['Сайт требует проверку в браузере. Откройте вход в настройках источника, пройдите проверку и повторите запрос.', 'The site requires a browser check. Open sign-in in the source settings, complete the check and try again.'],
  duplicate: ['Этот торрент уже есть в загрузках. Найдите его в списке и при необходимости возобновите.', 'This torrent is already in Downloads. Find it in the list and resume it if needed.'],
  invalidMagnet: ['Magnet-ссылка повреждена или имеет неподдерживаемый формат. Скопируйте полную ссылку заново либо добавьте файл .torrent.', 'The magnet link is damaged or uses an unsupported format. Copy the complete link again or add a .torrent file.'],
  invalidTorrent: ['Не удалось прочитать данные торрента. Возможно, файл повреждён или по ссылке открывается веб-страница. Скачайте файл .torrent заново или используйте magnet-ссылку.', 'The torrent data could not be read. The file may be damaged, or the link may lead to a web page. Download the .torrent file again or use a magnet link.'],
  metadata: ['Список файлов торрента ещё не получен. Дождитесь подключения к участникам раздачи или используйте файл .torrent. У нерабочей magnet-ссылки метаданные могут не появиться.', 'The torrent file list has not been received yet. Wait for a connection to peers or use a .torrent file. A dead magnet link may never provide metadata.'],
  sequential: ['Не удалось применить режим последовательной загрузки. Выключите этот режим и повторите действие; если торрент уже в списке, попробуйте возобновить его.', 'Sequential download settings could not be applied. Turn this mode off and try again; if the torrent is already in the list, try resuming it.'],
  notActive: ['Загрузка сейчас не активна. Найдите её в списке, возобновите и повторите действие после получения данных о файлах.', 'The download is not active. Find it in the list, resume it and try again after the file information is available.'],
  downloadMissing: ['Этой загрузки больше нет в списке. Обновите список; при необходимости добавьте торрент заново.', 'This download is no longer in the list. Refresh Downloads; add the torrent again if needed.'],
  engine: ['Движок загрузок не отвечает или недоступен. Перезапустите Havvn. Если ошибка повторяется, проверьте установку приложения и технические подробности.', 'The download engine is unavailable or is not responding. Restart Havvn. If the error continues, check the app installation and technical details.'],
  transferBlocked: ['Передача остановлена защитой VPN или проверкой свободного места. Устраните предупреждение в приложении, затем возобновите загрузку.', 'Transfers are blocked by VPN or disk-space protection. Resolve the warning in the app, then resume the download.'],
  incomplete: ['Для этого действия нужны полностью скачанные файлы. Дождитесь завершения загрузки и повторите попытку.', 'This action needs fully downloaded files. Wait for the download to finish, then try again.'],
  roomUnavailable: ['Комната или её соединение сейчас недоступны. Проверьте подключение и попросите другого участника открыть Havvn, затем повторите попытку.', 'The room or its connection is unavailable. Check the connection and ask another member to open Havvn, then try again.'],
  roomEngine: ['Служба комнат не отвечает. Перезапустите Havvn и откройте комнату снова. Если ошибка повторится, сохраните технические подробности.', 'The room service is not responding. Restart Havvn and reopen the room. If the error continues, save the technical details.'],
  roomRemoved: ['Ваш профиль исключён из комнаты. Свяжитесь с владельцем; новое приглашение само по себе не снимает блокировку профиля.', 'Your profile was removed from the room. Contact the owner; a new invite alone does not unblock the profile.'],
  ownerOnly: ['Недостаточно прав для этого действия. Попросите владельца комнаты или ведущего предоставить доступ либо выполнить действие.', 'You do not have permission for this action. Ask the room owner or host to grant access or perform it.'],
  badInvite: ['Приглашение комнаты неверно или неполно. Скопируйте его целиком либо запросите актуальное приглашение у участника.', 'The room invite is invalid or incomplete. Copy the complete invite or ask a member for a current one.'],
  protectedStorage: ['Не удалось открыть или сохранить защищённые данные. Проверьте доступ к диску и системному хранилищу ключей под исходной учётной записью ОС, затем перезапустите Havvn.', 'Protected data could not be opened or saved. Check disk access and the system key store under the original OS account, then restart Havvn.'],
  password: ['Не удалось открыть защищённый файл. Проверьте пароль и целостность файла, затем повторите попытку.', 'The protected file could not be opened. Check the password and file integrity, then try again.'],
  changed: ['Данные или права изменились после открытия окна. Сохраните свой черновик, откройте актуальное состояние и проверьте действие заново.', 'The data or permissions changed after this window was opened. Keep your draft, reopen the current state and review the action again.'],
  expired: ['Срок действия этого просмотра или сеанса истёк. Сохраните черновик, откройте окно заново и повторите действие.', 'This preview or session has expired. Keep your draft, reopen the window and try again.'],
  conflict: ['Обнаружены разные версии данных. Сохраните свой черновик и разрешите конфликт в окне синхронизации перед повтором.', 'Different versions of the data were found. Keep your draft and resolve the conflict in synchronization before trying again.'],
  busy: ['Другая операция ещё выполняется. Дождитесь её завершения и повторите действие.', 'Another operation is still running. Wait for it to finish, then try again.'],
  capacity: ['Достигнут лимит этого раздела. Закройте лишние окна или уберите ненужные записи и повторите действие.', 'The limit for this feature has been reached. Close unused windows or remove unneeded entries, then try again.'],
  unsupported: ['Эта возможность недоступна в текущем движке, браузере или версии приложения. Проверьте поддержку функции в настройках и обновите Havvn при необходимости.', 'This feature is unavailable in the current engine, browser or app version. Check feature support in settings and update Havvn if needed.'],
  validation: ['Параметры заполнены неверно или не подходят для этого действия. Проверьте значения в окне и повторите попытку.', 'The values are invalid or unsuitable for this action. Check the fields in the window and try again.'],
  micMissing: ['Микрофон не найден или недоступен. Подключите его и выберите устройство ввода в настройках голоса.', 'The microphone was not found or is unavailable. Connect it and select an input device in voice settings.'],
  media: ['Не удалось открыть или воспроизвести этот файл. Проверьте, что он доступен и скачан; для неподдерживаемого формата попробуйте внешний плеер.', 'This file could not be opened or played. Check that it is available and downloaded; try an external player for an unsupported format.'],
  mediaProbe: ['Не удалось определить дорожки медиафайла. Дождитесь загрузки файла и повторите проверку. Если ошибка повторяется, проверьте установку Havvn.', 'The media tracks could not be inspected. Wait for the file to download and retry. If the error continues, check the Havvn installation.'],
  playerMissing: ['Внешний плеер не найден. Выберите установленный плеер в настройках Havvn и повторите действие.', 'The external player was not found. Select an installed player in Havvn settings, then try again.'],
  python: ['Для этого источника нужен Python 3. Установите его, перезапустите Havvn и проверьте источник ещё раз.', 'This source requires Python 3. Install it, restart Havvn and test the source again.'],
  portBusy: ['Сетевой порт уже занят. Остановите другую программу, использующую его, или выберите свободный порт в настройках.', 'The network port is already in use. Stop the other program using it or select a free port in settings.'],
} as const;
export type UserErrorCode = keyof typeof USER_ERRORS;

/** Works across realms and for Electron's message-only reconstructed errors. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.code === 'string') return record.code;
  }
  return '';
}

export function unwrapUserError(error: unknown): string {
  let text = errorMessage(error).slice(0, 16000).trim();
  for (let i = 0; i < 8; i++) {
    const next = text.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^(?:[\w.]*Error|Exception):\s*/i, '').trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

export function userErrorCode(error: unknown): UserErrorCode {
  const record = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown; cause?: unknown } : null;
  const text = [typeof record?.code === 'string' ? record.code : '', typeof record?.name === 'string' ? record.name : '', errorMessage(error), errorMessage(record?.cause)].join(' ').slice(0, 20000);
  const systemCodes: Record<string, UserErrorCode> = { ENOSPC: 'diskFull', EBUSY: 'fileBusy', ENOTEMPTY: 'fileBusy', EROFS: 'readOnly', EEXIST: 'fileExists', EADDRINUSE: 'portBusy', EACCES: 'permission', EPERM: 'permission', ENOENT: 'fileMissing', ENOTDIR: 'fileMissing', ENAMETOOLONG: 'invalidPath', ENOTFOUND: 'dns', EAI_AGAIN: 'dns', ETIMEDOUT: 'timeout', ECONNREFUSED: 'network', ECONNRESET: 'network', EHOSTUNREACH: 'network', ENETUNREACH: 'network' };
  const systemCode = typeof record?.code === 'string' ? record.code : /^([A-Z_]+):/.exec(unwrapUserError(error))?.[1];
  if (systemCode && systemCodes[systemCode]) return systemCodes[systemCode];
  const direct = unwrapUserError(error);
  for (const code of ['deletionExpired', 'deletionChanged', 'deletionUnsafe', 'deletionMetadata', 'deletionBusy'] as const) {
    if (USER_ERRORS[code].some(message => message === direct)) return code;
  }
  const matches = (pattern: RegExp) => pattern.test(text);
  if (matches(/piece to sequentially download from is outside|sequential.*(?:pieces? range|failed)/i)) return 'sequential';
  if (matches(/\b(?:ENOSPC|DISK_FULL)\b|no space left|not enough (?:free )?(?:disk )?space|insufficient disk space/i)) return 'diskFull';
  if (matches(/\b(?:EBUSY|ENOTEMPTY)\b|(?:file|directory).*(?:in use|being used by another process)/i)) return 'fileBusy';
  if (matches(/\bEROFS\b|read.only file system/i)) return 'readOnly';
  if (matches(/\bEEXIST\b/)) return 'fileExists';
  if (matches(/\bEADDRINUSE\b|port.*already in use/i)) return 'portBusy';
  if (matches(/\b(?:EACCES|EPERM|NotAllowedError|PERMISSION_DENIED)\b|permission denied|access is denied/i)) return 'permission';
  if (matches(/\bTRANSFER_BLOCKED\b|kill.switch|transfers?.*blocked|rooms are paused.*vpn/i)) return 'transferBlocked';
  if (matches(/room (?:rpc|engine).*(?:not ready|not available|unavailable|not running|crashed)|room networking stopped/i)) return 'roomEngine';
  if (matches(/(?:transmission|torrent) (?:rpc|engine).*(?:not ready|not available|unavailable|not running|crashed|ECONNREFUSED)|transmission binary missing|torrent host.*(?:unavailable|exited|stopped)/i)) return 'engine';
  if (matches(/\bDUPLICATE\b|torrent.*already (?:exists|added|in)/i)) return 'duplicate';
  if (matches(/\bINVALID_MAGNET\b|invalid magnet|bad magnet|missing.*infohash/i)) return 'invalidMagnet';
  if (matches(/\bINVALID_TORRENT\b|invalid torrent|invalid (?:metainfo|bencode)|not a valid torrent|failed to parse torrent/i)) return 'invalidTorrent';
  if (matches(/metadata.*(?:unavailable|not available|not ready|timeout|missing)|\bNO_METADATA\b/i)) return 'metadata';
  if (matches(/\bNOT_COMPLETE\b|must be complete|not fully downloaded/i)) return 'incomplete';
  if (matches(/\bNOT_ACTIVE\b|download.*not active|resume the download manually/i)) return 'notActive';
  if (matches(/download.*(?:not found|removed)|torrent.*not found/i)) return 'downloadMissing';
  if (matches(/\b(?:ENOENT|ENOTDIR)\b|file not found|no such file or directory/i)) return 'fileMissing';
  if (matches(/\bENAMETOOLONG\b|(?:path|file name).*(?:invalid|reserved|too long)|invalid.*(?:path|filename)|absolute.*(?:path|folder).*required/i)) return 'invalidPath';
  if (matches(/python.*(?:missing|not found|required|not installed)/i)) return 'python';
  if (matches(/proxy|\b407\b/i)) return 'proxy';
  if (matches(/captcha|cloudflare|browser check/i)) return 'captcha';
  if (matches(/\b(?:ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED)\b|could not resolve|dns.*(?:fail|error)/i)) return 'dns';
  if (matches(/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|TimeoutError)\b|timed? out|deadline exceeded/i)) return 'timeout';
  if (matches(/\b(?:CERT_[A-Z_]+|ERR_CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_[A-Z_]+)\b|certificate.*(?:invalid|expired)|tls.*(?:fail|error)/i)) return 'tls';
  if (matches(/(?:HTTP|status(?: code)?|response)\s*[:=]?\s*401\b|\bAUTH_REQUIRED\b|login required|session expired.*(?:login|sign)/i)) return 'auth';
  if (matches(/(?:HTTP|status(?: code)?|response)\s*[:=]?\s*403\b/)) return 'forbidden';
  if (matches(/\b(?:RATE_LIMIT|RATE_LIMIT_ERROR)\b|too many requests|(?:HTTP|status)\s*[:=]?\s*429\b/i)) return 'rateLimit';
  if (matches(/(?:HTTP|status(?: code)?|response)\s*[:=]?\s*404\b/i)) return 'sourceMissing';
  if (matches(/(?:HTTP|status(?: code)?|response)\s*[:=]?\s*5\d\d\b/i)) return 'remoteServer';
  if (matches(/\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|NETWORK_ERROR)\b|failed to fetch|network request failed|socket hang up/i)) return 'network';
  if (matches(/unexpected token.*(?:JSON|<)|invalid (?:json|response)|unrecognized (?:page|response)|response.*too large/i)) return 'invalidResponse';
  if (matches(/wrong password|incorrect password|bad decrypt|authentication failed.*(?:backup|archive)|backup.*(?:damaged|corrupt)/i)) return 'password';
  if (matches(/(?:protected|secret|safeStorage|keychain).*(?:unavailable|locked|decrypt|failed)|system encryption unavailable/i)) return 'protectedStorage';
  if (matches(/kicked|removed from (?:the |this )?room|\bROOM_BANNED\b/i)) return 'roomRemoved';
  if (matches(/only (?:the |a |an )?(?:owner|host|authorized|bound writer)|(?:not authorized|not permitted)|insufficient.*rights|\bunauthorized\b/i)) return 'ownerOnly';
  if (matches(/(?:invalid|bad|empty|incomplete).*(?:invite|room code)|room code is required/i)) return 'badInvite';
  if (matches(/(?:room|sync root|document).*(?:unavailable|not active|not found|stopped|paused)|unknown (?:or paused )?sync root/i)) return 'roomUnavailable';
  if (matches(/(?:session|preview|source|request).*(?:expired|no longer valid)|\bEXPIRED\b/i)) return 'expired';
  if (matches(/changed.*(?:review|again)|(?:rights|permissions|membership).*changed|stale.*(?:preview|version)/i)) return 'changed';
  if (matches(/conflict|different content|draft needs review/i)) return 'conflict';
  if (matches(/maintenance.*(?:progress|busy)|operation.*(?:in progress|busy)|already (?:running|pending)/i)) return 'busy';
  if (matches(/capacity|too many (?:open|files|documents)|limit (?:reached|exceeded)/i)) return 'capacity';
  if (matches(/no.mic|microphone.*(?:not found|missing)|requested device not found/i)) return 'micMissing';
  if (matches(/external player.*(?:not found|missing)|player executable.*(?:not found|missing)/i)) return 'playerMissing';
  if (matches(/(?:ffmpeg|ffprobe|audio probe).*(?:failed|missing|not found|unavailable|error|exceeded)/i)) return 'mediaProbe';
  if (matches(/\bMEDIA_ERR_[A-Z_]+\b|no supported source|media.*(?:not supported|unavailable)|unsupported.*(?:codec|media)|could not (?:play|decode)/i)) return 'media';
  if (matches(/\b(?:ABORT_ERR|AbortError|CANCELLED|CANCELED)\b|(?:operation|request|preparation).*(?:cancelled|canceled)/i)) return 'cancelled';
  if (matches(/not supported|unsupported|requires.*(?:protocol|version)|update required/i)) return 'unsupported';
  if (matches(/\b(?:INVALID_INPUT|VALIDATION_ERROR)\b|invalid |must be |cannot be empty|is required|too long \(max/i)) return 'validation';
  return 'unexpected';
}

export function describeUserError(error: unknown, language: ErrorLanguage): string {
  return USER_ERRORS[userErrorCode(error)][language === 'ru' ? 0 : 1];
}

/** Diagnostics are opt-in, bounded and redacted; never execute/render upstream HTML. */
export function userErrorDetails(error: unknown): string {
  return errorMessage(error).slice(0, 12000)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=][^\r\n]+/gi, '$1: [redacted]')
    .replace(/(["']?\b(?:password|passwd|token|api[-_]?key|credential|secret|invite)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1[redacted]')
    .slice(0, 2000);
}
