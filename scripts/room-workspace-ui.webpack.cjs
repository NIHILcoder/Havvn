const path = require('node:path');
const base = require('./room-sync-ui.webpack.cjs');
module.exports = { ...base, entry: path.resolve(__dirname, 'fixtures/room-workspace-ui.tsx'), output: { path: path.resolve(__dirname, '../dist/room-workspace-ui'), filename: 'fixture.js' } };
