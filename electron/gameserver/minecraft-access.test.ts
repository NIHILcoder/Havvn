/**
 * Reading and writing Minecraft's own player access files.
 *
 * These are not our file formats — the server reads them at startup and on
 * `/whitelist reload`, so the filenames and the on-disk shape are a contract
 * with someone else's parser. Getting either wrong fails silently: the server
 * finds no file, applies no whitelist, and lets everyone in.
 *
 * The other half is tolerance. These files are edited by the server itself
 * while it runs, by operators through the game console, and sometimes by hand;
 * this module reads them from a panel, so anything malformed has to come back
 * as "nothing to show" rather than as an exception through the IPC boundary.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readBannedPlayers, readWhitelist, writeBannedPlayers, writeWhitelist,
} from './minecraft-access';

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-mc-access-'));
  tmpDirs.push(dir);
  return dir;
}

const readRaw = (root: string, file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

describe('file names', () => {
  it('writes the exact names the server looks for', () => {
    // A typo here is invisible: the server finds no whitelist, enforces none,
    // and the panel happily shows the list it thinks it saved.
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }]);
    writeBannedPlayers(root, [{ uuid: 'u2', name: 'Ivo' }]);

    expect(fs.readdirSync(root).sort()).toEqual(['banned-players.json', 'whitelist.json']);
  });

  it('keeps the two lists apart', () => {
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }]);
    writeBannedPlayers(root, [{ uuid: 'u2', name: 'Ivo' }]);

    expect(readWhitelist(root).map((e) => e.name)).toEqual(['Mara']);
    expect(readBannedPlayers(root).map((e) => e.name)).toEqual(['Ivo']);
  });

  it('creates the instance directory when it is not there yet', () => {
    // The panel can save before the server has ever run, so `root/` may not exist.
    const root = path.join(mkRoot(), 'nested', 'root');
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }]);
    expect(readWhitelist(root)).toEqual([{ uuid: 'u1', name: 'Mara' }]);
  });
});

describe('on-disk shape', () => {
  it('writes a JSON array the server can parse', () => {
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }, { uuid: 'u2', name: 'Ivo' }]);

    const parsed = JSON.parse(readRaw(root, 'whitelist.json'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([{ uuid: 'u1', name: 'Mara' }, { uuid: 'u2', name: 'Ivo' }]);
  });

  it('round-trips through disk unchanged', () => {
    const root = mkRoot();
    const entries = [{ uuid: 'u1', name: 'Mara' }, { uuid: 'u2', name: 'Ivo' }];
    writeWhitelist(root, entries);
    expect(readWhitelist(root)).toEqual(entries);
  });

  it('replaces the file rather than appending to it', () => {
    // Removing someone rewrites the whole list; a leftover entry would silently
    // keep a removed player whitelisted.
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }, { uuid: 'u2', name: 'Ivo' }]);
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }]);
    expect(readWhitelist(root).map((e) => e.name)).toEqual(['Mara']);
  });

  it('writes an empty list as an empty array, not as no file', () => {
    // Emptying the whitelist must leave the server something to read, or it
    // falls back to whatever was there before.
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: 'Mara' }]);
    writeWhitelist(root, []);
    expect(JSON.parse(readRaw(root, 'whitelist.json'))).toEqual([]);
    expect(readWhitelist(root)).toEqual([]);
  });
});

describe('uuids', () => {
  it('substitutes the null uuid when there is none', () => {
    // A name typed into the panel has no Mojang account id behind it — nothing
    // offline can resolve one. The null uuid is what makes the entry writable;
    // it is also why an online-mode server will not match it, which the panel
    // says out loud.
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: '', name: 'Mara' }]);
    expect(readWhitelist(root)).toEqual([{ uuid: NULL_UUID, name: 'Mara' }]);
  });

  it('leaves a real uuid alone', () => {
    const root = mkRoot();
    const uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
    writeWhitelist(root, [{ uuid, name: 'Notch' }]);
    expect(readWhitelist(root)[0].uuid).toBe(uuid);
  });
});

describe('names', () => {
  it('trims surrounding whitespace on the way in and out', () => {
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: 'u1', name: '  Mara  ' }]);
    expect(JSON.parse(readRaw(root, 'whitelist.json'))[0].name).toBe('Mara');
    expect(readWhitelist(root)[0].name).toBe('Mara');
  });

  it('drops entries with no name', () => {
    // A nameless entry is unusable to the server and unremovable in the panel,
    // which keys its rows by name.
    const root = mkRoot();
    writeWhitelist(root, [
      { uuid: 'u1', name: 'Mara' },
      { uuid: 'u2', name: '' },
      { uuid: 'u3', name: '   ' },
    ]);
    expect(readWhitelist(root).map((e) => e.name)).toEqual(['Mara']);
  });

  it('drops nameless entries found on disk too', () => {
    const root = mkRoot();
    fs.writeFileSync(
      path.join(root, 'whitelist.json'),
      JSON.stringify([{ uuid: 'u1' }, { uuid: 'u2', name: 'Ivo' }]),
      'utf8',
    );
    expect(readWhitelist(root).map((e) => e.name)).toEqual(['Ivo']);
  });
});

describe('fields the server owns', () => {
  /** Exactly what a vanilla server writes for a ban. */
  const REAL_BAN = {
    uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    name: 'Notch',
    created: '2026-08-01 12:00:00 +0300',
    source: 'Server',
    expires: '2026-09-01 12:00:00 +0300',
    reason: 'Griefing spawn',
  };

  it('hands the extra fields back on read instead of dropping them', () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'banned-players.json'), JSON.stringify([REAL_BAN]), 'utf8');

    expect(readBannedPlayers(root)).toEqual([{
      uuid: REAL_BAN.uuid,
      name: 'Notch',
      extra: {
        created: REAL_BAN.created,
        source: REAL_BAN.source,
        expires: REAL_BAN.expires,
        reason: REAL_BAN.reason,
      },
    }]);
  });

  it('writes an untouched entry back byte for byte', () => {
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'banned-players.json'), JSON.stringify([REAL_BAN]), 'utf8');
    writeBannedPlayers(root, readBannedPlayers(root));

    expect(JSON.parse(readRaw(root, 'banned-players.json'))).toEqual([REAL_BAN]);
  });

  it('unbanning one player leaves every other ban intact', () => {
    // The regression this exists for. The panel unbans by rewriting the WHOLE
    // file from what it read, so a read that dropped `expires` and `reason`
    // turned every remaining temporary ban into a permanent one with no reason
    // — a silent edit of punishments nobody asked to change.
    const root = mkRoot();
    const other = {
      uuid: '61699b2e-d327-4a01-9f1e-0ea8c3f06bc6',
      name: 'Dinnerbone',
      created: '2026-08-02 09:30:00 +0300',
      source: 'Server',
      expires: 'forever',
      reason: 'Banned by an operator.',
    };
    fs.writeFileSync(path.join(root, 'banned-players.json'), JSON.stringify([REAL_BAN, other]), 'utf8');

    const list = readBannedPlayers(root);
    writeBannedPlayers(root, list.filter((e) => e.name !== 'Dinnerbone'));

    expect(JSON.parse(readRaw(root, 'banned-players.json'))).toEqual([REAL_BAN]);
  });

  it('keeps uuid and name authoritative over anything in extra', () => {
    // `extra` never holds either — read destructures them out — so a caller that
    // forges one cannot smuggle a different player past the fields we own.
    const root = mkRoot();
    writeWhitelist(root, [{
      uuid: 'real-uuid',
      name: 'Mara',
      extra: { uuid: 'forged', name: 'Someone Else', note: 'kept' } as Record<string, unknown>,
    }]);

    expect(readWhitelist(root)).toEqual([
      { uuid: 'real-uuid', name: 'Mara', extra: { note: 'kept' } },
    ]);
  });

  it('adds a new entry without inventing fields for it', () => {
    // A name typed into the panel has no server-side history behind it.
    const root = mkRoot();
    writeWhitelist(root, [{ uuid: '', name: 'Mara' }]);
    expect(JSON.parse(readRaw(root, 'whitelist.json'))).toEqual([
      { uuid: NULL_UUID, name: 'Mara' },
    ]);
  });

  it('survives a round trip through JSON, the way IPC carries it', () => {
    // The panel is in the renderer: the list crosses the process boundary and
    // comes back. Anything not structured-clone-able would be lost there.
    const root = mkRoot();
    fs.writeFileSync(path.join(root, 'banned-players.json'), JSON.stringify([REAL_BAN]), 'utf8');

    const overIpc = JSON.parse(JSON.stringify(readBannedPlayers(root)));
    writeBannedPlayers(root, overIpc);

    expect(JSON.parse(readRaw(root, 'banned-players.json'))).toEqual([REAL_BAN]);
  });
});

