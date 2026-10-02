/** A pin may identify the chain's original owner or a verified later owner. */
export function assertCompatibleOwnerPin(record: {
  ownerPin?: string; ownerId?: string;
  transferChain?: Array<{ by: string; newOwnerId: string }>;
}, pin: string): void {
  if (!pin) return;
  const chain = record.transferChain ?? [];
  const known = record.ownerPin || chain[0]?.by || record.ownerId;
  if (!known || pin === known) return;
  if (chain.length && (chain[0].by === known || chain.some((link) => link.newOwnerId === known))
    && (pin === chain[0].by || chain.some((link) => link.newOwnerId === pin))) return;
  throw new Error('The invite owner pin conflicts with this room.');
}
