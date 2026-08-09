import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateDeletionPath,
  hasValidOwnershipMarker,
  markOwnedServerFolder,
} from '../path-policy';

describe('server deletion path policy', () => {
  let root: string;
  let appData: string;
  let library: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'msc-path-policy-'));
    appData = path.join(root, 'app-data');
    library = path.join(root, 'library');
    fs.mkdirSync(appData);
    fs.mkdirSync(library);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('permits a marked owned child folder', () => {
    const folder = path.join(library, 'owned');
    fs.mkdirSync(folder);
    markOwnedServerFolder(folder, library);
    expect(hasValidOwnershipMarker(folder, library)).toBe(true);
    expect(evaluateDeletionPath({ folderPath: folder, libraryRoot: library, appDataRoot: appData })).toMatchObject({ allowed: true });
  });

  it('rejects filesystem, home, app-data, and library roots', () => {
    for (const folderPath of [path.parse(root).root, os.homedir(), appData, library]) {
      expect(evaluateDeletionPath({ folderPath, libraryRoot: library, appDataRoot: appData }).allowed).toBe(false);
    }
  });

  it('rejects an external folder without an ownership marker', () => {
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    const result = evaluateDeletionPath({ folderPath: external, libraryRoot: library, appDataRoot: appData });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/external|ownership marker/i);
  });

  it('rejects a copied or forged marker for another folder', () => {
    const owned = path.join(library, 'owned');
    const forged = path.join(library, 'forged');
    fs.mkdirSync(owned);
    fs.mkdirSync(forged);
    markOwnedServerFolder(owned, library);
    fs.copyFileSync(path.join(owned, '.msc-owned-server.json'), path.join(forged, '.msc-owned-server.json'));
    expect(hasValidOwnershipMarker(forged, library)).toBe(false);
  });

  it('rejects a symlink or junction escape when supported', () => {
    const owned = path.join(library, 'owned');
    const external = path.join(root, 'external');
    fs.mkdirSync(owned);
    fs.mkdirSync(external);
    markOwnedServerFolder(owned, library);
    try {
      fs.symlinkSync(external, path.join(owned, 'escape'), 'junction');
    } catch {
      return;
    }
    expect(evaluateDeletionPath({ folderPath: owned, libraryRoot: library, appDataRoot: appData }).allowed).toBe(false);
  });
});
