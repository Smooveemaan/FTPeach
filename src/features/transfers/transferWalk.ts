import { joinLocalPath, joinRemotePath } from '../../shared/paths.ts';
import { api } from '../../platform/api/index.ts';

const MAX_WALK_DEPTH = 40;

export function validateWindowsDownloadName(relativePath: string): void {
  for (const name of relativePath.split(/[\\/]/)) {
    const stem = name.split('.')[0]!.toUpperCase();
    if (
      !name ||
      name === '.' ||
      name === '..' ||
      /[<>:"|?*]/.test(name) ||
      [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/.test(
        stem,
      )
    ) {
      throw new Error(`${relativePath}: Invalid Windows download name`);
    }
  }
}

export interface LocalWalkFile {
  local: string;
  rel: string;
  size?: number | undefined;
}

export interface RemoteWalkFile {
  remote: string;
  rel: string;
}

export interface WalkResult<T> {
  files: T[];
  dirs: string[];
}

export async function walkLocalDir(
  localDirPath: string,
  relPrefix: string,
  depth = 0,
  list = api.fsLocal.list,
): Promise<WalkResult<LocalWalkFile>> {
  if (depth > MAX_WALK_DEPTH)
    throw new Error(`${localDirPath}: Folder nesting exceeds ${MAX_WALK_DEPTH}`);
  const result = await list(localDirPath);
  if (!result.ok) throw new Error(`${localDirPath}: ${result.error || 'Failed to list folder'}`);

  const files: LocalWalkFile[] = [];
  const dirs: string[] = [];
  for (const entry of result.entries) {
    const fullPath = joinLocalPath(localDirPath, entry.name);
    const relativePath = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory) {
      dirs.push(relativePath);
      const nested = await walkLocalDir(fullPath, relativePath, depth + 1, list);
      files.push(...nested.files);
      dirs.push(...nested.dirs);
    } else {
      files.push({ local: fullPath, rel: relativePath, size: entry.size });
    }
  }
  return { files, dirs };
}

export async function walkRemoteDir(
  connectionId: string,
  remoteDirPath: string,
  relPrefix: string,
  depth = 0,
  list = api.session.list,
): Promise<WalkResult<RemoteWalkFile>> {
  if (depth > MAX_WALK_DEPTH)
    throw new Error(`${remoteDirPath}: Folder nesting exceeds ${MAX_WALK_DEPTH}`);
  const result = await list(connectionId, remoteDirPath);
  if (!result.ok) throw new Error(`${remoteDirPath}: ${result.error || 'Failed to list folder'}`);

  const files: RemoteWalkFile[] = [];
  const dirs: string[] = [];
  for (const entry of result.entries) {
    const fullPath = joinRemotePath(remoteDirPath, entry.name);
    const relativePath = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory) {
      dirs.push(relativePath);
      const nested = await walkRemoteDir(connectionId, fullPath, relativePath, depth + 1, list);
      files.push(...nested.files);
      dirs.push(...nested.dirs);
    } else {
      files.push({ remote: fullPath, rel: relativePath });
    }
  }
  return { files, dirs };
}
