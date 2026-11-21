import { describe, expect, it } from 'vitest';
import { applyPickerAction, filesInPickerScope, pickerFolders } from './torrent-file-picker';

const files = [
  { index: 7, path: 'Archive/Season 1/first.MP4' }, { index: 21, path: 'Archive/Season 1/second.mkv' },
  { index: 55, path: 'Archive/Season 1/second.ASS' }, { index: 109, path: 'Archive/Season 1/info.txt' },
  { index: 300, path: 'Archive/Season 10/movie.avi' }, { index: 400, path: 'Archive/Season 10/sample.mkv' },
  { index: 500, path: 'Archive/Samples/trailer.mp4' }, { index: 700, path: 'Archive/Season 10/Sampled-course.webm' },
];
describe('torrent quick selection', () => {
  it('replaces videos across supported containers and preserves metadata IDs', () => {
    expect([...applyPickerAction(new Set(files.map(file => file.index)), files, 'video-only')].sort()).toEqual([7, 21, 300, 400, 500, 700].sort());
  });
  it('includes external subtitles and replaces non-media inside the selected scope only', () => {
    const scope = files.slice(0, 4), selected = new Set([109, 300]);
    expect([...applyPickerAction(selected, scope, 'video-subtitles')].sort()).toEqual([7, 21, 55, 300].sort());
    expect([...selected]).toEqual([109, 300]);
  });
  it('adds a format without deselecting text or other choices', () => {
    expect([...applyPickerAction(new Set([109]), files, 'add-mp4')]).toEqual([109, 7, 500]);
    expect([...applyPickerAction(new Set([109]), files, 'add-mkv')]).toEqual([109, 21, 400]);
  });
  it('excludes sample files and folders without treating Sampled as a sample', () => {
    const selected = new Set(files.map(file => file.index));
    const next = applyPickerAction(selected, files, 'exclude-sample');
    expect(next.has(400)).toBe(false); expect(next.has(500)).toBe(false); expect(next.has(700)).toBe(true);
    expect(next.has(7)).toBe(true);
  });
  it('honors folder boundaries and case-sensitive folder identity while search ignores case', () => {
    expect(filesInPickerScope(files, 'SECOND', 'Archive/Season 1').map(file => file.index)).toEqual([21, 55]);
    expect(filesInPickerScope(files, '', 'archive/season 1')).toEqual([]);
    expect(filesInPickerScope([{ index: 3, path: 'A\\B\\clip.mp4' }], '', 'A/B')).toHaveLength(1);
    expect(filesInPickerScope([{ index: 3, path: 'A/B/clip.mp4' }], 'A\\B', 'A\\B\\')).toHaveLength(1);
  });
  it('only an explicit scope-only action deselects files outside the scope', () => {
    expect([...applyPickerAction(new Set([7, 300]), files.slice(1, 3), 'scope-only')]).toEqual([21, 55]);
    expect([...applyPickerAction(new Set([7, 300]), [], 'video-only')]).toEqual([7, 300]);
  });
  it('indexes parent and child folders for a large directory tree once', () => {
    const large = Array.from({ length: 10_000 }, (_, index) => ({ index: index * 2 + 3, path: `Archive/group-${index}/movie.mkv` }));
    const folders = pickerFolders(large);
    expect(folders).toHaveLength(10_001); expect(folders.find(folder => folder.path === 'Archive')?.count).toBe(10_000);
    expect(folders.find(folder => folder.path === 'Archive/group-9999')?.count).toBe(1);
    expect(filesInPickerScope(large, '', 'Archive/group-9999')[0].index).toBe(20_001);
  });
});
