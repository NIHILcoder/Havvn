/** File byte counts are content on disk, never lifetime network traffic. */
export function fileProgress(length: number, downloaded: number) {
  const knownLength = Number.isSafeInteger(length) && length >= 0;
  const size = knownLength ? length : 0;
  const have = Number.isFinite(downloaded) ? Math.min(size, Math.max(0, Math.floor(downloaded))) : 0;
  return { length: size, downloaded: have, progress: size > 0 ? have / size : knownLength ? 1 : 0 };
}
