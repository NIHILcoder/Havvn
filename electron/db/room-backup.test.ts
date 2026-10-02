import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openRoomBackup, sealRoomBackup, writeRoomBackup } from './room-backup';
const password = 'long private password 123';
describe('portable authenticated room backup', () => {
  it('round trips secrets and uses independent salt and nonce for each export', async () => {
    const bundle={ identity: { priv: 'private signing key' }, secret: 'old room key', pages: ['signed page'] };
    const one=await sealRoomBackup(bundle,password), two=await sealRoomBackup(bundle,password);
    expect(one).not.toBe(two);expect(one).not.toContain(bundle.identity.priv);expect(one).not.toContain(bundle.secret);
    expect(await openRoomBackup(one,password)).toEqual(bundle);
  });
  it('rejects wrong passwords, tag/ciphertext corruption and header downgrade', async () => {
    const content=await sealRoomBackup({ secret: 'protected' },password), raw=JSON.parse(content);
    await expect(openRoomBackup(content,'wrong long password')).rejects.toThrow(/password|damaged/);
    await expect(openRoomBackup(JSON.stringify({ ...raw, tag: '00'.repeat(16) }),password)).rejects.toThrow(/damaged/);
    await expect(openRoomBackup(JSON.stringify({ ...raw, version: 2 }),password)).rejects.toThrow(/Unsupported/);
    await expect(openRoomBackup(JSON.stringify({ ...raw, N: 2**30 }),password)).rejects.toThrow(/Unsupported/);
    await expect(openRoomBackup(JSON.stringify({ ...raw, data: raw.data.slice(0,-1) }),password)).rejects.toThrow();
  });
  it('does not accept plaintext legacy JSON or weak/unbounded passwords', async () => {
    await expect(openRoomBackup(JSON.stringify({ version: 1, identity: { priv: 'exposed' } }),password)).rejects.toThrow(/Unsupported/);
    for (const invalid of ['', 'short', 'a'.repeat(1025), null]) await expect(sealRoomBackup({},invalid)).rejects.toThrow(/password/);
  });
  it('writes ciphertext atomically and replaces an existing backup without plaintext temp files', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'havvn-backup-'));
    try {
      const target=path.join(root,'backup.havvn-backup');await fs.writeFile(target,'old');
      const content=await sealRoomBackup({ secret: 'sensitive' },password);await writeRoomBackup(target,content);
      expect(await fs.readFile(target,'utf8')).toBe(content);expect(await fs.readdir(root)).toEqual(['backup.havvn-backup']);
      await expect(writeRoomBackup(path.join(root,'missing','backup'),content)).rejects.toThrow();expect(await fs.readFile(target,'utf8')).toBe(content);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });
});
