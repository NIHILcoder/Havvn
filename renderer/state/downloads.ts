import { useStore } from 'zustand';
import { createDownloadState, DownloadState } from './download-state';

export const downloadsModel = createDownloadState(() => window.api);
export const useDownloads = <T,>(selector: (state: DownloadState) => T): T => useStore(downloadsModel.store, selector);
