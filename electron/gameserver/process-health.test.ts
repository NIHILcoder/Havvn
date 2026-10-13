import { expect, it } from 'vitest';
import os from 'os';
import { parseLinuxProcess, ServerHealthHistory } from './process-health';
import { parseTickReply } from './tick-health';
import { parseServerHealth } from '../../shared/server-health';
it('calculates CPU deltas and resets them when the PID identity changes', () => {
  const history = new ServerHealthHistory();
  expect(history.sample(1000, 1, { identity: 'a', cpuMs: 100, rssBytes: 1024 }, 9000).cpuPercent).toBeUndefined();
  expect(history.sample(2000, 1, { identity: 'a', cpuMs: 1100, rssBytes: 2048 }, 8000).cpuPercent).toBeCloseTo(100 / os.cpus().length);
  expect(history.sample(3000, 1, { identity: 'b', cpuMs: 100, rssBytes: 3000 }, 7000).cpuPercent).toBeUndefined();
  for (let i = 0; i < 80; i++) history.sample(4000 + i * 5000, undefined, null, null);
  expect(history.history).toHaveLength(60);
  expect(history.history.at(-1)?.rssBytes).toBeUndefined();
});
it('reads Linux statistics even when the process name contains spaces and parentheses', () => {
  const fields = Array(30).fill('0'); fields[11] = '40'; fields[12] = '60'; fields[19] = '1234';
  const reading = parseLinuxProcess('123 (test ) process) ' + fields.join(' '), 'Name: test\nVmRSS:\t2000 kB\n', 100);
  expect(reading).toEqual({ identity: '1234', cpuMs: 1000, rssBytes: 2048000 });
  expect(parseLinuxProcess('broken', '', 100)).toBeNull();
});
it('parses bounded Paper and spark replies and rejects player chat and invalid mirror readings', () => {
  expect(parseTickReply(['[12:00:00 INFO]: TPS from last 1m, 5m, 15m: 19.5, 20.0, 20.0',
    '[12:00:00 INFO]: Server tick times (avg/min/max) from last 5s, 10s, 1m:', '[12:00:00 INFO]: 5.0/1.0/12.0, 6.0/1.0/16.0, 7.0/1.0/20.0'], 'paper')).toEqual({ tps: 19.5, mspt: 5, tickSource: 'paper' });
  expect(parseTickReply(['[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:', '[⚡] 20.0, 20.0, 20.0, 20.0, 20.0',
    '[⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:', '[⚡] 1.0/3.0/5.0/9.0, 1.0/4.0/8.0/12.0'], 'spark')).toEqual({ tps: 20, mspt: 3, tickSource: 'spark' });
  expect(parseTickReply(['[12:00:00 INFO]: <Alex> TPS from last 1m: 999'], 'paper')).toBeNull();
  expect(parseTickReply(['[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:', '[⚡] 20.0, 20.0, 20.0, 20.0, 20.0',
    '[⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:', '[⚡] 1.0/3.0/5.0/9.0, 1.0/4.0/8.0/12.0'], 'paper')).toEqual({ tps: 20, mspt: 3, tickSource: 'spark' });
  expect(parseServerHealth({ at: 1, cpuPercent: Infinity })).toBeUndefined();
  expect(parseServerHealth({ at: 1, cpuPercent: 101 })).toBeUndefined();
});
