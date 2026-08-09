/**
 * Build a fresh, deterministic production dependency tree for the bundled
 * backend. Package resolution follows each package's actual node_modules
 * ancestry, so nested version conflicts remain nested instead of being
 * flattened accidentally.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const backendDir = path.join(root, 'apps', 'desktop', 'backend');
const destination = path.join(backendDir, 'node_modules');
const nonce = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const staging = path.join(backendDir, `.node_modules.staging-${nonce}`);
const previous = path.join(backendDir, `.node_modules.previous-${nonce}`);
const rootManifest = readJson(path.join(root, 'package-lock.json'));
const backendManifest = readJson(path.join(backendDir, 'package.json'));
const packageTargets = new Map([[root, staging]]);
const copiedTargets = new Set();
const inventory = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInstalledPackage(name, issuerDirectory) {
  let cursor = issuerDirectory;
  while (isWithin(cursor, root)) {
    const candidate = path.join(cursor, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return { packageDirectory: candidate, installBase: cursor };
    }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  throw new Error(`Missing production dependency ${name} required by ${issuerDirectory}`);
}

function shouldCopy(source, packageDirectory) {
  const relative = path.relative(packageDirectory, source);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts.includes('node_modules')) return false;
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => [
    '.github', '.vscode', 'coverage', 'test', 'tests', '__tests__',
    'example', 'examples', 'benchmark', 'benchmarks', 'spec', 'fixture', 'fixtures',
  ].includes(part))) return false;
  const lower = relative.toLowerCase();
  if (lower.endsWith('.map') || lower.endsWith('.d.ts')) return false;
  return true;
}

function pruneNativePackage(name, target) {
  if (name !== 'better-sqlite3') return;
  for (const removable of ['binding.gyp', 'deps', 'src']) {
    fs.rmSync(path.join(target, removable), { recursive: true, force: true });
  }
  const prebuilds = path.join(target, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry !== 'win32-x64.node') {
        fs.rmSync(path.join(prebuilds, entry), { force: true });
      }
    }
  }
  if (!fs.existsSync(path.join(prebuilds, 'win32-x64.node'))) {
    throw new Error('better-sqlite3 win32-x64 native prebuild is missing');
  }
}

function copyPackage(name, issuerSource, issuerTarget) {
  const { packageDirectory, installBase } = resolveInstalledPackage(name, issuerSource);
  const targetBase = installBase === issuerSource
    ? (issuerSource === root ? issuerTarget : path.join(issuerTarget, 'node_modules'))
    : packageTargets.get(installBase);
  if (!targetBase) {
    throw new Error(`Cannot map dependency install base ${installBase}`);
  }
  const target = path.join(targetBase, name);
  const targetKey = path.normalize(target).toLowerCase();
  if (copiedTargets.has(targetKey)) return;
  copiedTargets.add(targetKey);
  packageTargets.set(packageDirectory, target);

  const manifest = readJson(path.join(packageDirectory, 'package.json'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(packageDirectory, target, {
    recursive: true,
    filter: (source) => shouldCopy(source, packageDirectory),
  });
  pruneNativePackage(name, target);
  inventory.push({ name: manifest.name, version: manifest.version, path: path.relative(staging, target).replaceAll('\\', '/') });

  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    copyPackage(dependency, packageDirectory, target);
  }
}

fs.mkdirSync(staging, { recursive: false });
try {
  for (const dependency of Object.keys(backendManifest.dependencies ?? {}).sort()) {
    if (dependency === '@msc/shared-types') continue;
    copyPackage(dependency, root, staging);
  }

  inventory.sort((a, b) => a.path.localeCompare(b.path));
  fs.writeFileSync(
    path.join(staging, '.msc-dependency-inventory.json'),
    `${JSON.stringify({ lockfileVersion: rootManifest.lockfileVersion, packages: inventory }, null, 2)}\n`,
    'utf8',
  );

  if (fs.existsSync(destination)) fs.renameSync(destination, previous);
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    if (fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
  console.log(`Backend production dependencies staged atomically (${inventory.length} package locations)`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
