import { describe, expect, it } from 'vitest';
import { assertCompatibleOwnerPin } from './room-owner-pin';

describe('refining an invite owner pin', () => {
  it('accepts an unknown or matching owner and rejects a contradictory one', () => {
    expect(() => assertCompatibleOwnerPin({}, 'A')).not.toThrow();
    expect(() => assertCompatibleOwnerPin({ ownerId: 'A' }, 'A')).not.toThrow();
    expect(() => assertCompatibleOwnerPin({ ownerPin: 'A' }, 'B')).toThrow('conflicts');
    expect(() => assertCompatibleOwnerPin({ ownerId: 'A' }, 'B')).toThrow('conflicts');
  });
  it('accepts original and current owners on the same verified transfer chain', () => {
    const transferChain = [{ by: 'A', newOwnerId: 'B' }, { by: 'B', newOwnerId: 'C' }];
    for (const ownerPin of ['A', 'B', 'C']) for (const pin of ['A', 'B', 'C']) {
      expect(() => assertCompatibleOwnerPin({ ownerPin, ownerId: 'C', transferChain }, pin)).not.toThrow();
    }
    expect(() => assertCompatibleOwnerPin({ ownerId: 'C', transferChain }, 'A')).not.toThrow();
    expect(() => assertCompatibleOwnerPin({ ownerPin: 'X', transferChain }, 'C')).toThrow('conflicts');
    expect(() => assertCompatibleOwnerPin({ ownerPin: 'A', transferChain }, 'X')).toThrow('conflicts');
  });
});
