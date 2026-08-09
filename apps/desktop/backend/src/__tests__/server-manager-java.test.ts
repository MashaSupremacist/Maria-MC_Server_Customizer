import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRecord, StartServerError } from '@msc/shared-types';
import type { DatabaseResult } from '../db';
import { ServerManagerService } from '../server-manager';

describe('ServerManagerService Java fallback', () => {
  let tempDir = '';

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function setup(javaPath: string | null): {
    record: ServerRecord;
    db: DatabaseResult;
  } {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-server-java-'));
    fs.writeFileSync(path.join(tempDir, 'server.jar'), 'fixture');
    const record: ServerRecord = {
      id: 'server-1',
      name: 'Server',
      edition: 'java',
      serverType: 'vanilla',
      folderPath: tempDir,
      javaPath,
      memoryMb: 1024,
      port: 25565,
      version: '1.20.4',
      jvmArgs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      folderExists: true,
      canonicalFolderPath: tempDir,
      folderOwned: false,
    };
    const db = {
      getServer: vi.fn(() => record),
      updateServer: vi.fn((_id: string, update: { javaPath?: string | null }) => {
        if ('javaPath' in update) record.javaPath = update.javaPath ?? null;
        return record;
      }),
    } as unknown as DatabaseResult;
    return { record, db };
  }

  it('resolves by Minecraft version, persists the compatible runtime, and validates it', async () => {
    const { record, db } = setup(null);
    const resolveJava = vi.fn(async () => 'C:\\runtimes\\java-17\\bin\\java.exe');
    const validationError: StartServerError = {
      code: 'incompatible-java',
      message: 'validation stopped launch',
    };
    const validateJava = vi.fn(async () => validationError);
    const manager = new ServerManagerService(db, () => undefined, validateJava, resolveJava);

    await expect(manager.start(record.id)).resolves.toEqual(validationError);
    expect(resolveJava).toHaveBeenCalledWith('1.20.4');
    expect(db.updateServer).toHaveBeenCalledWith(record.id, {
      javaPath: 'C:\\runtimes\\java-17\\bin\\java.exe',
    });
    expect(validateJava).toHaveBeenCalledWith(
      '1.20.4',
      'C:\\runtimes\\java-17\\bin\\java.exe',
    );
  });

  it('returns a structured missing-java error when no compatible runtime exists', async () => {
    const { record, db } = setup(null);
    const resolveJava = vi.fn(async () => null);
    const manager = new ServerManagerService(db, () => undefined, null, resolveJava);

    await expect(manager.start(record.id)).resolves.toEqual({
      code: 'missing-java',
      message: 'No Java executable configured for this server',
    });
    expect(resolveJava).toHaveBeenCalledWith('1.20.4');
  });

  it('does not replace an explicit Java path and surfaces validation failure', async () => {
    const { record, db } = setup('C:\\configured\\java.exe');
    const resolveJava = vi.fn(async () => 'C:\\other\\java.exe');
    const validationError: StartServerError = {
      code: 'incompatible-java',
      message: 'Configured Java is invalid for Minecraft 1.20.4',
    };
    const validateJava = vi.fn(async () => validationError);
    const manager = new ServerManagerService(db, () => undefined, validateJava, resolveJava);

    await expect(manager.start(record.id)).resolves.toEqual(validationError);
    expect(resolveJava).not.toHaveBeenCalled();
    expect(validateJava).toHaveBeenCalledWith('1.20.4', 'C:\\configured\\java.exe');
  });
});
