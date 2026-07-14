import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';

const packagesRoot = resolve('packages');
const expectedPackages = [
  {
    directory: 'artifact-decision-board',
    name: '@open-artifacts/decision-board',
  },
  {
    directory: 'artifact-evidence-trace',
    name: '@open-artifacts/evidence-trace',
  },
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function resolveInside(packageRoot, localPath) {
  const resolved = resolve(packageRoot, localPath);
  assert.ok(
    resolved.startsWith(`${packageRoot}${sep}`),
    `${localPath} must resolve inside its Artifact Package`,
  );
  return resolved;
}

test('the repository ships the canonical forkable Artifact Packages', async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const packageDirectories = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('artifact-'),
  );
  const discoveredDirectories = packageDirectories.map((entry) => entry.name);

  for (const expectedPackage of expectedPackages) {
    assert.ok(discoveredDirectories.includes(expectedPackage.directory));
  }

  for (const directory of packageDirectories) {
    const packageRoot = resolve(packagesRoot, directory.name);
    const manifest = await readJson(resolve(packageRoot, 'package.json'));

    assert.equal(manifest.name, `@open-artifacts/${directory.name.slice('artifact-'.length)}`);
    assert.equal(manifest.openArtifacts?.format, 'react-render/v0');
    assert.equal(manifest.exports?.['.'], './src/index.tsx');
    assert.equal(manifest.exports?.['./schema'], './input.schema.json');
    assert.equal(manifest.exports?.['./example'], './example.json');
    assert.equal(manifest.exports?.['./package.json'], './package.json');
    assert.ok(manifest.files?.includes('src'));
    assert.ok(manifest.files?.includes('input.schema.json'));
    assert.ok(manifest.files?.includes('example.json'));
    assert.ok(manifest.files?.includes('tsconfig.json'));
    assert.ok(manifest.peerDependencies?.react);
    assert.equal(manifest.dependencies?.react, undefined);

    const sourceEntry = resolveInside(packageRoot, manifest.exports['.']);
    const schemaEntry = resolveInside(packageRoot, manifest.exports['./schema']);
    const exampleEntry = resolveInside(packageRoot, manifest.exports['./example']);

    await Promise.all([access(sourceEntry), access(schemaEntry), access(exampleEntry)]);
    assert.equal(
      (await readJson(schemaEntry)).$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    const example = await readJson(exampleEntry);
    assert.doesNotThrow(() => JSON.stringify(example));
  }

  for (const expectedPackage of expectedPackages) {
    const manifest = await readJson(
      resolve(packagesRoot, expectedPackage.directory, 'package.json'),
    );
    assert.equal(manifest.name, expectedPackage.name);
  }
});
