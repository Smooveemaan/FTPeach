// Whether a transfer would overwrite something at the destination. The rule
// that two directories of the same name merge rather than collide is a
// transfer rule, so it lives with transfers.

export interface FileEntryLike {
  name?: string;
  isDirectory?: boolean;
}

export function isTransferNameConflict(
  sourceEntry?: FileEntryLike | null,
  destinationEntry?: FileEntryLike | null,
): boolean {
  if (!destinationEntry) return false;
  return !(sourceEntry?.isDirectory && destinationEntry.isDirectory);
}
