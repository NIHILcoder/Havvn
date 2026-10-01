import React from 'react';
import type { ReleaseGroup } from '../../shared/release-groups';
import type { MergedResult } from '../../shared/search-dedupe';
import type { ReleaseMedia } from '../../shared/release-languages';
import { releaseComparison } from '../../shared/release-comparison';
import { useTranslation } from '../utils/i18nContext';
import { formatBytes } from '../utils/format-helpers';
import Modal from './Modal';
import { Button } from './Button';
import './ReleaseComparison.css';

export function ReleaseComparison({ group, onClose, onDownload, downloadState }: {
  group: ReleaseGroup; onClose: () => void; onDownload: (row: MergedResult) => void;
  downloadState: (row: MergedResult) => { busy: boolean; added: boolean; completed: boolean };
}) {
  const { t, language } = useTranslation();
  const languageNames = new Intl.DisplayNames([language], { type: 'language' });
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  const languages = (codes?: string[]) => (codes ?? []).map(code => languageNames.of(code) ?? code).join(', ');
  const unknown = t('search.compare.unknown');
  const subtitleText = (media: ReleaseMedia) => {
    if (media.hasSubtitles === false && media.subtitleLanguages?.length) return t('search.compare.conflict');
    if (media.hasSubtitles === false) return t('search.compare.noSubtitles');
    return languages(media.subtitleLanguages) || (media.hasSubtitles === true ? t('search.compare.subtitlesPresent') : unknown);
  };
  const time = (at?: number) => Number.isFinite(at) && at! > 0 && at! <= 8.64e15 ? dateFormat.format(at) : unknown;
  return <Modal size="full" className="release-comparison" title={t('search.compare.title')} onClose={onClose}>
    <p className="comparison-work">{[group.title, group.year, group.episode].filter(Boolean).join(' · ')}</p>
    <p className="comparison-explanation">{t('search.compare.hint')}</p>
    <div className="comparison-grid">
      {group.releases.map((row, index) => {
        const { title, reported, sources } = releaseComparison(row);
        const state = downloadState(row);
        const reportedAudio = reported.filter(({ media }) => media.audioLanguages?.length);
        const reportedSubtitles = reported.filter(({ media }) => media.hasSubtitles !== undefined || media.subtitleLanguages?.length);
        const evidence = (value: string, from: 'title' | 'api', source?: string) => <span className="comparison-evidence">
          <span>{value}</span><small title={t('search.compare.hint')}>{t(from === 'title' ? 'search.compare.fromTitle' : 'search.compare.fromApi')}{source ? ` · ${source}` : ''}</small>
        </span>;
        return <article className="comparison-card" key={JSON.stringify([row.infoHash, row.title, row.size, index])}>
          <h4>{row.title}</h4>
          <dl>
            <div><dt>{t('search.media.resolution')}</dt><dd>{title.resolutions.length ? evidence(title.resolutions.join(', '), 'title') : unknown}</dd></div>
            <div><dt>{t('search.media.codec')}</dt><dd>{title.codecs.length ? evidence(title.codecs.join(', '), 'title') : unknown}</dd></div>
            <div><dt>{t('search.media.voice')}</dt><dd>{title.voices.length ? evidence(title.voices.join(', '), 'title') : unknown}</dd></div>
            <div className="comparison-audio"><dt>{t('search.preferences.language')}</dt><dd>
              {reportedAudio.map(({ source, media }, i) => <span key={i}>{evidence(languages(media.audioLanguages), 'api', source.indexer || source.provider)}</span>)}
              {!!title.audioLanguages?.length && evidence(languages(title.audioLanguages), 'title')}
              {!reportedAudio.length && !title.audioLanguages?.length && unknown}
            </dd></div>
            <div className="comparison-subtitles"><dt>{t('search.compare.subtitles')}</dt><dd>
              {reportedSubtitles.map(({ source, media }, i) => <span key={i}>{evidence(subtitleText(media), 'api', source.indexer || source.provider)}</span>)}
              {title.hasSubtitles !== undefined && evidence(subtitleText(title), 'title')}
              {!reportedSubtitles.length && title.hasSubtitles === undefined && unknown}
            </dd></div>
            <div><dt>{t('search.compare.format')}</dt><dd>{title.sources.length || title.features.length ? evidence([...title.sources, ...title.features].join(' · '), 'title') : unknown}</dd></div>
            <div><dt>{t('table.size')}</dt><dd>{Number.isFinite(row.size) && row.size > 0 ? formatBytes(row.size) : unknown}</dd></div>
          </dl>
          <div className="comparison-sources">
            <h5>{t('search.compare.sources')}</h5>
            <ul>{sources.map((source, i) => <li key={i}>
              <strong>{[source.provider, source.indexer].filter(Boolean).join(' · ')}</strong>
              <span>{t('search.compare.seeds')}: {source.seeds} · {t('search.compare.leechers')}: {source.leechers}</span>
              <span className="comparison-check">{t('search.compare.received')}: {time(source.checkedAt)}</span>
            </li>)}</ul>
          </div>
          <Button className="comparison-download" variant={state.added ? 'secondary' : 'primary'} loading={state.busy}
            disabled={state.busy || state.added || (!row.magnetUri && !row.torrentUrl && !row.sourceRefs?.length)} onClick={() => onDownload(row)}>
            {t(state.completed ? 'search.state.downloaded' : state.added ? 'search.state.inDownloads' : 'search.download')}
          </Button>
        </article>;
      })}
    </div>
  </Modal>;
}
