import type { MergedResult, SourceObservation } from './search-dedupe';
import { parseReleaseMetadata } from './release-metadata';
import { sanitizeReleaseMedia } from './release-languages';

export function releaseObservations(row: MergedResult): SourceObservation[] {
  return row.observations ?? [{ provider: row.provider, indexer: row.indexer, checkedAt: row.checkedAt,
    seeds: row.seeds, leechers: row.leechers, media: row.media }];
}

/** Keep reported evidence separate from title hints, including disagreements. */
export function releaseComparison(row: MergedResult) {
  const title = parseReleaseMetadata(row.title);
  const sources = releaseObservations(row);
  const reported = sources.flatMap(source => {
    const media = sanitizeReleaseMedia(source.media);
    return media ? [{ source, media }] : [];
  });
  const reportedAudio = [...new Set(reported.flatMap(({ media }) => media.audioLanguages ?? []))];
  // Preferences use explicit source labels first; subtitle languages never count.
  const metadata = { ...title, audioLanguages: reportedAudio.length ? reportedAudio : title.audioLanguages };
  return { title, reported, sources, metadata };
}
