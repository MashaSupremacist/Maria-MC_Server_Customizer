/**
 * make-portable-zip.mjs
 *
 * Zips the unpacked app (release/win-unpacked) into a portable ZIP named
 * "Minecraft.Server.Customizer-Portable-<version>.zip", matching the release
 * naming in the plan. On Windows it uses the shell's native ZIP writer so the
 * archive opens in File Explorer as well as third-party extractors.
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
const zipName = `Minecraft.Server.Customizer-Portable-${version}.zip`;
const zipPath = path.join(releaseDir, zipName);

if (!fs.existsSync(unpackedDir)) {
  console.error(`win-unpacked not found at ${unpackedDir}`);
  process.exit(1);
}

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

const result = process.platform === 'win32'
  ? createWindowsExplorerZip(unpackedDir, zipPath)
  : spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', unpackedDir, '.'], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('Failed to create portable zip');
  process.exit(result.status ?? 1);
}

const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
console.log(`Portable ZIP: ${zipPath} (${sizeMb} MB)`);

/**
 * `tar -a` produces a standards-compliant ZIP, but Explorer can reject its
 * archive layout on some Windows builds. Compress-Archive produces the ZIP
 * dialect Explorer itself consumes. Use environment variables for paths so a
 * custom install directory cannot be interpreted as PowerShell source code.
 */
function createWindowsExplorerZip(sourceDir, destinationPath) {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$source = $env:MSC_PORTABLE_ZIP_SOURCE',
    '$destination = $env:MSC_PORTABLE_ZIP_DESTINATION',
    '$items = @(Get-ChildItem -LiteralPath $source -Force)',
    "if ($items.Count -eq 0) { throw 'Portable app directory is empty' }",
    'Compress-Archive -LiteralPath $items.FullName -DestinationPath $destination -CompressionLevel Optimal -Force',
  ].join('; ');
  return spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        MSC_PORTABLE_ZIP_SOURCE: sourceDir,
        MSC_PORTABLE_ZIP_DESTINATION: destinationPath,
      },
    },
  );
}
