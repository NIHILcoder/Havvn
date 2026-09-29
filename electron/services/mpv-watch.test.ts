import { afterEach, expect, it, vi } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { MpvWatch, type MpvPosition } from './mpv-watch';
const watches: MpvWatch[] = [], servers: net.Server[] = [], sockets: net.Socket[] = [];
afterEach(async () => {
  watches.splice(0).forEach(w => w.close()); sockets.splice(0).forEach(s => s.destroy());
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
});
function fixture(source = path.resolve('Фильм & 01.mp4')) {
  const samples: MpvPosition[] = [], requests: string[][] = [];
  const watch = new MpvWatch(source, s => samples.push(s)); watches.push(watch);
  const props: Record<string, unknown> = { path: source, 'time-pos': 42.5, duration: 1000 };
  let replyHook: ((property: string, socket: net.Socket) => void) | null = null;
  const server = net.createServer(socket => {
    sockets.push(socket); socket.on('error', () => {}); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); requests.push(message.command);
        const property = message.command[1]; replyHook?.(property, socket);
        // Events and fragmented responses may interleave; request IDs, not order, identify answers.
        const reply = JSON.stringify({ request_id: message.request_id, error: 'success', data: props[property] }) + '\n';
        socket.write('{"event":"tick"}\n' + reply.slice(0, 8)); socket.write(reply.slice(8));
      }
    });
  }); servers.push(server);
  return { source, watch, server, props, samples, requests, hook: (fn: typeof replyHook) => { replyHook = fn; },
    listen: () => new Promise<void>(resolve => server.listen(watch.endpoint, resolve)) };
}
it('retries a late pipe, reads only fixed properties, saves seeks backward and unknown durations', async () => {
  const f = fixture(); f.watch.start(); await new Promise(r => setTimeout(r, 300)); await f.listen();
  await vi.waitFor(() => expect(f.samples.at(-1)).toEqual({ position: 42.5, duration: 1000 }), { timeout: 3000 });
  f.props['time-pos'] = 7; f.props.duration = null;
  await vi.waitFor(() => expect(f.samples.at(-1)).toEqual({ position: 7, duration: null }), { timeout: 3000 });
  expect(f.requests.every(c => c[0] === 'get_property' && ['path', 'time-pos', 'duration'].includes(c[1]))).toBe(true);
  f.watch.close(); expect(f.samples.at(-1)?.position).toBe(7);
});
it('does not attribute another file or a racing start-file event to the original history', async () => {
  const f = fixture(); await f.listen(); f.watch.start();
  await vi.waitFor(() => expect(f.samples.length).toBeGreaterThan(0));
  f.props.path = path.resolve('other.mp4'); f.props['time-pos'] = 900;
  const count = f.samples.length;
  await new Promise(r => setTimeout(r, 1150)); expect(f.samples.length).toBe(count);
  f.props.path = f.source;
  f.hook((property, socket) => { if (property === 'time-pos') socket.write('{"event":"start-file"}\n'); });
  await new Promise(r => setTimeout(r, 1150)); expect(f.samples.length).toBe(count);
  f.watch.close(); expect(f.samples.length).toBe(count);
});
it('requires the exact scoped stream URL and ignores invalid clocks and oversized IPC lines', async () => {
  const f = fixture('http://127.0.0.1:12345/media?k=secret'); await f.listen(); f.watch.start();
  await vi.waitFor(() => expect(f.samples.length).toBeGreaterThan(0));
  f.props.path = 'http://127.0.0.1:12345/media?k=other'; f.props['time-pos'] = 999;
  const count = f.samples.length; await new Promise(r => setTimeout(r, 1100)); expect(f.samples.length).toBe(count);
  f.props.path = f.source; f.props['time-pos'] = -1;
  await new Promise(r => setTimeout(r, 1100)); expect(f.samples.length).toBe(count);
  const socket = sockets.at(-1)!; socket.write('x'.repeat(70000));
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
});
it('preserves the last valid sample on a truncated eof and stops all requests on close', async () => {
  const f = fixture(); await f.listen(); f.watch.start();
  await vi.waitFor(() => expect(f.samples.length).toBeGreaterThan(0));
  sockets.at(-1)!.write('{"event":"end-file","reason":"eof"}\n');
  await vi.waitFor(() => expect(f.samples.length).toBeGreaterThan(1));
  expect(f.samples.at(-1)).toEqual({ position: 42.5, duration: 1000 });
  f.watch.close(); const count = f.requests.length;
  await new Promise(r => setTimeout(r, 1100)); expect(f.requests.length).toBe(count);
});
