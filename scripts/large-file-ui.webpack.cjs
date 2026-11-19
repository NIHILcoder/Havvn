const path = require('node:path');
const base = require('./room-sync-ui.webpack.cjs');
module.exports = { ...base,
  entry: path.resolve(__dirname, 'fixtures/large-file-ui.tsx'),
  output: { path: path.resolve(__dirname, '../dist/large-file-ui'), filename: 'fixture.js' },
};
