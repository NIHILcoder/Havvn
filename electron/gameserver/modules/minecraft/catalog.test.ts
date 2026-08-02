/**
 * Catalog parsing, against the shapes the upstreams actually return.
 *
 * This file exists because its absence cost us: Paper retired its v2 API, the
 * catalog started logging "http 410" into a place nobody reads, and the Paper
 * flavour silently vanished from the version list while every test stayed green.
 * Nothing here reaches the network — CatalogCtx is injected — so what is pinned
 * is the PARSING, which is the part that breaks when a vendor reshapes a payload.
 *
 * The fixtures are trimmed copies of real responses, not invented ones. Where a
 * detail looks gratuitous (Paper's `-rc-2`, NeoForge's `-beta`, Forge's
 * latest-without-recommended branch) it is there because upstream really does
 * that and an earlier version of this code got it wrong.
 */
import { describe, it, expect } from 'vitest';
import { minecraftCatalog, resolveMinecraftRef } from './catalog';
import { isReleaseVersion } from './versions';
import type { CatalogCtx, GameVersionRef } from '../../../../shared/gameserver-types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** fill.papermc.io/v3/projects/paper — versions grouped by family, and note that
 *  releases and candidates sit side by side in the same array. */
const PAPER_PROJECT = {
  project: { id: 'paper', name: 'Paper' },
  versions: {
    '26.2': ['26.2', '26.2-rc-2'],
    '26.1': ['26.1.2', '26.1.1'],
    '1.21': ['1.21.11', '1.21.11-rc3', '1.21.11-pre5', '1.21.10', '1.21.9'],
    '1.20': ['1.20.6', '1.20.4'],
  },
};

/** .../versions/26.1.2/builds — newest first, mixed channels. */
const PAPER_BUILDS = [
  {
    id: 76,
    channel: 'ALPHA',
    downloads: {
      'server:default': {
        name: 'paper-26.1.2-76.jar',
        checksums: { sha256: 'a'.repeat(64) },
        url: 'https://fill-data.papermc.io/v1/objects/aaa/paper-26.1.2-76.jar',
      },
    },
  },
  {
    id: 74,
    channel: 'STABLE',
    downloads: {
      'server:default': {
        name: 'paper-26.1.2-74.jar',
        checksums: { sha256: '1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7' },
        url: 'https://fill-data.papermc.io/v1/objects/1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7/paper-26.1.2-74.jar',
      },
    },
  },
  {
    id: 70,
    channel: 'STABLE',
    downloads: {
      'server:default': {
        name: 'paper-26.1.2-70.jar',
        checksums: { sha256: 'c'.repeat(64) },
        url: 'https://fill-data.papermc.io/v1/objects/ccc/paper-26.1.2-70.jar',
      },
    },
  },
];

