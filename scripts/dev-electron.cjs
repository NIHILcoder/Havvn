const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function probe(url, signal, timeout) {
  return new Promise(resolve => {
    const request = http.get(url, { signal }, response => {
      const ok = response.statusCode === 200;
      response.resume();
      response.on('end', () => resolve(ok));
      response.on('error', () => resolve(false));
    });
    request.setTimeout(timeout, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForRenderer(url, { timeout = 120000, interval = 500, signal } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await probe(url, signal, Math.min(2000, Math.max(1, deadline - Date.now())))) return;
    signal?.throwIfAborted();
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Renderer did not become ready at ${url} within ${timeout / 1000}s. Check the webpack output.`);
}

async function main() {
  const controller = new AbortController();
  let child;
  const stop = () => { controller.abort(); if (child && !child.killed) child.kill(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    console.log('[dev] Waiting for the renderer build at http://127.0.0.1:3000 ...');
    await waitForRenderer('http://127.0.0.1:3000/', { signal: controller.signal });
    controller.signal.throwIfAborted();
    console.log('[dev] Renderer ready. Starting Electron.');
    child = spawn(require('electron'), ['.'], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: 'development' },
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => { process.exitCode = code ?? 1; resolve(); });
    });
  } catch (error) {
    if (!controller.signal.aborted) console.error('[dev]', error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

module.exports = { waitForRenderer };
if (require.main === module) void main();
