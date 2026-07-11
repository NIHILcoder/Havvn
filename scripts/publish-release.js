/**
 * Creates a DRAFT GitHub release for the current package.json version and
 * uploads the electron-builder artifacts from release/. The draft stays
 * invisible until you press "Publish release" on GitHub — review it there.
 *
 *   node scripts/publish-release.js
 *
 * Notes are extracted from CHANGELOG.md (the section for this version).
 * Auth: token from the git credential helper (same as `git push`); never printed.
 */
const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = 'NIHILcoder';
const REPO = 'Havvn';
const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

const ASSETS = [
  `Havvn-Setup-${version}.exe`,
  `Havvn-Setup-${version}.exe.blockmap`,
  'latest.yml',
  `Havvn-${version}-win-portable.zip`,
];

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

function changelogSection() {
  const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const start = md.indexOf(`## [${version}]`);
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const afterHeader = md.indexOf('\n', start) + 1;
  const next = md.indexOf('\n## [', afterHeader);
  return md.slice(afterHeader, next === -1 ? undefined : next).trim();
}

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body) {
      if (body.pipe) body.pipe(r); else { r.write(body); r.end(); }
    } else r.end();
  });
}

(async () => {
  // Preflight: all artifacts must exist.
  for (const a of ASSETS) {
    const p = path.join(root, 'release', a);
    if (!fs.existsSync(p)) throw new Error(`Missing artifact: release/${a} — run the dist build first.`);
  }

  const token = getToken();
  const headers = {
    'User-Agent': 'havvn-release',
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
  };

  console.log(`Creating DRAFT release ${tag}…`);
  const create = await req(
    { hostname: 'api.github.com', path: `/repos/${OWNER}/${REPO}/releases`, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' } },
    JSON.stringify({
      tag_name: tag,
      name: `Havvn ${version}`,
      body: changelogSection(),
      draft: true,
      prerelease: false,
    }),
  );
  if (create.status !== 201) throw new Error(`Create release failed: HTTP ${create.status} ${create.body.slice(0, 300)}`);
  const release = JSON.parse(create.body);
  console.log(`Draft created (id ${release.id}).`);

  for (const name of ASSETS) {
    const file = path.join(root, 'release', name);
    const size = fs.statSync(file).size;
    console.log(`Uploading ${name} (${(size / 1048576).toFixed(1)} MB)…`);
    const up = await req(
      { hostname: 'uploads.github.com',
        path: `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': size } },
      fs.createReadStream(file),
    );
    if (up.status !== 201) throw new Error(`Upload ${name} failed: HTTP ${up.status} ${up.body.slice(0, 300)}`);
  }

  console.log(`\nDone. Review and publish: https://github.com/${OWNER}/${REPO}/releases`);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
