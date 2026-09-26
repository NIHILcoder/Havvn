import { useEffect, useRef } from 'react';
import { retimeSubtitleTrack, type PlayerPreferences } from '../../shared/player-preferences';

export function useSubtitlePresentation(media: HTMLMediaElement | null, prefs: PlayerPreferences, offset: number, source: string | null): void {
  const originals = useRef(new WeakMap<object, { start: number; end: number }>());
  const suppressed = useRef(new WeakMap<object, Set<TextTrackCue>>());
  useEffect(() => {
    if (!media) return;
    const apply = () => { for (const track of Array.from(media.textTracks)) retimeSubtitleTrack(track, prefs.subtitleDelay - offset, originals.current, suppressed.current); };
    const tracks = media.querySelectorAll('track');
    tracks.forEach(track => track.addEventListener('load', apply));
    media.textTracks.addEventListener('addtrack', apply);
    media.addEventListener('loadedmetadata', apply);
    apply();
    return () => { tracks.forEach(track => track.removeEventListener('load', apply)); media.textTracks.removeEventListener('addtrack', apply); media.removeEventListener('loadedmetadata', apply); };
  }, [media, prefs.subtitleDelay, offset, source]);
  useEffect(() => {
    if (!media) return;
    const id = crypto.randomUUID();
    media.setAttribute('data-subtitle-style', id);
    const style = media.ownerDocument.createElement('style');
    media.ownerDocument.head.appendChild(style);
    const update = () => {
      const size = Math.max(14, media.clientHeight * 0.05) * prefs.subtitleSize / 100;
      style.textContent = `[data-subtitle-style="${id}"]::cue { font-size: ${size}px; color: ${prefs.subtitleColor}; background-color: ${prefs.subtitleBackground === 'dark' ? 'rgba(0,0,0,0.75)' : 'transparent'}; }`;
    };
    const observer = new ResizeObserver(update); observer.observe(media); update();
    return () => { observer.disconnect(); style.remove(); media.removeAttribute('data-subtitle-style'); };
  }, [media, prefs.subtitleSize, prefs.subtitleColor, prefs.subtitleBackground]);
}