describe('tolerating what is already on disk', () => {
  it('reports an absent file as an empty list', () => {
    // A fresh instance has never written one, and the panel opens before the
    // server has ever run.
    const root = mkRoot();
    expect(readWhitelist(root)).toEqual([]);
    expect(readBannedPlayers(root)).toEqual([]);
  });

  it('survives a truncated or malformed file', () => {
    // The server rewrites these while it runs; a kill mid-write leaves half a
    // file behind. Throwing here would surface as a broken panel.
    const root = mkRoot();
    for (const junk of ['', '   ', '{', '[{"uuid":', 'not json at all']) {
      fs.writeFileSync(path.join(root, 'whitelist.json'), junk, 'utf8');
      expect(readWhitelist(root)).toEqual([]);
    }
  });

  it('ignores valid JSON that is not a list', () => {
    const root = mkRoot();
    for (const shape of ['{"uuid":"u1","name":"Mara"}', '"Mara"', '42', 'null']) {
      fs.writeFileSync(path.join(root, 'whitelist.json'), shape, 'utf8');
      expect(readWhitelist(root)).toEqual([]);
    }
  });

  it('skips junk entries without losing the good ones around them', () => {
    const root = mkRoot();
    fs.writeFileSync(
      path.join(root, 'whitelist.json'),
      JSON.stringify([null, { uuid: 'u1', name: 'Mara' }, 'Ivo', 7, { uuid: 'u2', name: 'Bo' }]),
      'utf8',
    );
    expect(readWhitelist(root).map((e) => e.name)).toEqual(['Mara', 'Bo']);
  });

  it('coerces non-string uuid and name fields rather than failing', () => {
    const root = mkRoot();
    fs.writeFileSync(
      path.join(root, 'banned-players.json'),
      JSON.stringify([{ uuid: 123, name: 456 }]),
      'utf8',
    );
    expect(readBannedPlayers(root)).toEqual([{ uuid: '123', name: '456' }]);
  });
});
