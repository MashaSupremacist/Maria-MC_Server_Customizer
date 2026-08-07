/**
 * prepare-backend-deps.mjs
 *
 * Stages the backend's production dependencies (and their transitive deps)
 * into apps/desktop/backend/node_modules so electron-builder can ship a
 * self-contained backend alongside the app.
 *
 * npm hoists most deps to the workspace root node_modules; some may sit in
 * nested node_modules. This walks the full dependency graph and copies each
 * package's runtime files, preserving nested node_modules where needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = path.resolve(dirname, '..');
const backendDir = path.resolve(root, 'apps/desktop/backend');
const dest = path.join(backendDir, 'node_modules');

const backendPkg = JSON.parse(
  fs.readFileSync(path.join(backendDir, 'package.json'), 'utf8'),
);

const roots = { ...(backendPkg.dependencies ?? {}) };
delete roots['@msc/shared-types']; // type-only at runtime; never required

if (fs.existsSync(dest)) {
  try {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (err) {
    // A running development backend can hold native modules open on Windows.
    // Refreshing every dependency in place is safe and avoids leaving a
    // partially deleted staging tree; stale files only make the package larger.
    console.warn(
      `Could not fully clear ${dest}; refreshing staged dependencies in place (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
fs.mkdirSync(dest, { recursive: true });

/** Resolve a package's real directory from the root node_modules. */
function resolvePkg(name) {
  // require.resolve honors the "exports" map, which blocks deep imports like
  // "<pkg>/package.json" for some packages. Fall back to a direct lookup.
  try {
    const resolved = require.resolve(`${name}/package.json`, {
      paths: [path.join(root, 'node_modules')],
    });
    return path.dirname(resolved);
  } catch {
    const direct = path.join(root, 'node_modules', name);
    if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
    return null;
  }
}

const copied = new Set();
const missing = [];

/** Copy a package and its production deps into dest (once each). */
function copyPackage(name) {
  const pkgDir = resolvePkg(name);
  if (!pkgDir) {
    missing.push(name);
    return;
  }
  if (copied.has(pkgDir)) return;
  copied.add(pkgDir);

  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
  );

  const target = path.join(dest, name);
  fs.cpSync(pkgDir, target, {
    recursive: true,
    // Do not carry another copy of node_modules; nested deps are staged
    // explicitly below.
    filter: (src) => path.basename(src) !== 'node_modules',
  });
  console.log(`  copied ${name}`);

  // Recurse into production deps (nested node_modules may hold them too).
  const deps = { ...(pkgJson.dependencies ?? {}) };
  for (const depName of Object.keys(deps)) {
    const nestedPath = path.join(pkgDir, 'node_modules', depName);
    if (fs.existsSync(nestedPath)) {
      // Package ships its own nested dep (e.g. @fastify/websocket).
      copyPackage(depName);
    } else {
      copyPackage(depName);
    }
  }
}

for (const name of Object.keys(roots)) {
  copyPackage(name);
}

if (missing.length) {
  console.error('Missing production deps:', [...new Set(missing)].join(', '));
  process.exit(1);
}
console.log(`Backend production deps staged in ${dest} (${copied.size} packages)`);
