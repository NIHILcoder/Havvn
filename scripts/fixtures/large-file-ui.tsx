// Production components in an isolated renderer; no real torrents or user profile.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { FilePreview } from '../../renderer/components/FilePreview';
import { TorrentFileSelector } from '../../renderer/components/TorrentFileSelector';
import { TorrentControlModal } from '../../renderer/components/TorrentControlModal';
import { I18nProvider } from '../../renderer/utils/i18nContext';
import { ConfirmProvider } from '../../renderer/components/ConfirmDialog';
import type { Download, TorrentFile } from '../../shared/types';
import { engineCapabilities } from '../../shared/engine-capabilities';
import '../../renderer/index.css';

localStorage.setItem('language', 'ru');
document.documentElement.dataset.theme = 'dark';
const style = document.createElement('style');
style.textContent = '*{animation:none!important;transition:none!important}body{margin:0}';
document.head.append(style);
const fixture = {
  files: [] as TorrentFile[], confirmed: [] as number[], priorities: [] as number[], pulls: 0,
  startedAt: 0, holdConfirm: false, finishConfirm: undefined as undefined | (() => void),
  mount: (_kind: string, _count: number, _layout?: 'mixed' | 'folders') => {},
};
Object.assign(window, { fixture });
Object.assign(window, { api: {
  getEngineCapabilities: async () => engineCapabilities('native'),
  getSettings: async () => ({ defaultDownloadDir: 'D:\\Downloads' }),
  getCategories: async () => [], onCategoriesChanged: () => () => {},
  getTorrentInfo: async () => ({ name: 'Большой архив', totalSize: fixture.files.reduce((s, f) => s + f.length, 0),
    files: fixture.files.map(f => ({ path: f.path, index: f.index, size: f.length })) }),
  getTorrentFiles: async () => { fixture.pulls++; return fixture.files.map(f => ({ ...f })); },
  historyPlayback: { files: async () => fixture.files.map(f => ({ ...f })) },
  setFilePriority: async (_id: string, index: number, priority: string) => {
    fixture.priorities.push(index);
    fixture.files = fixture.files.map(f => f.index === index ? { ...f, priority } as TorrentFile : f);
  },
  resourceMode: { get: async () => ({ economy: false }), onChanged: () => () => {} },
} });
const root = createRoot(document.querySelector('#root')!);
fixture.mount = (kind, count, layout) => {
  fixture.files = Array.from({ length: count }, (_, i) => ({ index: i * 2 + 7,
    name: `file-${String(i).padStart(5, '0')}.${i % 2 ? 'txt' : 'mkv'}`,
    path: `Archive/${i % 10 === 0 ? 'selected-group/' : ''}directory-${i % 20}/file-${String(i).padStart(5, '0')}.${i % 2 ? 'txt' : 'mkv'}`,
    length: (i + 1) * 100, downloaded: 0, progress: 0, priority: 'normal',
  }));
  if (layout) fixture.files = fixture.files.map((file, i) => {
    const names = ['movie.MP4', 'movie.mkv', 'preview.avi', 'movie.srt', 'movie.ASS', 'info.txt', 'movie.nfo', 'sample.mp4'];
    const name = layout === 'folders' ? 'movie.mkv' : names[i % names.length];
    return { ...file, name, path: `Archive/group-${layout === 'folders' ? i : Math.floor(i / names.length)}/${name}` };
  });
  fixture.confirmed = []; fixture.priorities = []; fixture.pulls = 0;
  fixture.startedAt = performance.now();
  const close = () => {};
  const element = kind === 'preview' ? <FilePreview downloadId={`large-${count}`} onClose={close} />
    : kind === 'selector' ? <TorrentFileSelector magnetUri={`magnet:?fixture=${count}`} onCancel={close}
      onConfirm={async indices => { fixture.confirmed = indices; if (fixture.holdConfirm) await new Promise<void>(resolve => { fixture.finishConfirm = resolve; }); }} />
    : <TorrentControlModal download={{ id: `large-${count}`, name: 'Archive', savePath: 'D:\\Downloads',
      status: 'downloading', progress: 0 } as Download} onClose={close} />;
  flushSync(() => root.render(<I18nProvider><ConfirmProvider>{element}</ConfirmProvider></I18nProvider>));
};
