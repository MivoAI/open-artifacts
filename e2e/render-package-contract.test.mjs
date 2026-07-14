import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import test from 'node:test';

const packagesRoot = resolve('packages');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function resolveInside(packageRoot, localPath) {
  const resolved = resolve(packageRoot, localPath);
  assert.ok(
    resolved.startsWith(`${packageRoot}${sep}`),
    `${localPath} must resolve inside its Render Package`,
  );
  return resolved;
}

test('the repository ships two real, forkable Render Package adapters', async () => {
  const entries = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
  const packageDirectories = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('render-'),
  );

  assert.ok(packageDirectories.length >= 2, 'expected at least two real Render Package adapters');

  for (const directory of packageDirectories) {
    const packageRoot = resolve(packagesRoot, directory.name);
    const manifest = await readJson(resolve(packageRoot, 'package.json'));

    assert.equal(manifest.name.split('/').at(-1), directory.name);
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
});
