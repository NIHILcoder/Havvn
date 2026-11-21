import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSyncSnapshot, SYNC_SPIKE_MAX_BYTES } from './room-sync-snapshot';
import { RoomSyncApplier, syncRelativePath, type SyncApplyStep } from './room-sync-apply';
import { decryptFile, generateRoomSecret } from './room-e2e';
import { verifyRoomFile } from './room-file-storage';

let root: string, source: string, destination: string;
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'havvn-sync-files-'));
  source = path.join(root, 'config.ini');
  destination = path.join(root, 'receiver');
  fs.mkdirSync(destination);
  fs.writeFileSync(source, 'new config');
});
afterEach(() => {
  vi.restoreAllMocks();
  // root is the exclusive fixture mkdtemp, never a user-selected binding.
  fs.rmSync(root, { recursive: true, force: true });
});

const request = () => ({ relativePath: 'config.ini', source, revisionId: sha('revision-1'), digest: sha('new config'), expectedDigest: null as string | null });
const transaction = () => {
  const base = path.join(destination, '.havvn-sync', 'transactions');
  return path.join(base, fs.readdirSync(base)[0]);
};

describe('immutable sync snapshots', () => {
  it('keeps old bytes seedable after an external editor saves a new version', async () => {
    const first = await prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' });
    fs.writeFileSync(source, 'next config');
    const second = await prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' });
    expect(first.file.infoHash).not.toBe(second.file.infoHash);
    expect(first.plaintextDigest).toBe(sha('new config'));
    expect(fs.readFileSync(first.sourcePath, 'utf8')).toBe('new config');
    await verifyRoomFile(first.sourcePath, first.file, first.metadata);
    await verifyRoomFile(second.sourcePath, second.file, second.metadata);
  });

  it('leaves only authenticated ciphertext in an E2E snapshot directory', async () => {
    const secret = generateRoomSecret();
    const snapshot = await prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher', secret });
    expect(snapshot.file.enc).toBe(true);
    expect(fs.readdirSync(snapshot.directory)).toEqual(['config.ini.enc']);
    expect(fs.readFileSync(snapshot.sourcePath).includes(Buffer.from('new config'))).toBe(false);
    const plain = path.join(root, 'decrypted');
    await decryptFile(snapshot.sourcePath, plain, secret, { expectedSize: snapshot.file.size });
    expect(fs.readFileSync(plain, 'utf8')).toBe('new config');
  });

  it('handles empty files', async () => {
    fs.writeFileSync(source, '');
    const snapshot = await prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' });
    expect(snapshot.file.size).toBe(0);
    await verifyRoomFile(snapshot.sourcePath, snapshot.file, snapshot.metadata);
  });

  it('rejects a source which changed during the copy and removes its incomplete snapshot', async () => {
    const copy = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await copy(...args);
      fs.writeFileSync(source, 'an editor saved while copying');
    });
    await expect(prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' })).rejects.toThrow('changed');
    expect(fs.readdirSync(path.join(root, 'snapshots'))).toEqual([]);
  });

  it('cancels before publication and cleans both plaintext and ciphertext', async () => {
    let calls = 0;
    await expect(prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher',
      secret: generateRoomSecret(), isCurrent: () => ++calls < 3 })).rejects.toThrow('canceled');
    expect(fs.readdirSync(path.join(root, 'snapshots'))).toEqual([]);
  });

  it('rejects oversized sources before reading them', async () => {
    fs.truncateSync(source, SYNC_SPIKE_MAX_BYTES + 1);
    await expect(prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' })).rejects.toThrow('size');
    expect(fs.existsSync(path.join(root, 'snapshots'))).toBe(false);
  });

  it('refuses hardlinked sources', async () => {
    fs.linkSync(source, path.join(root, 'other'));
    await expect(prepareSyncSnapshot({ source, storage: path.join(root, 'snapshots'), authorId: 'publisher' })).rejects.toThrow('Linked');
  });
});

