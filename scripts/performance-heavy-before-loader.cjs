/* eslint-disable @typescript-eslint/no-require-imports -- Verified in-memory reconstruction; never rewrites the checkout. */
const path = require('node:path'), crypto = require('node:crypto');
module.exports = function (source) {
  const options = this.getOptions(); if (!options.before) return source;
  const file = path.relative(path.resolve(__dirname, '..'), this.resourcePath).split(path.sep).join('/');
  if (file === 'renderer/components/index.ts') {
    source = source.replace("export { StreamPlayerModal } from './LazyStreamPlayer';", "export { StreamPlayerModal } from './StreamPlayerModal';")
      .replace("export { Onboarding } from './Onboarding';", "export { ThemeEditor } from './ThemeEditor';\nexport { Onboarding } from './Onboarding';");
  } else if (file === 'renderer/pages/WatchHistoryPage.tsx') {
    source = source.replace("from '../components/LazyStreamPlayer';", "from '../components/StreamPlayerModal';");
  } else return source;
  // apply_patch may normalize Windows line endings in an edited file.
  const candidates = [source, source.replace(/\r?\n/g, '\n'), source.replace(/\r?\n/g, '\r\n')];
  const original = candidates.find(value => crypto.createHash('sha256').update(value).digest('hex') === options.hashes[file]);
  if (original === undefined) throw Error('Before source no longer matches the captured file: ' + file);
  return original;
};
