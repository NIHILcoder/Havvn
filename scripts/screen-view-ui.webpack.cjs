const path = require('node:path');
const base = require('./room-sync-ui.webpack.cjs');
module.exports = { ...base, entry: path.resolve(__dirname, 'fixtures/screen-view-ui.tsx'),
  output: { path: path.resolve(__dirname, '../dist/screen-view-ui'), filename: 'fixture.js' } };