const MOJANG_MANIFEST = {
  latest: { release: '26.2', snapshot: '26.2' },
  versions: [
    { id: '26.2', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/aaa/26.2.json' },
    { id: '26.2-rc1', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/bbb/rc.json' },
    { id: '26.1.2', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ccc/26.1.2.json' },
    { id: '1.21.11', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ddd/1.21.11.json' },
  ],
};

const MOJANG_VERSION_DOC = {
  downloads: {
    server: {
      url: 'https://piston-data.mojang.com/v1/objects/eee/server.jar',
      sha1: 'e'.repeat(40),
    },
  },
  javaVersion: { majorVersion: 25 },
};

/** promotions_slim.json. 26.2 has only a 'latest' — a real and common state for a
 *  fresh Minecraft branch, and one that must still be offered. */
const FORGE_PROMOS = {
  promos: {
    '26.2-latest': '60.0.3',
    '26.1.2-latest': '59.1.4',
    '26.1.2-recommended': '59.1.2',
    '1.21.11-latest': '58.0.9',
    '1.21.11-recommended': '58.0.7',
  },
};

/** NeoForge's maven API: ascending, betas mixed in, several builds per MC. */
const NEOFORGE_VERSIONS = {
  isSnapshot: false,
  versions: [
    '21.1.209',
    '26.1.2.90',
    '26.1.2.93',
    '26.2.0.41',
    '26.2.0.45-beta',
  ],
};

const FABRIC_LOADERS = [
  { version: '0.18.4', stable: true },
  { version: '0.18.5-rc.1', stable: false },
];

const FABRIC_INSTALLERS = [
  {
    version: '1.1.2',
    stable: true,
    url: 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// A CatalogCtx backed by the fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  json?: Record<string, unknown>;
  text?: Record<string, string>;
  /** URLs that should reject, to exercise the degrade-don't-fail path. */
  fail?: string[];
}

function makeCtx(rec: Recorded = {}): CatalogCtx & { logs: string[]; asked: string[] } {
  const logs: string[] = [];
  const asked: string[] = [];

  const json: Record<string, unknown> = {
    'https://fill.papermc.io/v3/projects/paper': PAPER_PROJECT,
    'https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds': PAPER_BUILDS,
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': MOJANG_MANIFEST,
    'https://piston-meta.mojang.com/v1/packages/aaa/26.2.json': MOJANG_VERSION_DOC,
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': FORGE_PROMOS,
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge': NEOFORGE_VERSIONS,
    'https://meta.fabricmc.net/v2/versions/loader': FABRIC_LOADERS,
    'https://meta.fabricmc.net/v2/versions/installer': FABRIC_INSTALLERS,
    ...(rec.json ?? {}),
  };

  const fail = new Set(rec.fail ?? []);

  return {
    logs,
    asked,
    async fetchJson(url) {
      asked.push(url);
      if (fail.has(url)) throw new Error(`http 410 for ${url}`);
      if (!(url in json)) throw new Error(`unexpected fetchJson: ${url}`);
      return json[url];
    },
    async fetchText(url) {
      asked.push(url);
      if (fail.has(url)) throw new Error(`http 404 for ${url}`);
      const text = rec.text?.[url];
      // Any maven sidecar not explicitly overridden answers a well-formed digest,
      // so a test about Forge does not have to enumerate every checksum URL.
      if (text !== undefined) return text;
      if (url.endsWith('.sha512')) return `${'f'.repeat(128)}\n`;
      if (url.endsWith('.sha256')) return `${'b'.repeat(64)}\n`;
      throw new Error(`unexpected fetchText: ${url}`);
    },
    log(msg) {
      logs.push(msg);
    },
  };
}

function only(refs: GameVersionRef[], flavour: string): GameVersionRef[] {
  return refs.filter((r) => r.flavour === flavour);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper — the flavour that broke
// ─────────────────────────────────────────────────────────────────────────────

describe('Paper catalog (Fill v3)', () => {
  it('flattens the family-grouped versions map', async () => {
    const paper = only(await minecraftCatalog(makeCtx()), 'paper');
    expect(paper.map((r) => r.version)).toEqual(['26.2', '26.1.2', '26.1.1', '1.21.11', '1.21.10', '1.21.9', '1.20.6', '1.20.4']);
  });

  it('drops release candidates and pre-releases', async () => {
    const paper = only(await minecraftCatalog(makeCtx()), 'paper');
    expect(paper.some((r) => r.version.includes('-'))).toBe(false);
  });

  it('sorts calendar versions above semver ones', async () => {
    const paper = only(await minecraftCatalog(makeCtx()), 'paper');
    expect(paper[0].version).toBe('26.2');
  });

  it('resolves to the newest STABLE build, not the newest build', async () => {
    const ref = only(await minecraftCatalog(makeCtx()), 'paper').find((r) => r.version === '26.1.2');
    const resolved = await resolveMinecraftRef(ref as GameVersionRef, makeCtx());
    expect(resolved.meta?.build).toBe(74);
    expect(resolved.label).toBe('Paper 26.1.2 (build 74)');
  });

  it('takes the download url and digest the build document carries', async () => {
    const ref = only(await minecraftCatalog(makeCtx()), 'paper').find((r) => r.version === '26.1.2');
    const resolved = await resolveMinecraftRef(ref as GameVersionRef, makeCtx());
    expect(resolved.meta?.jarUrl).toBe(
      'https://fill-data.papermc.io/v1/objects/1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7/paper-26.1.2-74.jar',
    );
    expect(resolved.meta?.jarSha256).toBe('1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7');
    expect(resolved.meta?.launchJar).toBe('server.jar');
  });

  it('picks the same build whatever order the builds arrive in', async () => {
    const url = 'https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds';
    const ascending = makeCtx({ json: { [url]: [...PAPER_BUILDS].reverse() } });
    const ref = only(await minecraftCatalog(makeCtx()), 'paper').find((r) => r.version === '26.1.2');
    const resolved = await resolveMinecraftRef(ref as GameVersionRef, ascending);
    expect(resolved.meta?.build).toBe(74);
  });

  it('refuses a version that has only experimental builds', async () => {
    const url = 'https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds';
    const alphaOnly = makeCtx({ json: { [url]: [PAPER_BUILDS[0]] } });
    const ref = only(await minecraftCatalog(makeCtx()), 'paper').find((r) => r.version === '26.1.2');
    await expect(resolveMinecraftRef(ref as GameVersionRef, alphaOnly)).rejects.toThrow(/no stable build/i);
  });

  it('refuses a build whose checksum is not a sha256', async () => {
    const url = 'https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds';
    const truncated = makeCtx({
      json: {
        [url]: [{
          id: 74,
          channel: 'STABLE',
          downloads: { 'server:default': { name: 'p.jar', url: 'https://x/p.jar', checksums: { sha256: 'abc' } } },
        }],
      },
    });
    const ref = only(await minecraftCatalog(makeCtx()), 'paper').find((r) => r.version === '26.1.2');
    await expect(resolveMinecraftRef(ref as GameVersionRef, truncated)).rejects.toThrow(/unusable checksum/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The other flavours
// ─────────────────────────────────────────────────────────────────────────────

describe('vanilla catalog', () => {
  it('lists releases only', async () => {
    const vanilla = only(await minecraftCatalog(makeCtx()), 'vanilla');
    expect(vanilla.map((r) => r.version)).toEqual(['26.2', '26.1.2', '1.21.11']);
  });

  it("prefers Mojang's stated Java requirement over our guess", async () => {
    const ref = only(await minecraftCatalog(makeCtx()), 'vanilla')[0];
    const resolved = await resolveMinecraftRef(ref, makeCtx());
    expect(resolved.runtime.major).toBe(25);
    expect(resolved.meta?.jarSha1).toBe('e'.repeat(40));
  });
});

describe('Forge catalog', () => {
  it('keeps a branch that has only a latest promotion, marked unstable', async () => {
    const forge = only(await minecraftCatalog(makeCtx()), 'forge');
    const newest = forge.find((r) => r.version === '26.2');
    expect(newest?.meta?.loaderVersion).toBe('60.0.3');
    expect(newest?.stable).toBe(false);
  });

  it('prefers recommended over latest when both exist', async () => {
    const forge = only(await minecraftCatalog(makeCtx()), 'forge');
    const entry = forge.find((r) => r.version === '26.1.2');
    expect(entry?.meta?.loaderVersion).toBe('59.1.2');
    expect(entry?.stable).toBe(true);
  });

  it('resolves to a maven installer with a sidecar digest', async () => {
    const ref = only(await minecraftCatalog(makeCtx()), 'forge').find((r) => r.version === '26.1.2');
    const resolved = await resolveMinecraftRef(ref as GameVersionRef, makeCtx());
    expect(resolved.meta?.installerUrl).toBe(
      'https://maven.minecraftforge.net/net/minecraftforge/forge/26.1.2-59.1.2/forge-26.1.2-59.1.2-installer.jar',
    );
    expect(resolved.meta?.installerSha256).toBe('b'.repeat(64));
    // Modern Forge leaves an @argfile rather than a runnable jar.
    expect(resolved.meta?.argfile).toBe('libraries/net/minecraftforge/forge/26.1.2-59.1.2/unix_args.txt');
    expect(resolved.meta?.launchJar).toBeUndefined();
  });
});

describe('NeoForge catalog', () => {
  it('excludes betas and keeps the newest build per Minecraft version', async () => {
    const neo = only(await minecraftCatalog(makeCtx()), 'neoforge');
    expect(neo.map((r) => r.meta?.loaderVersion)).toEqual(['26.2.0.41', '26.1.2.93', '21.1.209']);
    expect(neo.map((r) => r.version)).toEqual(['26.2', '26.1.2', '1.21.1']);
  });
});

describe('Fabric catalog', () => {
  it('lists one entry per vanilla release, pinned to the stable loader', async () => {
    const fabric = only(await minecraftCatalog(makeCtx()), 'fabric');
    expect(fabric.map((r) => r.version)).toEqual(['26.2', '26.1.2', '1.21.11']);
    expect(fabric.every((r) => r.meta?.loaderVersion === '0.18.4')).toBe(true);
  });

  it('verifies the installer against the maven sha512, not meta /server/jar', async () => {
    const ref = only(await minecraftCatalog(makeCtx()), 'fabric')[0];
    const resolved = await resolveMinecraftRef(ref, makeCtx());
    expect(resolved.meta?.installerSha512).toBe('f'.repeat(128));
    expect(String(resolved.meta?.installerUrl)).toContain('maven.fabricmc.net');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('combined catalog', () => {
  it('keeps the other flavours when one upstream is gone', async () => {
    const ctx = makeCtx({ fail: ['https://fill.papermc.io/v3/projects/paper'] });
    const refs = await minecraftCatalog(ctx);
    expect(only(refs, 'paper')).toHaveLength(0);
    expect(only(refs, 'vanilla').length).toBeGreaterThan(0);
    expect(ctx.logs.join(' ')).toMatch(/Paper catalog unavailable/);
  });

  it('fails only when every upstream is unreachable', async () => {
    const ctx = makeCtx({
      fail: [
        'https://fill.papermc.io/v3/projects/paper',
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
        'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
        'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
        'https://meta.fabricmc.net/v2/versions/loader',
      ],
    });
    await expect(minecraftCatalog(ctx)).rejects.toThrow(/every upstream unreachable/);
  });

  it('never lists a version it cannot name a Java for', async () => {
    for (const ref of await minecraftCatalog(makeCtx())) {
      expect(ref.runtime.id).toBe('java');
      expect(Number.isInteger(ref.runtime.major)).toBe(true);
      expect(ref.runtime.major).toBeGreaterThanOrEqual(8);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Family grouping — what replaced the flat 25-entry cap
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog is grouped by family, not truncated by count', () => {
  /** A manifest with more families than the budget, two releases in each, so a
   *  cut in the wrong place is visible as a family that lost a member. */
  const wideManifest = {
    versions: Array.from({ length: 20 }, (_, i) => {
      const minor = 21 - i;
      return [
        { id: `1.${minor}.2`, type: 'release', url: `https://piston-meta.mojang.com/v1/packages/x/1.${minor}.2.json` },
        { id: `1.${minor}.1`, type: 'release', url: `https://piston-meta.mojang.com/v1/packages/x/1.${minor}.1.json` },
      ];
    }).flat(),
  };

  const wide = (): CatalogCtx & { logs: string[] } => makeCtx({
    json: { 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': wideManifest },
  });

  it('tags every entry with the family the UI groups by', async () => {
    const refs = await minecraftCatalog(makeCtx());
    expect(refs.every((r) => Boolean(r.family))).toBe(true);
    const paper = only(refs, 'paper');
    expect(paper.find((r) => r.version === '1.21.11')?.family).toBe('1.21');
    expect(paper.find((r) => r.version === '26.1.2')?.family).toBe('26.1');
    // A calendar version with no patch component is its own family.
    expect(paper.find((r) => r.version === '26.2')?.family).toBe('26.2');
  });

  it('drops the oldest families whole instead of cutting one in half', async () => {
    const vanilla = only(await minecraftCatalog(wide()), 'vanilla');
    const byFamily = new Map<string, number>();
    for (const r of vanilla) byFamily.set(r.family as string, (byFamily.get(r.family as string) ?? 0) + 1);
    // The old flat limit stopped at row 25, which landed mid-family and made the
    // rows below it look as though they did not exist.
    expect([...byFamily.values()].every((n) => n === 2)).toBe(true);
    expect(byFamily.size).toBe(14);
  });

  it('keeps the newest families and cuts from the bottom', async () => {
    const vanilla = only(await minecraftCatalog(wide()), 'vanilla');
    const families = [...new Set(vanilla.map((r) => r.family))];
    expect(families[0]).toBe('1.21');
    expect(families).toContain('1.8');
    expect(families).not.toContain('1.7');
  });

  it('budgets each flavour separately, so a long history cannot crowd out another', async () => {
    // 20 vanilla families arrive alongside Paper's 4; Paper must keep all of them.
    const refs = await minecraftCatalog(wide());
    expect(new Set(only(refs, 'paper').map((r) => r.family)).size).toBe(4);
    expect(new Set(only(refs, 'vanilla').map((r) => r.family)).size).toBe(14);
  });
});

describe('isReleaseVersion', () => {
  it('accepts both versioning schemes', () => {
    expect(isReleaseVersion('1.21.11')).toBe(true);
    expect(isReleaseVersion('26.2')).toBe(true);
    expect(isReleaseVersion('26.1.2')).toBe(true);
  });

  it('rejects every prerelease form the upstreams publish', () => {
    for (const v of ['1.21.11-rc3', '1.21.11-pre5', '26.2-rc-2', '26.2.0.45-beta', '0.25w14craftmine.3-beta']) {
      expect(isReleaseVersion(v)).toBe(false);
    }
  });

  it('rejects the empty string', () => {
    expect(isReleaseVersion('')).toBe(false);
  });
});
