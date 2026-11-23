// Whether a transfer would overwrite something at the destination. The rule
// that two directories of the same name merge rather than collide is a
// transfer rule, so it lives with transfers.

import { hostPlatform, type Platform } from '../../platform/os.ts';

export interface FileEntryLike {
  name?: string;
  isDirectory?: boolean;
}

export function namesMatchForTransfer(
  kind: 'local' | 'remote',
  left: string,
  right: string,
  platform: Platform = hostPlatform(),
): boolean {
  if (kind !== 'local') return left === right;
  if (platform === 'macos') {
    return left.normalize('NFC').toLowerCase() === right.normalize('NFC').toLowerCase();
  }
  return left.toLowerCase() === right.toLowerCase();
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
  platform: Platform = hostPlatform(),
): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const marker = /^(.*) \(copy(?: (\d+))?\)$/.exec(stem);
  const base = marker?.[1] ?? stem;
  let suffix = marker?.[2] ? Number(marker[2]) + 1 : marker ? 2 : 1;
  const matches = (candidate: string) =>
    entries.some(
      (entry) => entry.name != null && namesMatchForTransfer(kind, entry.name, candidate, platform),
    );
  let candidate: string;
  do {
    candidate = `${base} (copy${suffix === 1 ? '' : ` ${suffix}`})${extension}`;
    suffix++;
  } while (matches(candidate));
  return candidate;
}
