import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeContentManifest,
  filesInFolder,
  sha256File,
  syncContentSlots,
  type RoomContentFile,
} from './content-sync';

describe('content-sync', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  function mkTmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-content-'));
    tmpDirs.push(dir);
    return dir;
  }

  const slots = [{
    id: 'mods',
    labelKey: 'rooms.server.slot.mods',
    into: 'mods',
    extensions: ['.jar'],
    executable: true,
  }];

  it('filesInFolder matches uncategorized and named folders', () => {
    const files: RoomContentFile[] = [
      { fileId: 'a', name: 'a.jar', folderId: '', infoHash: 'aa', size: 1 },
      { fileId: 'b', name: 'b.jar', folderId: 'f1', infoHash: 'bb', size: 2 },
    ];
    expect(filesInFolder(files, '').map((f) => f.fileId)).toEqual(['a']);
    expect(filesInFolder(files, 'f1').map((f) => f.fileId)).toEqual(['b']);
  });

  it('computeContentManifest changes when room files change', () => {
    const bindings = { mods: 'f1' };
    const base: RoomContentFile[] = [
      { fileId: 'b', name: 'b.jar', folderId: 'f1', infoHash: 'bb', size: 2, localPath: '/x/b.jar' },
    ];
    const h1 = computeContentManifest(slots, bindings, base);
    const h2 = computeContentManifest(slots, bindings, [
      ...base,
      { fileId: 'c', name: 'c.jar', folderId: 'f1', infoHash: 'cc', size: 3 },
    ]);
    expect(h1).not.toBe(h2);
  });

  it('syncContentSlots copies jars and removes stale ones', async () => {
    const root = mkTmp();
    const src = path.join(mkTmp(), 'mod.jar');
    fs.writeFileSync(src, 'mod-bytes');
    const stale = path.join(root, 'mods', 'old.jar');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'old');

    const roomFiles: RoomContentFile[] = [{
      fileId: 'm1',
      name: 'mod.jar',
      folderId: 'f1',
      infoHash: 'hash',
      size: 9,
      localPath: src,
    }];

    const res = await syncContentSlots({
      instanceRoot: root,
      slots,
      bindings: { mods: 'f1' },
      roomFiles,
      hasConsent: () => true,
    });

    expect(res.copied).toBe(1);
    expect(res.removed).toBe(1);
    expect(fs.existsSync(path.join(root, 'mods', 'mod.jar'))).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('syncContentSlots blocks executable files without consent', async () => {
    const root = mkTmp();
    const src = path.join(mkTmp(), 'mod.jar');
    fs.writeFileSync(src, 'needs-consent');

    const res = await syncContentSlots({
      instanceRoot: root,
      slots,
      bindings: { mods: '' },
      roomFiles: [{
        fileId: 'm1',
        name: 'mod.jar',
        folderId: '',
        infoHash: 'hash',
        size: 9,
        localPath: src,
      }],
      hasConsent: () => false,
    });

    expect(res.pending).toHaveLength(1);
    expect(res.state).toBe('conflict');
    expect(fs.existsSync(path.join(root, 'mods', 'mod.jar'))).toBe(false);
  });

  it('re-syncing an unchanged file copies nothing', async () => {
    // The destination hash is what makes the second run cheap. It is now read as
    // a stream rather than slurped, and a regression here would be invisible
    // except as a modpack-sized copy on every sync.
    const root = mkTmp();
    const src = path.join(mkTmp(), 'mod.jar');
    fs.writeFileSync(src, 'stable bytes');
    const roomFiles: RoomContentFile[] = [{
      fileId: 'm1', name: 'mod.jar', folderId: '', infoHash: 'hash', size: 12, localPath: src,
    }];
    const opts = { instanceRoot: root, slots, bindings: { mods: '' }, roomFiles, hasConsent: () => true };

    expect((await syncContentSlots(opts)).copied).toBe(1);
    expect((await syncContentSlots(opts)).copied).toBe(0);

    // …and a changed source is picked up again.
    fs.writeFileSync(src, 'different bytes');
    expect((await syncContentSlots(opts)).copied).toBe(1);
  });

  it('sha256File streams the same digest a one-shot hash would produce', async () => {
    const file = path.join(mkTmp(), 'big.jar');
    const bytes = crypto.randomBytes(512 * 1024);
    fs.writeFileSync(file, bytes);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(await sha256File(file)).toBe(expected);
  });
});
