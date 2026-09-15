/** WebTorrent 1.x uses an array; 3.x uses a Selections collection. */
export function clearSelections(selections: unknown): void {
  if (Array.isArray(selections)) {
    selections.length = 0;
  } else if (selections && typeof selections === 'object' &&
      'clear' in selections && typeof selections.clear === 'function') {
    selections.clear();
  } else {
    throw new Error('Unsupported WebTorrent selection collection');
  }
}

export function hasNoSelections(selections: unknown): boolean {
  return !!selections && typeof selections === 'object' &&
    'length' in selections && selections.length === 0;
}
