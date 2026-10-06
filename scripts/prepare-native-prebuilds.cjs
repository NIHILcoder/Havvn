const fs = require('node:fs');
const path = require('node:path');

// @electron/rebuild 4.2 only recognizes node.napi.node, while prebuildify 6
// emits package-name.node. These packages explicitly build against Node-API.
module.exports = async function prepareNativePrebuilds(context) {
  const platform = typeof context.platform === 'string' ? context.platform : context.platform.nodeName;
  if (!['win32', 'linux'].includes(platform) || context.arch !== 'x64') return true;
  for (const name of ['bufferutil', 'utf-8-validate', 'uiohook-napi']) {
    const root = path.join(context.appDir, 'node_modules', name);
    if (!fs.existsSync(path.join(root, 'package.json'))) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!/prebuildify.*--napi/.test(pkg.scripts?.prebuild || '')) throw new Error(name + ': expected a Node-API prebuild');
    const dir = path.join(root, 'prebuilds', `${platform}-${context.arch}`);
    const source = path.join(dir, name + '.node');
    if (!fs.existsSync(source)) continue; // Missing prebuilds still use normal rebuild.
    const target = path.join(dir, 'node.napi.node');
    const bytes = fs.readFileSync(source);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) fs.copyFileSync(source, target);
    console.log('Prepared Node-API prebuild: ' + name);
  }
  return true; // Keep electron-builder's normal dependency validation/rebuild.
};
