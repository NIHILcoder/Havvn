import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Download, DownloadStats } from '../../shared/types';

vi.mock('../utils/i18nContext', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { DownloadItem, type DownloadItemProps } from './DownloadItem';

const GB = 1024 ** 3;
const download: Download = {
  id: 'resumed', name: 'Battlefield.V-CPY', sourceType: 'magnet', sourceUri: 'magnet:?xt=test',
  torrentFilePath: null, savePath: 'D:/downloads', status: 'paused', progress: 0.5,
  totalSize: 50 * GB, downloadedBytes: 26.22 * GB, uploadedBytes: 344.78 * 1024 ** 2,
  downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0,
  priority: 1, category: null, createdAt: new Date(), updatedAt: new Date(), lastError: null,
};
const noop = () => {};

function render(overrides: Partial<DownloadItemProps> = {}) {
  return renderToStaticMarkup(<DownloadItem
    download={download} stats={undefined} viewMode="detailed"
    onPause={noop} onResume={noop} onRemove={noop} onStopSeeding={noop} onRetry={noop}
    onOpenFolder={noop} onShowFiles={noop} {...overrides}
  />);
}

function stats(overrides: Partial<DownloadStats>): DownloadStats {
  return {
    id: download.id, status: 'downloading', progress: 0.009,
    downloadedBytes: 26.22 * GB, uploadedBytes: 344.78 * 1024 ** 2,
    downSpeedBps: 0, upSpeedBps: 0, etaSeconds: null, peers: 0, seeds: 0,
    ...overrides,
  };
}

function detailedSize(html: string) {
  return html.match(/downloads\.statSize<\/span>\s*<span class="stat-value">([^<]*)<\/span>/)?.[1];
}

describe.each([
  { label: 'detailed view', viewMode: 'detailed' as const, expanded: false },
  { label: 'expanded compact row', viewMode: 'compact' as const, expanded: true },
])('torrent size in $label', ({ viewMode, expanded }) => {
  it.each([
    { progress: 0, downloadedBytes: 0 },
    { progress: 0.009, downloadedBytes: 26.22 * GB },
    { progress: 0.191, downloadedBytes: 35.44 * GB },
    { progress: 1, downloadedBytes: 100 * GB },
  ])('uses metadata with progress=$progress, transferred=$downloadedBytes', (snapshot) => {
    const html = render({ viewMode, expanded, stats: stats(snapshot) });
    expect(detailedSize(html)).toBe('50 GB');
  });

  it('keeps the persisted size while paused without live stats', () => {
    expect(detailedSize(render({ viewMode, expanded }))).toBe('50 GB');
  });

  it.each([0, -1, NaN, Infinity])('shows unknown metadata size %s without estimating it', (totalSize) => {
    const html = render({ viewMode, expanded, download: { ...download, totalSize }, stats: stats({}) });
    expect(detailedSize(html)).toBe('--');
  });
});

it('shows the same metadata size in the compact row with inconsistent transfer counters', () => {
  const html = render({ viewMode: 'compact', stats: stats({}) });
  expect(html).toContain('<div class="trow-sub"><span>50 GB</span>');
});