describe('journaled sync application', () => {
  it.each(['prepared', 'previous-saved', 'published', 'committed'] as SyncApplyStep[])('recovers a move after a crash at %s without losing the source', async step => {
    fs.writeFileSync(path.join(destination, 'old.ini'), 'old config');
    await expect(new RoomSyncApplier(destination).apply({ ...request(), fromPath: 'old.ini', relativePath: 'nested/new.ini', expectedDigest: sha('old config') }, phase => {
      if (phase === step) throw new Error('power loss');
    })).rejects.toThrow('power loss');
    const recovered = await new RoomSyncApplier(destination).recover();
    const published = step === 'published' || step === 'committed';
    expect(recovered[0].state).toBe(published ? 'applied' : 'rolled-back');
    expect(fs.existsSync(path.join(destination, 'old.ini'))).toBe(!published);
    expect(fs.existsSync(path.join(destination, 'nested/new.ini'))).toBe(published);
    if (published) expect(fs.readFileSync(recovered[0].previousPath!, 'utf8')).toBe('old config');
    else expect(fs.readFileSync(path.join(destination, 'old.ini'), 'utf8')).toBe('old config');
    expect(await new RoomSyncApplier(destination).recover()).toEqual(recovered);
  });
  it('preserves an occupied destination and restores the absent source after a late save', async () => {
    fs.writeFileSync(path.join(destination, 'old.ini'), 'old config');
    await expect(new RoomSyncApplier(destination).apply({ ...request(), fromPath: 'old.ini', expectedDigest: sha('old config') }, phase => {
      if (phase === 'previous-saved') fs.writeFileSync(path.join(destination, 'config.ini'), 'external destination');
    })).rejects.toThrow();
    expect((await new RoomSyncApplier(destination).recover())[0].state).toBe('rolled-back');
    expect(fs.readFileSync(path.join(destination, 'old.ini'), 'utf8')).toBe('old config');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('external destination');
  });
  it('preserves all three copies when an editor recreates the old path during publication', async () => {
    fs.writeFileSync(path.join(destination, 'old.ini'), 'old config');
    await expect(new RoomSyncApplier(destination).apply({ ...request(), fromPath: 'old.ini', expectedDigest: sha('old config') }, phase => {
      if (phase === 'published') fs.writeFileSync(path.join(destination, 'old.ini'), 'late source save');
    })).rejects.toThrow('move source');
    const [recovered] = await new RoomSyncApplier(destination).recover(); expect(recovered.state).toBe('conflict');
    expect(fs.readFileSync(path.join(destination, 'old.ini'), 'utf8')).toBe('late source save');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('new config');
    expect(fs.readFileSync(recovered.previousPath!, 'utf8')).toBe('old config');
  });
  it('applies two revisions at the same path and retains the previous bytes', async () => {
    const applier = new RoomSyncApplier(destination);
    const a = await applier.apply(request());
    fs.writeFileSync(source, 'next config');
    const b = await applier.apply({ ...request(), revisionId: sha('revision-2'), digest: sha('next config'), expectedDigest: sha('new config') });
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('next config');
    expect(fs.readFileSync(b.previousPath!, 'utf8')).toBe('new config');
    expect((await new RoomSyncApplier(destination).recover()).map(r => r.revisionId).sort()).toEqual([a.revisionId, b.revisionId].sort());
  });

  it('never overwrites an existing unrelated local file', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'local work');
    await expect(new RoomSyncApplier(destination).apply(request())).rejects.toThrow('local changes');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('local work');
  });

  it('checks actual copied bytes before touching the working file', async () => {
    await expect(new RoomSyncApplier(destination).apply({ ...request(), digest: sha('wrong bytes') })).rejects.toThrow('does not match');
    expect(fs.existsSync(path.join(destination, 'config.ini'))).toBe(false);
    expect(fs.readdirSync(path.join(destination, '.havvn-sync', 'transactions'))).toEqual([]);
  });

  it('refuses a volume without hardlink support before moving the original', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    vi.spyOn(fs.promises, 'link').mockRejectedValue(Object.assign(new Error('hardlinks unsupported'), { code: 'ENOTSUP' }));
    await expect(new RoomSyncApplier(destination).apply({ ...request(), expectedDigest: sha('old config') })).rejects.toThrow('unsupported');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('old config');
    expect(fs.readdirSync(path.join(destination, '.havvn-sync', 'transactions'))).toEqual([]);
  });

  it.each<SyncApplyStep>(['prepared', 'previous-saved', 'published', 'committed'])('recovers a restart after %s', async step => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply({ ...request(), expectedDigest: sha('old config') }, current => {
      if (current === step) throw new Error('simulated process exit');
    })).rejects.toThrow('simulated');
    const restarted = new RoomSyncApplier(destination);
    const [receipt] = await restarted.recover();
    const published = step === 'published' || step === 'committed';
    expect(receipt.state).toBe(published ? 'applied' : 'rolled-back');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe(published ? 'new config' : 'old config');
    expect(await restarted.recover()).toEqual([receipt]);
  });

  it('does not treat a file edited after a committed update as a failed transaction', async () => {
    await new RoomSyncApplier(destination).apply(request());
    fs.writeFileSync(path.join(destination, 'config.ini'), 'later local work');
    expect((await new RoomSyncApplier(destination).recover())[0].state).toBe('applied');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('later local work');
  });

  it('keeps both versions when an editor creates the destination just before publication', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply({ ...request(), expectedDigest: sha('old config') }, step => {
      if (step === 'previous-saved') fs.writeFileSync(path.join(destination, 'config.ini'), 'local save');
    })).rejects.toThrow();
    expect((await applier.recover())[0].state).toBe('conflict');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('local save');
    expect(fs.readFileSync(path.join(transaction(), 'previous'), 'utf8')).toBe('old config');
    expect(fs.readFileSync(path.join(transaction(), 'next'), 'utf8')).toBe('new config');
    await expect(applier.apply(request())).rejects.toThrow('recovery required');
  });

  it('restores a late write made through an editor handle to the moved original', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply({ ...request(), expectedDigest: sha('old config') }, step => {
      if (step === 'previous-saved') fs.writeFileSync(path.join(transaction(), 'previous'), 'late editor work');
    })).rejects.toThrow('local changes');
    expect((await applier.recover())[0].state).toBe('rolled-back');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('late editor work');
  });

  it('serializes independent appliers so only one absent-file publication succeeds', async () => {
    const results = await Promise.allSettled([new RoomSyncApplier(destination).apply(request()), new RoomSyncApplier(destination).apply(request())]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('new config');
  });

  it('recovers a process exit between publishing a hard link and removing the staged link', async () => {
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async candidate => {
      if (path.basename(String(candidate)) === 'next') throw new Error('simulated process exit');
      await unlink(candidate);
    });
    await expect(new RoomSyncApplier(destination).apply(request())).rejects.toThrow('simulated');
    vi.restoreAllMocks();
    expect((await new RoomSyncApplier(destination).recover())[0].state).toBe('applied');
    expect(fs.statSync(path.join(destination, 'config.ini')).nlink).toBe(1);
  });

  it('recovers an interrupted rollback without rejecting its own temporary hard link', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply({ ...request(), expectedDigest: sha('old config') }, step => {
      if (step === 'previous-saved') throw new Error('simulated process exit');
    })).rejects.toThrow('simulated');
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async candidate => {
      if (path.basename(String(candidate)) === 'previous') throw new Error('rollback process exit');
      await unlink(candidate);
    });
    await expect(applier.recover()).rejects.toThrow('rollback');
    vi.restoreAllMocks();
    expect((await new RoomSyncApplier(destination).recover())[0].state).toBe('rolled-back');
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('old config');
  });

  it('does not block future updates on a pre-journal abandoned staging directory', async () => {
    const orphan = path.join(destination, '.havvn-sync', 'transactions', 'op-orphan');
    fs.mkdirSync(orphan, { recursive: true }); fs.writeFileSync(path.join(orphan, 'next'), 'unpublished');
    const applier = new RoomSyncApplier(destination);
    expect(await applier.recover()).toEqual([]);
    expect((await applier.apply(request())).state).toBe('applied');
  });

  it('refuses a modified journal that attempts to escape the binding', async () => {
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply(request(), step => { if (step === 'prepared') throw new Error('exit'); })).rejects.toThrow();
    const journalPath = path.join(transaction(), 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); journal.relativePath = '../config.ini';
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    await expect(applier.recover()).rejects.toThrow();
    expect(fs.readFileSync(source, 'utf8')).toBe('new config');
  });

  it('does not trust a receipt merely because a file with that name exists', async () => {
    const applier = new RoomSyncApplier(destination);
    await applier.apply(request());
    fs.writeFileSync(path.join(transaction(), 'receipt.json'), '{}');
    await expect(applier.recover()).rejects.toThrow('Invalid sync receipt');
    await expect(applier.apply({ ...request(), expectedDigest: sha('new config') })).rejects.toThrow('Invalid sync receipt');
  });

  it('refuses a junction in the destination tree', async () => {
    fs.symlinkSync(root, path.join(destination, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new RoomSyncApplier(destination).apply({ ...request(), relativePath: 'escape/stolen.ini' })).rejects.toThrow('Linked');
    expect(fs.existsSync(path.join(root, 'stolen.ini'))).toBe(false);
  });

  it('cancels after moving the previous file and recovers it', async () => {
    fs.writeFileSync(path.join(destination, 'config.ini'), 'old config');
    let current = true;
    const applier = new RoomSyncApplier(destination);
    await expect(applier.apply({ ...request(), expectedDigest: sha('old config'), isCurrent: () => current }, step => {
      if (step === 'previous-saved') current = false;
    })).rejects.toThrow('canceled');
    await applier.recover();
    expect(fs.readFileSync(path.join(destination, 'config.ini'), 'utf8')).toBe('old config');
  });

  it.skipIf(process.platform !== 'win32')('keeps the working copy when Windows denies replacement of an open file', async () => {
    const target = path.join(destination, 'config.ini');
    fs.writeFileSync(target, 'old config');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const locker = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command',
      "$stream = [System.IO.File]::Open($env:HAVVN_SYNC_TEST_LOCK, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $stream.Dispose()"],
    { windowsHide: true, env: { ...process.env, HAVVN_SYNC_TEST_LOCK: target }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => { locker.once('exit', () => resolve()); locker.once('error', reject); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Windows file locker timed out')), 5000);
        const done = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
        locker.stdout.once('data', () => done());
        locker.stderr.once('data', data => done(new Error(String(data))));
        locker.once('error', done);
      });
      const steps: SyncApplyStep[] = [];
      const applier = new RoomSyncApplier(destination);
      await expect(applier.apply({ ...request(), expectedDigest: sha('old config') }, step => { steps.push(step); })).rejects.toThrow();
      expect(steps).toEqual(['prepared']);
      expect((await applier.recover())[0].state).toBe('rolled-back');
    } finally {
      locker.stdin.end('\n');
      // Always reap the helper, including an assertion failure.
      const timer = setTimeout(() => locker.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('old config');
  }, 15_000);

  it.each(['../file', '/file', 'a//b', 'a\\b', 'C:/file', 'a/CON.txt', 'a/file:ads', 'a/file.', '.havvn-sync/file', 'a/../b'])('rejects unsafe relative paths: %s', candidate => {
    expect(() => syncRelativePath(candidate)).toThrow();
  });
});
