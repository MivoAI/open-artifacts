import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { buildCli, repositoryRoot, runBuiltCliAsync, stopSession } from './helpers/cli.mjs';
import { createControlledRegistry } from './helpers/npm-registry.mjs';

function runCli(arguments_, options) {
  const npmCache = join(options.home, '.npm');
  const npmUserConfig = join(options.home, '.npmrc');
  return runBuiltCliAsync(arguments_, {
    ...options,
    env: {
      npm_config_cache: npmCache,
      npm_config_registry: options.registry,
      npm_config_userconfig: npmUserConfig,
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_REGISTRY: options.registry,
      NPM_CONFIG_USERCONFIG: npmUserConfig,
      OA_DEPENDENCY_SCRIPT_MARKER: options.dependencyScriptMarker,
      OA_SCRIPT_MARKER: options.scriptMarker,
    },
    timeout: 60_000,
  });
}

async function cacheEntries(home) {
  return readdir(join(home, '.open-artifacts', 'cache', 'artifacts')).then(
    (entries) => entries.filter((entry) => !entry.startsWith('.')).sort(),
    (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
}

async function assertNoCacheTemporaries(home) {
  const entries = await readdir(join(home, '.open-artifacts', 'cache', 'artifacts'));
  assert.deepEqual(
    entries.filter((entry) => /^\.(?:resolve|staging|commit)-|\.lock$|\.stale-/.test(entry)),
    [],
  );
}

async function readTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? readTree(path) : readFile(path);
    }),
  ).then((contents) => contents.flat(Infinity).join('\n'));
}

