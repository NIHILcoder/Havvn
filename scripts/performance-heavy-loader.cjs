/* eslint-disable @typescript-eslint/no-require-imports -- Profiling-only webpack loader. */
const path = require('node:path');
const watched = new Set(['RoomsPage.tsx', 'RoomDocumentsEditor.tsx', 'StreamPlayerModal.tsx', 'ThemeEditor.tsx', 'GallerySamples.tsx']);
module.exports = function (source) {
  const name = path.basename(this.resourcePath);
  if (name === 'ThemeEditorContext.tsx') {
    const marker = "const closeEditor = useCallback(() => setOpen(false), []);";
    if (!source.includes(marker)) throw Error('Theme context instrumentation no longer matches');
    source = source.replace(marker, marker + '\n  (window as any).__heavyOpenTheme = openEditor;');
  }
  return watched.has(name) ? `((window as any).__heavyModules ??= []).push({name:${JSON.stringify(name)},at:performance.now()});\n` + source : source;
};
