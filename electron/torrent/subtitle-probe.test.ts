import { expect, it } from 'vitest';
import { parseSubtitleStreams } from './subtitle-probe';
it('counts image streams and parses tagged text streams without shifting their ordinals', () => {
  expect(parseSubtitleStreams(`
    Stream #0:2[0x3](eng): Subtitle: hdmv_pgs_subtitle
    Stream #0:3[0x4](pt-BR): Subtitle: subrip (default)
      Metadata:
        title : Portuguese SDH
    Stream #0:4(rus): Subtitle: ass
      Metadata:
        title : Russian
  `)).toEqual([
    { sIndex: 1, lang: 'pt-BR', codec: 'subrip', title: 'Portuguese SDH' },
    { sIndex: 2, lang: 'rus', codec: 'ass', title: 'Russian' },
  ]);
});
