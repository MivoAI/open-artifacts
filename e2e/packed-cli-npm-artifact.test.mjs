import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildCli, repositoryRoot, runProcess, stopSession } from './helpers/cli.mjs';
import { createControlledRegistry } from './helpers/npm-registry.mjs';

function cliProductionDependencyRoots() {
  const result = spawnSync(
    'npm',
    ['ls', '--workspace', '@open-artifacts/cli', '--all', '--parseable', '--omit=dev'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout
    .trim()
    .split('\n')
    .filter(
      (packageRoot) =>
        packageRoot !== repositoryRoot &&
        !packageRoot.endsWith('/node_modules/@open-artifacts/cli'),
    );
}

test.before(buildCli);

test('the packed CLI installs oa with its private runtime and starts an npm Artifact Session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-packed-cli-'));
  const home = join(root, 'home');
  const installRoot = join(root, 'install');
  const packRoot = join(root, 'pack');
  const registry = await createControlledRegistry({
    mirrorPackageRoots: cliProductionDependencyRoots(),
  });
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await registry.close();
    await rm(root, { force: true, recursive: true });
  });
  await Promise.all([
    import('node:fs/promises').then(({ mkdir }) => mkdir(home, { recursive: true })),
    import('node:fs/promises').then(({ mkdir }) => mkdir(installRoot, { recursive: true })),
    import('node:fs/promises').then(({ mkdir }) => mkdir(packRoot, { recursive: true })),
  ]);
  await writeFile(
    join(installRoot, 'package.json'),
    '{"name":"packed-cli-consumer","private":true,"version":"0.0.0"}\n',
  );

  const packed = spawnSync(
    'npm',
    ['pack', '--workspace', '@open-artifacts/cli', '--json', '--pack-destination', packRoot],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packResult = JSON.parse(packed.stdout)[0];
  const filePaths = packResult.files.map(({ path }) => path);
  assert.deepEqual(filePaths, [
    'dist/cli/artifact-input.d.ts',
    'dist/cli/artifact-input.d.ts.map',
    'dist/cli/artifact-input.js',
    'dist/cli/artifact-package.d.ts',
    'dist/cli/artifact-package.d.ts.map',
    'dist/cli/artifact-package.js',
    'dist/cli/errors.d.ts',
    'dist/cli/errors.d.ts.map',
    'dist/cli/errors.js',
    'dist/cli/index.d.ts',
    'dist/cli/index.d.ts.map',
    'dist/cli/index.js',
    'dist/cli/npm-artifact.d.ts',
    'dist/cli/npm-artifact.d.ts.map',
    'dist/cli/npm-artifact.js',
    'dist/cli/run.d.ts',
    'dist/cli/run.d.ts.map',
    'dist/cli/run.js',
    'dist/cli/session.d.ts',
    'dist/cli/session.d.ts.map',
    'dist/cli/session.js',
    'dist/runtime/artifact-input.d.ts',
    'dist/runtime/artifact-input.d.ts.map',
    'dist/runtime/artifact-input.js',
    'dist/runtime/config.d.ts',
    'dist/runtime/config.d.ts.map',
    'dist/runtime/config.js',
    'dist/runtime/index.d.ts',
    'dist/runtime/index.d.ts.map',
    'dist/runtime/index.js',
    'dist/runtime/react.d.ts',
    'dist/runtime/react.d.ts.map',
    'dist/runtime/react.js',
    'package.json',
  ]);
  const tarball = join(packRoot, packResult.filename);

  const npmCache = join(root, 'empty-npm-cache');
  const installed = await runProcess(
    'npm',
    [
      'install',
      tarball,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      `${registry.origin}/`,
    ],
    {
      cwd: installRoot,
      home,
      env: {
        npm_config_cache: npmCache,
        npm_config_userconfig: join(home, '.npmrc'),
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      },
      timeout: 60_000,
    },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.ok(registry.count('/ajv') > 0);
  const oa = join(installRoot, 'node_modules', '.bin', 'oa');
  const result = await runProcess(
    oa,
    ['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open'],
    {
      cwd: installRoot,
      home,
      env: {
        npm_config_cache: npmCache,
        npm_config_registry: `${registry.origin}/`,
        npm_config_userconfig: join(home, '.npmrc'),
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_REGISTRY: `${registry.origin}/`,
        NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      },
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  assert.equal(session.artifact.name, 'oa-registry-artifact');
  assert.equal(session.artifact.version, '1.0.0');
  assert.equal((await globalThis.fetch(`${session.url}__oa/health`)).status, 200);
});
