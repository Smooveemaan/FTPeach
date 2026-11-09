import { api } from '../../platform/api/index.ts';
import type { ApplicationCandidate } from '../../platform/ipcContracts.ts';

const cache = new Map<string, ApplicationCandidate[]>();
const inFlight = new Map<string, Promise<ApplicationCandidate[]>>();

export function extensionOf(fileName: string): string {
  const base = fileName.split('/').pop()?.split('\\').pop() ?? fileName;
  const parts = base.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
}

export function getOpenWithCandidates(fileName: string): ApplicationCandidate[] {
  const ext = extensionOf(fileName);
  return cache.get(ext) ?? [];
}

export function setOpenWithCandidatesForTest(
  extension: string,
  candidates: ApplicationCandidate[],
): void {
  cache.set(extension.toLowerCase(), candidates);
}

export function clearOpenWithCandidatesForTest(): void {
  cache.clear();
  inFlight.clear();
}

export async function preloadOpenWithCandidates(fileName: string): Promise<ApplicationCandidate[]> {
  const ext = extensionOf(fileName);
  const cached = cache.get(ext);
  if (cached) return cached;
  const existing = inFlight.get(ext);
  if (existing) return existing;

  const promise = api.openWith
    .applications(fileName)
    .then((candidates) => {
      cache.set(ext, candidates);
      inFlight.delete(ext);
      return candidates;
    })
    .catch(() => {
      inFlight.delete(ext);
      return [];
    });

  inFlight.set(ext, promise);
  return promise;
}

export function preloadExtensions(fileNames: readonly string[]): void {
  for (const name of fileNames) {
    const ext = extensionOf(name);
    if (ext && !cache.has(ext) && !inFlight.has(ext)) {
      void preloadOpenWithCandidates(name);
    }
  }
}
