import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCli, stopSession } from './helpers/cli.mjs';
import { createPackedCliFixture } from './helpers/packed-cli.mjs';

test.before(buildCli);

test('the packed CLI installs oa with its private runtime and starts an npm Artifact Session', async (t) => {
  const fixture = await createPackedCliFixture();
  let sessionId;
  t.after(async () => {
    try {
      if (sessionId) {
        let stopped;
        try {
          stopped = await fixture.runOa(['session', 'stop', sessionId, '--json']);
        } catch (error) {
          await stopSession(fixture.home, sessionId);
          throw error;
        }
        if (stopped.status !== 0) await stopSession(fixture.home, sessionId);
        assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
      }
    } finally {
      await fixture.dispose();
    }
  });
  const filePaths = fixture.packResult.files.map(({ path }) => path);
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
  assert.ok(fixture.registry.count('/ajv') > 0);
  const result = await fixture.runOa(['run', 'oa-registry-artifact@1.0.0', '--json', '--no-open']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  assert.equal(session.artifact.name, 'oa-registry-artifact');
  assert.equal(session.artifact.version, '1.0.0');
  assert.equal((await globalThis.fetch(`${session.url}__oa/health`)).status, 200);
});
