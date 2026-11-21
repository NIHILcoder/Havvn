const path = require('node:path');
const base = require('./room-sync-ui.webpack.cjs');
module.exports = { ...base, entry: path.resolve(__dirname, 'fixtures/ux-final-ui.tsx'), output: { path: path.resolve(__dirname, '../dist/ux-final-ui'), filename: 'fixture.js' } };
