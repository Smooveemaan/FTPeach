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

export function availableCopyName(
  name: string,
  entries: FileEntryLike[],
  kind: 'local' | 'remote',
): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const marker = /^(.*) \(copy(?: (\d+))?\)$/.exec(stem);
  const base = marker?.[1] ?? stem;
  let suffix = marker?.[2] ? Number(marker[2]) + 1 : marker ? 2 : 1;
  const matches = (candidate: string) =>
    entries.some((entry) =>
      kind === 'local'
        ? entry.name?.toLowerCase() === candidate.toLowerCase()
        : entry.name === candidate,
    );
  let candidate: string;
  do {
    candidate = `${base} (copy${suffix === 1 ? '' : ` ${suffix}`})${extension}`;
    suffix++;
  } while (matches(candidate));
  return candidate;
}
