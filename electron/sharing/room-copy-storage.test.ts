import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteManagedCopy, managedCopy, roomTreeBytes } from './room-copy-storage';
import { newRoomFilePath } from './room-file-storage';
const roots: string[] = [];
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(),'havvn-copy-')); roots.push(value); return value; }
afterEach(()=>{ for (const value of roots.splice(0)) fs.rmSync(value,{ recursive: true, force: true }); });
describe('managed room copy eviction', () => {
  it('deletes only the selected bytes and retains neighbours and source originals', () => {
    const base = root(), copyPath = newRoomFilePath(base,'file','copy.bin'), source = path.join(base,'source.bin');
    fs.writeFileSync(copyPath,'copy'); fs.writeFileSync(source,'original'); fs.writeFileSync(path.join(path.dirname(copyPath),'neighbour'),'keep');
    const copy = managedCopy(base,'file',copyPath,'plaintext')!;
    expect(deleteManagedCopy(copy)).toBe(4); expect(fs.readFileSync(source,'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(path.dirname(copyPath),'neighbour'),'utf8')).toBe('keep');
    expect(managedCopy(base,'file',source,'plaintext')).toBeUndefined();
  });
  it('refuses stale previews and another file ID', () => {
    const base=root(), target=newRoomFilePath(base,'file','copy');fs.writeFileSync(target,'before');
    const copy=managedCopy(base,'file',target,'plaintext')!; fs.writeFileSync(target,'changed');
    expect(()=>deleteManagedCopy(copy)).toThrow(/changed/); expect(fs.existsSync(target)).toBe(true);
    expect(managedCopy(base,'different',target,'plaintext')).toBeUndefined();
  });
  it('does not traverse a junction or delete a hard-linked source', () => {
    const base=root(), external=root(), target=newRoomFilePath(external,'file','source');fs.writeFileSync(target,'private');
    const linked=path.join(base,'linked');fs.symlinkSync(external,linked,'junction');
    expect(managedCopy(linked,'file',target.replace(external,linked),'plaintext')).toBeUndefined();
    const hard=newRoomFilePath(base,'file','hard');fs.linkSync(target,hard);
    expect(managedCopy(base,'file',hard,'plaintext')).toBeUndefined();expect(fs.readFileSync(target,'utf8')).toBe('private');
  });
  it('accepts a generated ciphertext slot but never an arbitrary cache file', () => {
    const base=root(), slot=fs.mkdtempSync(path.join(base,'share-')), target=path.join(slot,'cipher.enc');fs.writeFileSync(target,'cipher');
    expect(managedCopy(base,'file',target,'ciphertext')?.bytes).toBe(6);
    expect(managedCopy(base,'file',target,'plaintext')).toBeUndefined();
    const unknown=path.join(base,'do-not-touch');fs.writeFileSync(unknown,'private');
    expect(managedCopy(base,'file',unknown,'ciphertext')).toBeUndefined();
  });
});


it('accounts for orphaned cache bytes without traversing junctions or deleting unknown copies', async () => {
  const base=root(), external=root(), known=newRoomFilePath(base,'known','file');fs.writeFileSync(known,'known');
  fs.writeFileSync(path.join(base,'orphan'),'unmapped');fs.writeFileSync(path.join(external,'private'),'external bytes');fs.symlinkSync(external,path.join(base,'junction'),'junction');
  expect(await roomTreeBytes(base)).toEqual({bytes:13,skipped:1});expect(fs.readFileSync(path.join(base,'orphan'),'utf8')).toBe('unmapped');
});
