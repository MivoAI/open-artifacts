import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildCli, repositoryRoot, runBuiltCliAsync, stopSession } from './helpers/cli.mjs';
import { createControlledRegistry } from './helpers/npm-registry.mjs';

function runCli(arguments_, options) {
  return runBuiltCliAsync(arguments_, {
    ...options,
    env: {
      NPM_CONFIG_REGISTRY: options.registry,
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
  await writeFile(
    join(
      home,
      '.open-artifacts',
      'cache',
      'artifacts',
      latestEntry,
      'node_modules',
      'oa-registry-artifact',
      'example.json',
    ),
    '{}\n',
  );
  const invalidCacheHit = await runCli(
    ['run', 'oa-registry-artifact@stable', '--json', '--no-open'],
    environment,
  );
  assert.equal(invalidCacheHit.status, 1, invalidCacheHit.stdout);
  assert.equal(JSON.parse(invalidCacheHit.stderr).error.code, 'ARTIFACT_PACKAGE_CONTRACT_INVALID');
  assert.equal(registry.count('/tarballs/oa-registry-artifact-1.1.0.tgz'), 1);
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
