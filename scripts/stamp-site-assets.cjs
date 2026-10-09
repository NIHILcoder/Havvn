// Give changed static assets a new URL so browser caches cannot retain old code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function stampSiteAssets({check = false} = {}) {
  const root = path.resolve(__dirname, '..', 'docs');
  const file = path.join(root, 'index.html');
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  for (const asset of ['assets/site.css', 'assets/site.js']) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, asset), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
    const escaped = asset.replaceAll('.', '\\.');
    const expression = new RegExp(escaped + '(?:\\?[^"\']*)?(?=["\'])', 'g');
    if (!expression.test(updated)) throw new Error('Missing site asset reference: ' + asset);
    expression.lastIndex = 0;
    updated = updated.replace(expression, asset + '?hash=' + hash);
  }
  if (updated === original) return false;
  if (check) throw new Error('Site asset hashes are stale. Run node scripts/stamp-site-assets.cjs');
  fs.writeFileSync(file, updated);
  return true;
}

module.exports = stampSiteAssets;
if (require.main === module) {
  try {
    const changed = stampSiteAssets({check: process.argv.includes('--check')});
    console.log(changed ? 'Updated website asset hashes.' : 'Website asset hashes are current.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
