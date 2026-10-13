/* eslint-disable @typescript-eslint/no-require-imports -- Webpack uses a CommonJS loader. */
// Instrument component invocations without changing product source.
module.exports = function (source) {
  const options = this.getOptions();
  if (options.baseline) {
    const file = require('node:path').join(options.baseline, require('node:path').basename(this.resourcePath));
    if (require('node:fs').existsSync(file)) source = require('node:fs').readFileSync(file, 'utf8');
  }
  const names = {
    'App.tsx': ['AppContent'], 'DownloadsPage.tsx': ['DownloadsPage'],
    'DownloadItem.tsx': ['DownloadItem'], 'RoomsPage.tsx': ['RoomsPage'],
  }[require('node:path').basename(this.resourcePath)] || [];
  for (const name of names) {
    const pattern = new RegExp('(const ' + name + '[^=\\n]*=\\s*\\([\\s\\S]*?\\)\\s*=>\\s*\\{)');
    source = source.replace(pattern, '$1 window.__perf.renders.' + name + ' = (window.__perf.renders.' + name + ' || 0) + 1;');
  }
  return source;
};
