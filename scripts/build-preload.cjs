/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS build script. */
// Sandbox preloads can require Electron, but cannot load sibling CommonJS files.
// Bundle shared IPC helpers into the emitted preload after TypeScript compilation.
const path = require('node:path');
const webpack = require('webpack');

module.exports = () => new Promise((resolve, reject) => {
  const directory = path.resolve(__dirname, '../dist/electron/electron');
  const compiler = webpack({
    mode: 'production', target: 'electron-preload',
    entry: path.join(directory, 'preload.js'),
    output: { path: directory, filename: 'preload.js' },
    optimization: { minimize: false }, devtool: false,
  });
  compiler.run((error, stats) => {
    const failure = error || (stats?.hasErrors() ? new Error(stats.toString({ all: false, errors: true })) : undefined);
    compiler.close(closeError => failure || closeError ? reject(failure || closeError) : resolve());
  });
});
