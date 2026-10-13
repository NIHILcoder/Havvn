// Load the same local fonts as renderer/index.tsx in isolated UI fixtures.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

module.exports = root => [
  ...[300, 400, 500, 600, 700, 800].map(weight => `inter/${weight}`),
  ...[500, 600, 700].map(weight => `chakra-petch/${weight}`),
  ...[500, 600, 700].map(weight => `exo-2/${weight}`),
].map(name => {
  const file = path.join(root, 'node_modules/@fontsource', name + '.css');
  return fs.readFileSync(file, 'utf8').replace(/url\(([^)]+)\)/g, (_match, url) =>
    'url(' + pathToFileURL(path.resolve(path.dirname(file), url.replace(/["']/g, ''))).href + ')');
}).join('\n');
