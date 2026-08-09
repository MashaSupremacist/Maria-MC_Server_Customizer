import fs from 'node:fs';

const tag = process.argv[2] ?? '';
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Release tag must be v<semver>; received ${tag || '(empty)'}`);
}

const expectedVersion = tag.replace(/^v/, '');

const manifests = [
  'package.json',
  'apps/desktop/package.json',
  'apps/desktop/backend/package.json',
  'packages/shared-types/package.json',
  'package-lock.json',
];

for (const manifest of manifests) {
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (parsed.version !== expectedVersion) {
    throw new Error(`${manifest} version ${String(parsed.version)} does not match tag ${expectedVersion}`);
  }
}

console.log(`Release versions match ${tag}`);
