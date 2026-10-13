/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS build script. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'dist/electron/electron/sharing/room-engine.html');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(path.join(root, 'electron/sharing/room-engine.html'), target);
require('./build-preload.cjs')().catch(error => { console.error(error); process.exitCode = 1; });
