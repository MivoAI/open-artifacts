import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildCli, repositoryRoot, runProcess, stopSession } from './helpers/cli.mjs';
import { createControlledRegistry } from './helpers/npm-registry.mjs';

test.before(buildCli);

test('the packed CLI installs oa with its private runtime and starts an npm Artifact Session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-packed-cli-'));
  const home = join(root, 'home');
  const installRoot = join(root, 'install');
  const packRoot = join(root, 'pack');
  const registry = await createControlledRegistry();
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
  assert.ok(filePaths.includes('dist/cli/index.js'));
  assert.ok(filePaths.includes('dist/runtime/index.js'));
  assert.ok(filePaths.includes('dist/runtime/config.js'));
  const tarball = join(packRoot, packResult.filename);

  const installed = spawnSync(
    'npm',
    ['install', tarball, '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: installRoot, encoding: 'utf8' },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const oa = join(installRoot, 'node_modules', '.bin', 'oa');
  const result = await runProcess(
    oa,
    ['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open'],
    {
      cwd: installRoot,
      home,
      env: {
        NPM_CONFIG_REGISTRY: `${registry.origin}/`,
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