async function sessionEntries(home) {
  return readdir(join(home, '.open-artifacts', 'sessions')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

function cliEnvironment(home, registry) {
  return {
    dependencyScriptMarker: join(home, 'dependency-install-ran'),
    home,
    registry: `${registry.origin}/`,
    scriptMarker: join(home, 'artifact-install-ran'),
  };
}

test.before(buildCli);

test('oa resolves registry specifiers into immutable script-free Artifact cache entries', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-npm-home-'));
  const registry = await createControlledRegistry();
  const environment = cliEnvironment(home, registry);
  const sessions = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((sessionId) => stopSession(home, sessionId)));
    await registry.close();
    await rm(home, { force: true, recursive: true });
  });

  const cases = [
    ['oa-registry-artifact', '1.1.0'],
    ['oa-registry-artifact@stable', '1.1.0'],
    ['oa-registry-artifact@^1.0.0', '1.1.0'],
    ['oa-registry-artifact@1.0.0', '1.0.0'],
  ];

  for (const [reference, expectedVersion] of cases) {
    const result = await runCli(['run', reference, '--json', '--no-open'], environment);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const session = JSON.parse(result.stdout);
    sessions.push(session.sessionId);
    assert.equal(session.artifact.name, 'oa-registry-artifact');
    assert.equal(session.artifact.version, expectedVersion);
    assert.match(session.artifact.root, /\.open-artifacts\/cache\/artifacts\//);
    assert.equal((await globalThis.fetch(`${session.url}__oa/preflight`)).status, 200);
    await stopSession(home, session.sessionId);
    sessions.pop();
  }

  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.1.0.tgz'), 1);
  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.0.0.tgz'), 1);
  assert.equal(registry.count('/tarballs/oa-registry-helper-1.0.0.tgz'), 1);
  assert.equal(registry.count('/tarballs/oa-registry-peer-1.0.0.tgz'), 1);
  await assert.rejects(access(environment.scriptMarker), { code: 'ENOENT' });
  await assert.rejects(access(environment.dependencyScriptMarker), { code: 'ENOENT' });

  const cached = await cacheEntries(home);
  assert.equal(cached.length, 2);
  let latestEntry;
  for (const entry of cached) {
    const provenance = JSON.parse(
      await readFile(
        join(
          home,
          '.open-artifacts',
          'cache',
          'artifacts',
          entry,
          'open-artifacts-provenance.json',
        ),
        'utf8',
      ),
    );
    assert.equal(provenance.name, 'oa-registry-artifact');
    assert.match(provenance.version, /^1\.[01]\.0$/);
    assert.equal(provenance.registry, `${registry.origin}/`);
    assert.doesNotMatch(JSON.stringify(provenance), /token|password/i);
    if (provenance.version === '1.1.0') latestEntry = entry;
  }

  assert.ok(latestEntry);
  const active = await runCli(
    ['run', 'oa-registry-artifact@stable', '--json', '--no-open'],
    environment,
  );
  assert.equal(active.status, 0, active.stderr || active.stdout);
  const activeSession = JSON.parse(active.stdout);
  sessions.push(activeSession.sessionId);
  assert.equal((await globalThis.fetch(`${activeSession.url}__oa/preflight`)).status, 200);

  const tamperedExample = join(
    home,
    '.open-artifacts',
    'cache',
    'artifacts',
    latestEntry,
    'node_modules',
    'oa-registry-artifact',
    'example.json',
  );
  await writeFile(tamperedExample, '{"message":"tampered but contract-valid"}\n');
  const invalidCacheHit = await runCli(
    ['run', 'oa-registry-artifact@stable', '--json', '--no-open'],
    environment,
  );
  assert.equal(invalidCacheHit.status, 0, invalidCacheHit.stderr || invalidCacheHit.stdout);
  const repairedSession = JSON.parse(invalidCacheHit.stdout);
  sessions.push(repairedSession.sessionId);
  assert.notEqual(repairedSession.artifact.root, activeSession.artifact.root);
  assert.deepEqual(JSON.parse(await readFile(tamperedExample, 'utf8')), {
    message: 'tampered but contract-valid',
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(repairedSession.artifact.root, 'example.json'), 'utf8')),
    {
      message: 'version 1.1.0',
    },
  );
  await access(activeSession.artifact.root);
  assert.equal((await globalThis.fetch(`${activeSession.url}__oa/preflight`)).status, 200);
  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.1.0.tgz'), 1);

  const repairedCacheHit = await runCli(
    ['run', 'oa-registry-artifact@stable', '--json', '--no-open'],
    environment,
  );
  assert.equal(repairedCacheHit.status, 0, repairedCacheHit.stderr || repairedCacheHit.stdout);
  const reusedSession = JSON.parse(repairedCacheHit.stdout);
  sessions.push(reusedSession.sessionId);
  assert.equal(reusedSession.artifact.root, repairedSession.artifact.root);
  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.1.0.tgz'), 1);

  await stopSession(home, reusedSession.sessionId);
  sessions.pop();
  await stopSession(home, repairedSession.sessionId);
  sessions.pop();
  await stopSession(home, activeSession.sessionId);
  sessions.pop();
  assert.deepEqual(await sessionEntries(home), []);

  const beforeInvalid = await cacheEntries(home);
  const invalid = await runCli(
    ['run', 'oa-invalid-artifact@1.0.0', '--json', '--no-open'],
    environment,
  );
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.equal(JSON.parse(invalid.stderr).error.code, 'ARTIFACT_PACKAGE_CONTRACT_INVALID');
  assert.deepEqual(await cacheEntries(home), beforeInvalid);
  assert.deepEqual(await sessionEntries(home), []);

  const unsupported = await runCli(
    ['run', 'https://user:secret@example.test/artifact.tgz', '--json', '--no-open'],
    environment,
  );
  assert.equal(unsupported.status, 1);
  assert.equal(JSON.parse(unsupported.stderr).error.code, 'ARTIFACT_REFERENCE_INVALID');
  assert.doesNotMatch(unsupported.stderr, /user|secret|example\.test/);

  const local = await runCli(
    ['run', resolve(repositoryRoot, 'packages/artifact-decision-board'), '--json', '--no-open'],
    environment,
  );
  assert.equal(local.status, 0, local.stderr || local.stdout);
  const localSession = JSON.parse(local.stdout);
  sessions.push(localSession.sessionId);
  assert.deepEqual(await cacheEntries(home), beforeInvalid);
  await stopSession(home, localSession.sessionId);
  sessions.pop();
  assert.deepEqual(await cacheEntries(home), beforeInvalid);
});

