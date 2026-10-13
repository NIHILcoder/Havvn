import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import type { ServerHealthSample } from '../../shared/server-health';

export interface ProcessReading { identity: string; cpuMs: number; rssBytes: number }
let windowsReader: ((pid: number) => ProcessReading | null) | undefined;
let clockTicks: Promise<number | null> | undefined;

function readWindows(pid: number): ProcessReading | null {
  if (!windowsReader) {
    windowsReader = () => null;
    // Lazy native loading keeps unsupported platforms and unit tests independent.
    // Query-only handles; every successful OpenProcess is paired with CloseHandle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi: typeof import('koffi') = require('koffi');
    const kernel = koffi.load('kernel32.dll');
    koffi.struct('HAVVN_HEALTH_FILETIME', { low: 'uint32', high: 'uint32' });
    const counters = koffi.struct('HAVVN_HEALTH_MEMORY', {
      cb: 'uint32', faults: 'uint32', peakWorkingSet: 'size_t', workingSet: 'size_t', peakPaged: 'size_t',
      paged: 'size_t', peakNonPaged: 'size_t', nonPaged: 'size_t', pagefile: 'size_t', peakPagefile: 'size_t',
    });
    const open = kernel.func('void* __stdcall OpenProcess(uint32, int, uint32)');
    const close = kernel.func('int __stdcall CloseHandle(void*)');
    const times = kernel.func('int __stdcall GetProcessTimes(void*, _Out_ HAVVN_HEALTH_FILETIME*, _Out_ HAVVN_HEALTH_FILETIME*, _Out_ HAVVN_HEALTH_FILETIME*, _Out_ HAVVN_HEALTH_FILETIME*)');
    const memory = kernel.func('int __stdcall K32GetProcessMemoryInfo(void*, _Inout_ HAVVN_HEALTH_MEMORY*, uint32)');
    const milliseconds = (p: { low: number; high: number }) => (p.high * 4294967296 + p.low) / 10000;
    windowsReader = target => {
      const handle = open(0x1000, 0, target);
      if (!handle) return null;
      try {
        const created = { low: 0, high: 0 }, exited = { low: 0, high: 0 }, system = { low: 0, high: 0 }, user = { low: 0, high: 0 };
        const size = koffi.sizeof(counters), mem = { cb: size, workingSet: 0 };
        if (!times(handle, created, exited, system, user) || !memory(handle, mem, size)) return null;
        return { identity: created.high + ':' + created.low, cpuMs: milliseconds(system) + milliseconds(user), rssBytes: Number(mem.workingSet) };
      } finally { close(handle); }
    };
  }
  return windowsReader(pid);
}
export function parseLinuxProcess(stat: string, status: string, ticks: number): ProcessReading | null {
  const end = stat.lastIndexOf(') ');
  if (end < 0 || !Number.isFinite(ticks) || ticks <= 0) return null;
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const user = Number(fields[11]), system = Number(fields[12]), started = fields[19];
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!started || !rss || !Number.isFinite(user + system)) return null;
  return { identity: started, cpuMs: (user + system) * 1000 / ticks, rssBytes: Number(rss[1]) * 1024 };
}
export async function readProcessHealth(pid: number): Promise<ProcessReading | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') return readWindows(pid);
    if (process.platform !== 'linux') return null;
    clockTicks ??= new Promise(resolve => execFile('getconf', ['CLK_TCK'], { timeout: 1500, windowsHide: true, maxBuffer: 1024 }, (error, out) => {
      const ticks = Number(out.trim()); resolve(!error && ticks > 0 ? ticks : null);
    }));
    const ticks = await clockTicks;
    if (!ticks) return null;
    const [stat, status] = await Promise.all([fs.readFile('/proc/' + pid + '/stat', 'utf8'), fs.readFile('/proc/' + pid + '/status', 'utf8')]);
    return parseLinuxProcess(stat, status, ticks);
  } catch { return null; }
}
export class ServerHealthHistory {
  readonly history: ServerHealthSample[] = [];
  private previous: { reading: ProcessReading; at: number; pid: number } | null = null;
  sample(at: number, pid: number | undefined, reading: ProcessReading | null, freeDiskBytes: number | null): ServerHealthSample {
    const previous = this.previous;
    const sample: ServerHealthSample = { at, ...(freeDiskBytes !== null ? { freeDiskBytes } : {}) };
    if (reading && pid) {
      sample.rssBytes = reading.rssBytes;
      if (previous && previous.pid === pid && previous.reading.identity === reading.identity && at > previous.at && reading.cpuMs >= previous.reading.cpuMs) {
        sample.cpuPercent = Math.min(100, Math.max(0, (reading.cpuMs - previous.reading.cpuMs) / (at - previous.at) / Math.max(1, os.cpus().length) * 100));
      }
      this.previous = { reading, at, pid };
    } else this.previous = null;
    this.history.push(sample);
    if (this.history.length > 60) this.history.shift();
    return sample;
  }
}
