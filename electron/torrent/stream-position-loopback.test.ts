import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { NativeMediaServer } from './native/media-server';
vi.mock('../utils', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('./host/env', () => ({ getHostEnv: () => ({ isPackaged: false }) }));
import { TorrentManager } from './manager';

it('both HTTP engines restart from the requested timestamp using real FFmpeg, including pipe input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-track-switch-'));
  const filePath = path.join(dir, 'two-audio.mkv');
  const classic = new TorrentManager();
  const classicState = classic as unknown as { ensureTranscodeServer(): Promise<number>; transcodeServer: import('node:http').Server; activeTranscodes: Set<import('node:child_process').ChildProcess> };
  let complete = true, availabilityCalls = 0;
  const native = new NativeMediaServer(() => ({ diskPath: filePath, length: fs.statSync(filePath).size, name: 'two-audio.mkv', kind: 'video' }),
    () => ffmpeg, async () => fs.statSync(filePath).size - (!complete && availabilityCalls++ === 0 ? 1 : 0), 'test-token');
  try {
    execFileSync(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', filePath], { windowsHide: true, timeout: 15000 });
    const length = fs.statSync(filePath).size;
    const file = { name: 'two-audio.mkv', length, progress: 1, select: vi.fn(), createReadStream: () => fs.createReadStream(filePath) };
    Object.assign(classic, { managedTorrents: new Map([['test', { torrent: { files: [file] } }]]), getCastFileInfo: () => ({ diskPath: filePath }) });
    const classicPort = await classicState.ensureTranscodeServer();
    const nativePort = await native.ensure();
    for (const engine of ['classic', 'native']) for (const full of [true, false]) {
      complete = full; availabilityCalls = 0; file.progress = full ? 1 : 0.5;
      const port = engine === 'classic' ? classicPort : nativePort;
      const response = await fetch(`http://127.0.0.1:${port}/transcode/test/0?k=test-token&a=1&s=3`, { signal: AbortSignal.timeout(10000) });
      expect(response.status).toBe(200);
      const output = path.join(dir, engine + '-' + full + '.mp4');
      fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
      const decoded = execFileSync(ffmpeg!, ['-hide_banner', '-i', output, '-f', 'null', '-'], { windowsHide: true, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(decoded).toBe(''); // decoding succeeded; also inspect duration separately
      const probe = (() => { try { execFileSync(ffmpeg!, ['-hide_banner', '-i', output], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { return (error as { stderr: string }).stderr; } return ''; })();
      const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe);
      expect(match, engine + ' duration').not.toBeNull();
      const seconds = Number(match![1]) * 3600 + Number(match![2]) * 60 + Number(match![3]);
      expect(seconds).toBeGreaterThan(4.7);
      expect(seconds).toBeLessThan(5.3);
    }
  } finally {
    native.close();
    for (const proc of classicState.activeTranscodes) proc.kill();
    if (classicState.transcodeServer) await new Promise<void>(resolve => classicState.transcodeServer.close(() => resolve()));
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir)).toMatch(/^havvn-track-switch-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