test('oa inherits project npm config without persisting registry credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-project-npmrc-'));
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  const globalConfig = join(root, 'global.npmrc');
  const registry = await createControlledRegistry();
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await registry.close();
    await rm(root, { force: true, recursive: true });
  });
  await Promise.all([mkdir(home, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  await Promise.all([
    writeFile(join(home, '.npmrc'), 'fund=false\n'),
    writeFile(globalConfig, `registry=${registry.origin}/\n`),
    writeFile(
      join(projectRoot, '.npmrc'),
      `@oa-fixture:registry=${registry.origin}/\nlegacy-peer-deps=true\nlockfile-version=1\nworkspaces=true\nworkspace=missing\n//127.0.0.1:${new URL(registry.origin).port}/:_authToken=fixture-token-secret\n`,
    ),
    writeFile(
      join(projectRoot, 'package.json'),
      '{"name":"project-npmrc-fixture","private":true,"version":"0.0.0"}\n',
    ),
  ]);

  const result = await runBuiltCliAsync(
    ['run', '@oa-fixture/private-artifact@1.0.0', '--json', '--no-open'],
    {
      cwd: projectRoot,
      env: {
        npm_config_legacy_peer_deps: 'true',
        npm_config_globalconfig: globalConfig,
        npm_config_userconfig: join(home, '.npmrc'),
        NPM_CONFIG_LEGACY_PEER_DEPS: 'true',
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      },
      home,
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  const entries = await cacheEntries(home);
  assert.equal(entries.length, 1);
  const cacheEntry = join(home, '.open-artifacts', 'cache', 'artifacts', entries[0]);
  const persistedMetadata = `${await readFile(
    join(cacheEntry, 'open-artifacts-provenance.json'),
    'utf8',
  )}\n${await readFile(join(cacheEntry, 'package-lock.json'), 'utf8')}`;
  assert.doesNotMatch(persistedMetadata, /fixture-(?:token|dist)-secret/);
  assert.doesNotMatch(
    await readTree(join(home, '.open-artifacts')),
    /fixture-(?:token|dist)-secret/,
  );
  await assert.rejects(access(join(cacheEntry, '.npmrc')), { code: 'ENOENT' });
  await assertNoCacheTemporaries(home);
  assert.equal(
    JSON.parse(await readFile(join(cacheEntry, 'open-artifacts-provenance.json'), 'utf8')).registry,
    `${registry.origin}/`,
  );
  assert.ok(registry.count('/oa-registry-peer') > 0);
  await stopSession(home, sessionId);
  sessionId = undefined;

  await writeFile(join(projectRoot, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
  const environmentOverride = await runBuiltCliAsync(
    ['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open'],
    {
      cwd: projectRoot,
      env: {
        NPM_CONFIG_REGISTRY: `${registry.origin}/`,
        npm_config_registry: `${registry.origin}/`,
      },
      home,
      timeout: 60_000,
    },
  );
  assert.equal(
    environmentOverride.status,
    0,
    environmentOverride.stderr || environmentOverride.stdout,
  );
  sessionId = JSON.parse(environmentOverride.stdout).sessionId;
  await stopSession(home, sessionId);
  sessionId = undefined;

  await writeFile(
    join(projectRoot, '.npmrc'),
    `@missing-scope:registry=http://user:secret@127.0.0.1:${new URL(registry.origin).port}/\n//127.0.0.1:${new URL(registry.origin).port}/:_authToken=fixture-token-secret\n`,
  );
  const missing = await runBuiltCliAsync(
    ['run', '@missing-scope/private-artifact@1.0.0', '--json', '--no-open'],
    { cwd: projectRoot, home, timeout: 60_000 },
  );
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'ARTIFACT_REFERENCE_INVALID');
  assert.doesNotMatch(missing.stderr, /fixture-token-secret|user:secret/);
  await assertNoCacheTemporaries(home);
  assert.doesNotMatch(
    await readTree(join(home, '.open-artifacts')),
    /fixture-token-secret|user:secret/,
  );
});

test('concurrent npm Artifact cache misses commit one complete persistent entry', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-npm-concurrency-'));
  const registry = await createControlledRegistry();
  const environment = cliEnvironment(home, registry);
  const sessions = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((sessionId) => stopSession(home, sessionId)));
    await registry.close();
    await rm(home, { force: true, recursive: true });
  });

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      runCli(['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open'], environment),
    ),
  );
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    sessions.push(JSON.parse(result.stdout).sessionId);
  }

  assert.equal((await cacheEntries(home)).length, 1);
  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.0.0.tgz'), 1);
  assert.equal(registry.count('/tarballs/oa-registry-helper-1.0.0.tgz'), 1);
  await assertNoCacheTemporaries(home);

  const cacheHit = await runCli(
    ['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open'],
    environment,
  );
  assert.equal(cacheHit.status, 0, cacheHit.stderr || cacheHit.stdout);
  sessions.push(JSON.parse(cacheHit.stdout).sessionId);
  assert.equal((await cacheEntries(home)).length, 1);
});
