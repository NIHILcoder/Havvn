/**
 * One-off maintenance: wipe the pre-rebrand (TorrentHunt-era) GitHub releases.
 *
 *   node scripts/cleanup-old-releases.js          — dry run (prints the plan)
 *   node scripts/cleanup-old-releases.js --apply  — actually deletes
 *
 * Deletes every release EXCEPT the tags listed in KEEP. Git tags are NOT
 * touched by release deletion (version tags stay as quiet git history).
 * Auth: token is taken from the git credential helper (the same one `git push`
 * uses) and never printed.
 */
const { execSync } = require('child_process');
const https = require('https');

const OWNER = 'NIHILcoder';
const REPO = 'Havvn';
const KEEP = new Set(['v2.8.0', 'v2.9.0', 'v2.9.1']); // Havvn-era releases to keep
const APPLY = process.argv.includes('--apply');

function getToken() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('No GitHub credentials in the git credential helper.');
  return m[1].trim();
}

function api(method, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'havvn-maintenance',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const token = getToken();

  // Collect all releases (paginated).
  const releases = [];
  for (let page = 1; page < 10; page++) {
    const r = await api('GET', `/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`, token);
    if (r.status !== 200) throw new Error(`GET releases page ${page}: HTTP ${r.status}`);
    const batch = JSON.parse(r.body);
    releases.push(...batch);
    if (batch.length < 100) break;
  }

  // Never touch drafts (unpublished releases in preparation) regardless of tag.
  const doomed = releases.filter((rel) => !rel.draft && !KEEP.has(rel.tag_name));
  console.log(`releases total: ${releases.length}; keeping: ${releases.length - doomed.length}; deleting: ${doomed.length}`);
  for (const rel of doomed) console.log(`  - ${rel.tag_name}  ${JSON.stringify(rel.name)}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to delete.');
    return;
  }

  let ok = 0, fail = 0;
  for (const rel of doomed) {
    const r = await api('DELETE', `/repos/${OWNER}/${REPO}/releases/${rel.id}`, token);
    if (r.status === 204) { ok++; console.log(`deleted ${rel.tag_name}`); }
    else { fail++; console.log(`FAILED ${rel.tag_name}: HTTP ${r.status}`); }
  }
  console.log(`\ndone: ${ok} deleted, ${fail} failed.`);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
