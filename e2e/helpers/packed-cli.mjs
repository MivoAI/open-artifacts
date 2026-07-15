import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repositoryRoot, runProcess } from './cli.mjs';
import { createControlledRegistry } from './npm-registry.mjs';

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

export async function createPackedCliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-packed-cli-'));
  const home = join(root, 'home');
  const installRoot = join(root, 'install');
  const packRoot = join(root, 'pack');
  const npmCache = join(root, 'empty-npm-cache');
  let registry;

  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(installRoot, { recursive: true }),
      mkdir(packRoot, { recursive: true }),
    ]);
    await writeFile(
      join(installRoot, 'package.json'),
      '{"name":"packed-cli-consumer","private":true,"version":"0.0.0"}\n',
    );
    registry = await createControlledRegistry({
      mirrorPackageRoots: cliProductionDependencyRoots(),
    });

    const packed = spawnSync(
      'npm',
      ['pack', '--workspace', '@open-artifacts/cli', '--json', '--pack-destination', packRoot],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const packResult = JSON.parse(packed.stdout)[0];
    const tarball = join(packRoot, packResult.filename);
    const env = {
      npm_config_cache: npmCache,
      npm_config_registry: `${registry.origin}/`,
      npm_config_userconfig: join(home, '.npmrc'),
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_REGISTRY: `${registry.origin}/`,
      NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
    };
    const installed = await runProcess(
      'npm',
      ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: installRoot, env, home, timeout: 60_000 },
    );
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    const oa = join(installRoot, 'node_modules', '.bin', 'oa');
    return {
      cwd: installRoot,
      dispose: async () => {
        try {
          await registry.close();
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      },
      env,
      home,
      installRoot,
      oa,
      packResult,
      registry,
      runOa(arguments_, options = {}) {
        return runProcess(oa, arguments_, {
          cwd: options.cwd ?? installRoot,
          env: { ...env, ...options.env },
          home: options.home ?? home,
          timeout: options.timeout ?? 60_000,
        });
      },
    };
  } catch (error) {
    try {
      if (registry) await registry.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
    throw error;
  }
}
