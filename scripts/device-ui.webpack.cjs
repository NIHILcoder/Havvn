const config = require('./room-sync-ui.webpack.cjs');
const path = require('node:path');
config.entry = path.resolve(__dirname, 'fixtures/device-ui.tsx');
config.output = { path: path.resolve(__dirname, '../dist/device-ui'), filename: 'fixture.js' };
module.exports = config;
