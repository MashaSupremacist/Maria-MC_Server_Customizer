/**
 * make-portable-zip.mjs
 *
 * Zips the unpacked app (release/win-unpacked) into a portable ZIP named
 * "Minecraft Server Customizer-Portable-<version>.zip", matching the release
 * naming in the plan. Uses the system tar (Windows 10+ ships bsdtar) to avoid
 * the Compress-Archive CLI dependency in scripts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const releaseDir = path.join(root, 'release');
const unpackedDir = path.join(releaseDir, 'win-unpacked');

const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'),
);
const version = pkg.version;
const zipName = `Minecraft Server Customizer-Portable-${version}.zip`;
const zipPath = path.join(releaseDir, zipName);

if (!fs.existsSync(unpackedDir)) {
  console.error(`win-unpacked not found at ${unpackedDir}`);
  process.exit(1);
}

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

// Use bsdtar (Windows 10+ ships it as tar.exe) to create the zip.
const result = spawnSync(
  'tar',
  ['-a', '-c', '-f', zipPath, '-C', unpackedDir, '.'],
  { stdio: 'inherit' },
);
if (result.status !== 0) {
  console.error('Failed to create portable zip');
  process.exit(result.status ?? 1);
}

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`Portable ZIP: ${zipPath} (${sizeMb} MB)`);
