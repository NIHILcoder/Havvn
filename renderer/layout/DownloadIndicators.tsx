import React from 'react';
import { useDownloads } from '../state/downloads';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';

export const DownloadSidebar: React.FC<Omit<React.ComponentProps<typeof Sidebar>, 'downloadCounts' | 'activeDownloads'>> = props => {
  const counts = useDownloads(s => s.counts);
  const active = useDownloads(s => s.totals.active);
  return <Sidebar {...props} downloadCounts={counts} activeDownloads={active} />;
};

export const DownloadStatusBar: React.FC<Omit<React.ComponentProps<typeof StatusBar>, 'totalDownSpeed' | 'totalUpSpeed' | 'activeDownloads' | 'connectedPeers'>> = props => {
  const down = useDownloads(s => s.totals.downSpeed), up = useDownloads(s => s.totals.upSpeed);
  const active = useDownloads(s => s.totals.active), peers = useDownloads(s => s.totals.peers);
  return <StatusBar {...props} totalDownSpeed={down} totalUpSpeed={up} activeDownloads={active} connectedPeers={peers} />;
};
