import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER_OWNERSHIP_MARKER = '.msc-owned-server.json';

interface OwnershipMarker {
  version: 1;
  folderPath: string;
  libraryRoot: string;
}

export interface DeletionPathPolicyInput {
  folderPath: string;
  libraryRoot: string | null;
  appDataRoot: string;
}

export interface DeletionPathDecision {
  allowed: boolean;
  canonicalPath: string;
  reason?: string;
}

/** Write an ownership capability only for a real child of the configured library. */
export function markOwnedServerFolder(folderPath: string, libraryRoot: string): void {
  const canonicalLibrary = canonicalizeExisting(libraryRoot);
  const canonicalFolder = canonicalizeExisting(folderPath);
  if (!isStrictChild(canonicalLibrary, canonicalFolder)) {
    throw new Error('Owned server folders must be children of the configured library');
  }
  const marker: OwnershipMarker = {
    version: 1,
    folderPath: canonicalFolder,
    libraryRoot: canonicalLibrary,
  };
  const markerPath = path.join(canonicalFolder, SERVER_OWNERSHIP_MARKER);
  const temporary = `${markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, markerPath);
}

export function hasValidOwnershipMarker(folderPath: string, libraryRoot: string | null): boolean {
  if (!libraryRoot || !fs.existsSync(folderPath) || !fs.existsSync(libraryRoot)) return false;
  try {
    const canonicalFolder = canonicalizeExisting(folderPath);
    const canonicalLibrary = canonicalizeExisting(libraryRoot);
    if (!isStrictChild(canonicalLibrary, canonicalFolder)) return false;
    const markerPath = path.join(canonicalFolder, SERVER_OWNERSHIP_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<OwnershipMarker>;
    return (
      marker.version === 1 &&
      samePath(marker.folderPath ?? '', canonicalFolder) &&
      samePath(marker.libraryRoot ?? '', canonicalLibrary)
    );
  } catch {
    return false;
  }
}

/** Resolve whether a recursive delete is confined to a marked app-owned folder. */
export function evaluateDeletionPath(input: DeletionPathPolicyInput): DeletionPathDecision {
  const canonicalPath = canonicalizeBestEffort(input.folderPath);
  const protectedPaths = [
    path.parse(canonicalPath).root,
    canonicalizeBestEffort(os.homedir()),
    canonicalizeBestEffort(input.appDataRoot),
    input.libraryRoot ? canonicalizeBestEffort(input.libraryRoot) : null,
  ].filter((value): value is string => Boolean(value));

  for (const protectedPath of protectedPaths) {
    if (samePath(canonicalPath, protectedPath) || isAncestor(canonicalPath, protectedPath)) {
      return { allowed: false, canonicalPath, reason: `Protected path cannot be deleted: ${canonicalPath}` };
    }
  }
  if (!input.libraryRoot) {
    return { allowed: false, canonicalPath, reason: 'No server library is configured' };
  }
  if (!hasValidOwnershipMarker(input.folderPath, input.libraryRoot)) {
    return {
      allowed: false,
      canonicalPath,
      reason: 'The folder is external or has no valid application ownership marker',
    };
  }
  try {
    assertNoReparsePoints(canonicalPath);
  } catch (error) {
    return {
      allowed: false,
      canonicalPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { allowed: true, canonicalPath };
}

function assertNoReparsePoints(root: string): void {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Server path is not a regular directory');
  }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Server folder contains a symbolic link or junction: ${entry.name}`);
      }
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
}

function canonicalizeExisting(value: string): string {
  return path.resolve(fs.realpathSync.native(path.resolve(value)));
}

function canonicalizeBestEffort(value: string): string {
  try {
    return canonicalizeExisting(value);
  } catch {
    return path.resolve(value);
  }
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isAncestor(candidate: string, protectedPath: string): boolean {
  return isStrictChild(candidate, protectedPath);
}
