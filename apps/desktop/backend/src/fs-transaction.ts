import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FilesystemTransactionOptions {
  signal?: AbortSignal;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export class FilesystemTransactionCanceledError extends Error {
  constructor() {
    super('Filesystem transaction canceled before commit');
    this.name = 'FilesystemTransactionCanceledError';
  }
}

export function siblingTransactionPath(targetPath: string, label: 'staging' | 'rollback'): string {
  const parent = path.dirname(path.resolve(targetPath));
  const name = path.basename(targetPath);
  return path.join(parent, `.${name}.${label}-${crypto.randomUUID()}`);
}

/**
 * Prepare and validate a replacement beside its target, then swap it into
 * place. If the second rename fails, the prior target is restored.
 */
export async function replaceDirectoryAtomically(
  targetPath: string,
  prepare: (stagingPath: string) => Promise<void>,
  validate: (stagingPath: string) => Promise<void> | void,
  options: FilesystemTransactionOptions = {},
): Promise<void> {
  const target = path.resolve(targetPath);
  const staging = siblingTransactionPath(target, 'staging');
  const rollback = siblingTransactionPath(target, 'rollback');
  const rename = options.rename ?? fs.promises.rename;
  let movedTarget = false;
  let committed = false;

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.mkdir(staging, { recursive: true });

  try {
    await prepare(staging);
    await validate(staging);
    if (options.signal?.aborted) throw new FilesystemTransactionCanceledError();

    if (await pathExists(target)) {
      await rename(target, rollback);
      movedTarget = true;
    }

    try {
      await rename(staging, target);
      committed = true;
    } catch (error) {
      if (movedTarget && !(await pathExists(target)) && (await pathExists(rollback))) {
        await rename(rollback, target);
        movedTarget = false;
      }
      throw error;
    }

    if (movedTarget) {
      await fs.promises.rm(rollback, { recursive: true, force: true });
      movedTarget = false;
    }
  } finally {
    if (!committed) {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    if (movedTarget && !(await pathExists(target)) && (await pathExists(rollback))) {
      await rename(rollback, target);
      movedTarget = false;
    }
    if (!movedTarget) {
      await fs.promises.rm(rollback, { recursive: true, force: true });
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
