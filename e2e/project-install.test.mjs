import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const prepareScript = resolve('scripts/prepare-project.mjs');

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function createFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'onee-product-install-'));
  const root = join(fixtureRoot, 'acme-product');
  const bin = join(fixtureRoot, 'bin');
  const npmLog = join(fixtureRoot, 'npm.log');

  await mkdir(join(root, 'apps/android'), { recursive: true });
  await mkdir(join(root, 'apps/ios'), { recursive: true });
  await mkdir(join(root, 'apps/web'), { recursive: true });
  await mkdir(join(root, 'packages/ui'), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, 'apps/android/.gitkeep'), '');
  await writeFile(join(root, 'apps/ios/.gitkeep'), '');
  await writeFile(npmLog, '');
  await writeExecutable(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >>"$NPM_LOG"
if [ "\${1:-}" = "install" ] && [ "\${2:-}" != "--ignore-scripts" ]; then
  "$NODE_BINARY" "$PREPARE_SCRIPT"
fi
`,
  );
  await writeJson(join(root, 'package.json'), {
    name: 'onee-product-template',
    description: 'A public GitHub template repository for npm-workspace TypeScript projects.',
    dependencies: {
      '@template/ui': 'workspace:*',
    },
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  });
  await writeJson(join(root, 'apps/web/package.json'), {
    dependencies: {
      '@template/ui': 'workspace:*',
    },
    name: '@template/web',
    private: true,
  });
  await writeJson(join(root, 'packages/ui/package.json'), {
    name: '@template/ui',
    private: true,
  });
  await writeJson(join(root, 'package-lock.json'), {
    name: 'onee-product-template',
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { '@template/ui': 'workspace:*' },
        name: 'onee-product-template',
      },
      'apps/web': {
        dependencies: { '@template/ui': 'workspace:*' },
        name: '@template/web',
      },
      'node_modules/@template/ui': { link: true, resolved: 'packages/ui' },
      'packages/ui': { name: '@template/ui' },
    },
  });
  await writeFile(
    join(root, 'README.md'),
    '# Onee Product Template\n\nThis repository is a public GitHub template.\n\n```text\nonee-product-template/\n```\n',
  );

  return { bin, fixtureRoot, npmLog, root };
}

function runInstall(fixture, environment = {}) {
  return spawnSync('npm', ['install'], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...environment,
      NODE_BINARY: process.execPath,
      NPM_LOG: fixture.npmLog,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      PREPARE_SCRIPT: prepareScript,
    },
  });
}

test('npm install initializes project identity across workspace metadata', async (t) => {
  const fixture = await createFixture();
  const { root } = fixture;
  t.after(() => rm(fixture.fixtureRoot, { force: true, recursive: true }));
  const result = runInstall(fixture, {
    ONEE_PROJECT_SCOPE: 'acme',
    ONEE_PROJECT_TITLE: 'Acme Product',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readJson(join(root, 'package.json'))).name, 'acme-product');
  assert.equal((await readJson(join(root, 'package.json'))).description, 'Acme Product workspace.');
  assert.deepEqual((await readJson(join(root, 'package.json'))).dependencies, {
    '@acme/ui': 'workspace:*',
  });
  assert.equal((await readJson(join(root, 'apps/web/package.json'))).name, '@acme/web');
  assert.deepEqual((await readJson(join(root, 'apps/web/package.json'))).dependencies, {
    '@acme/ui': 'workspace:*',
  });
  assert.equal((await readJson(join(root, 'packages/ui/package.json'))).name, '@acme/ui');
  assert.equal((await readJson(join(root, 'package-lock.json'))).name, 'acme-product');
  assert.equal(
    (await readJson(join(root, 'package-lock.json'))).packages['packages/ui'].name,
    '@acme/ui',
  );
  assert.deepEqual(
    (await readJson(join(root, 'package-lock.json'))).packages['apps/web'].dependencies,
    { '@acme/ui': 'workspace:*' },
  );
  assert.deepEqual(
    (await readJson(join(root, 'package-lock.json'))).packages['node_modules/@acme/ui'],
    { link: true, resolved: 'packages/ui' },
  );
  assert.equal(
    (await readJson(join(root, 'package-lock.json'))).packages['node_modules/@template/ui'],
    undefined,
  );
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /^# Acme Product/m);
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /acme-product\//);
  assert.equal(
    await readFile(fixture.npmLog, 'utf8'),
    'npm install\nnpm install --ignore-scripts\n',
  );
});

test('npm install initialization is idempotent', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.fixtureRoot, { force: true, recursive: true }));

  const first = runInstall(fixture);
  const second = runInstall(fixture);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await readFile(fixture.npmLog, 'utf8'),
    'npm install\nnpm install --ignore-scripts\nnpm install\n',
  );
});

test('npm install refuses custom workspace package names without partial writes', async (t) => {
  const fixture = await createFixture();
  const { root } = fixture;
  t.after(() => rm(fixture.fixtureRoot, { force: true, recursive: true }));
  const rootManifestBefore = await readFile(join(root, 'package.json'), 'utf8');
  await writeJson(join(root, 'packages/ui/package.json'), {
    name: '@custom/ui',
    private: true,
  });

  const result = runInstall(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace custom workspace package name/);
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), rootManifestBefore);
});
