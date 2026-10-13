import { stripPrefix } from './modules/minecraft/log-parser';
export interface TickReading { tps?: number; mspt?: number; tickSource: 'spark' | 'paper' }
/** Only explicit command reply formats. A player's chat cannot become a sample. */
export function parseTickReply(lines: string[], source: 'spark' | 'paper'): TickReading | null {
  let expect: 'tps' | 'mspt' | null = null;
  let msptIndex = source === 'spark' ? 1 : 0;
  const out: TickReading = { tickSource: source };
  for (const raw of lines.slice(-24)) {
    const parsed = stripPrefix(raw);
    if (parsed && parsed.level !== 'INFO') continue;
    const text = (parsed?.message ?? raw).replace(/§[0-9a-fk-or]/gi, '').replace(/^\[(?:spark|⚡)\]\s*/iu, '').trim();
    if (text.startsWith('<')) continue;
    if (/^TPS from last /i.test(text)) {
      if (/^TPS from last 5s,/i.test(text)) out.tickSource = 'spark';
      expect = 'tps';
      const inline = text.slice(text.indexOf(':') + 1).trim();
      if (text.includes(':') && /^\*?\d/.test(inline)) {
        const value = Number(inline.replace(/^\*/, '').split(',')[0]);
        if (value >= 0 && value <= 1000) out.tps = value;
        expect = null;
      }
      continue;
    }
    if (/^(?:Server )?(?:tick times|tick durations).*from last /i.test(text)) {
      if (/min\/med/i.test(text)) { msptIndex = 1; out.tickSource = 'spark'; }
      else if (/avg\/min/i.test(text)) { msptIndex = 0; out.tickSource = 'paper'; }
      expect = 'mspt'; continue;
    }
    if (expect === 'tps' && /^\*?\d+(?:\.\d+)?(?:,\s*\*?\d+(?:\.\d+)?)*$/.test(text)) {
      const value = Number(text.replace(/^\*/, '').split(',')[0]);
      if (value >= 0 && value <= 1000) out.tps = value;
      expect = null;
    } else if (expect === 'mspt' && /^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?){2,3}(?:,\s*\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?){2,3})*$/.test(text)) {
      const row = text.split(',')[0].split('/').map(Number);
      const value = row[msptIndex];
      if (value >= 0 && value <= 60000) out.mspt = value;
      expect = null;
    }
  }
  return out.tps !== undefined || out.mspt !== undefined ? out : null;
}
