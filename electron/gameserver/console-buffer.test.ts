import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ streams: [] as Array<EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>, warn: vi.fn() }));
vi.mock('fs', () => ({ default: {
  existsSync: () => false,
  statSync: () => ({ size: 0 }),
  createWriteStream: () => {
    const stream = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
    fixture.streams.push(stream); return stream;
  },
} }));
vi.mock('./paths', () => ({ ensureDir: vi.fn() }));
vi.mock('../utils', () => ({ logger: { child: () => ({ warn: fixture.warn }) } }));
import { ConsoleBuffer } from './console-buffer';

beforeEach(() => { fixture.streams.length = 0; fixture.warn.mockClear(); });

it('keeps the new run logging when a retired stream reports a delayed error', () => {
  const buffer = new ConsoleBuffer('fixture-logs');
  buffer.openLog(); const old = fixture.streams[0];
  buffer.system('first run'); buffer.openLog();
  expect(old.destroy).toHaveBeenCalledOnce();
  old.emit('error', new Error('Cannot call write after a stream was destroyed'));
  buffer.system('second run');
  expect(fixture.streams[1].write).toHaveBeenCalledWith(expect.stringContaining('second run'));
  expect(fixture.warn).not.toHaveBeenCalled();
});

it('reports active log failure once and keeps the UI console working', () => {
  const buffer = new ConsoleBuffer('fixture-logs'); const subscriber = vi.fn();
  buffer.subscribe(subscriber); buffer.openLog();
  fixture.streams[0].emit('error', new Error('Disk full'));
  buffer.system('still visible');
  expect(fixture.warn).toHaveBeenCalledOnce();
  expect(fixture.streams[0].write).not.toHaveBeenCalled();
  expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ text: 'still visible' }));
  expect(buffer.snapshot()).toEqual([expect.objectContaining({ text: 'still visible' })]);
});

it('ignores intentional close errors without reopening the log', () => {
  const buffer = new ConsoleBuffer('fixture-logs'); buffer.openLog(); buffer.closeLog();
  fixture.streams[0].emit('error', new Error('Closed')); buffer.system('stopped');
  expect(fixture.streams).toHaveLength(1); expect(fixture.warn).not.toHaveBeenCalled();
  expect(fixture.streams[0].write).not.toHaveBeenCalled();
});
