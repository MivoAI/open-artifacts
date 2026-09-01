import assert from 'node:assert/strict';
import { access, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { buildCli, repositoryRoot, stopSession } from './helpers/cli.mjs';
import { createPackedCliFixture } from './helpers/packed-cli.mjs';

const artifactReference = './packages/artifact-markdown-editor';

test.before(buildCli);

test('Artifact Instance lifecycle keeps one movable Bundle and identity', async (t) => {
  const fixture = await createPackedCliFixture();
  let activeSession;

  t.after(async () => {
    if (activeSession)
      await stopSession(fixture.home, activeSession.sessionId).catch(() => undefined);
    await fixture.dispose();
  });

  const started = await fixture.runOa(['run', artifactReference, '--json', '--no-open'], {
    cwd: repositoryRoot,
  });
  assert.equal(started.status, 0, started.stderr || started.stdout);
  activeSession = JSON.parse(started.stdout);
  const { bundlePath, instanceId } = activeSession;
  assert.equal(bundlePath.startsWith(join(fixture.home, '.open-artifacts', 'instances')), true);

  const listed = await fixture.runOa(['instance', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.deepEqual(
    JSON.parse(listed.stdout).instances.map(({ instanceId: id, state }) => ({ id, state })),
    [{ id: instanceId, state: 'active' }],
  );

  const stopped = await fixture.runOa(['instance', 'stop', instanceId, '--json']);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  activeSession = undefined;
  assert.equal(
    JSON.parse(await readFile(join(bundlePath, 'instance.json'), 'utf8')).state,
    'stopped',
  );
  const durableContents = await Promise.all(
    ['data/document.md', 'annotations.json', 'package.lock.json'].map((path) =>
      readFile(join(bundlePath, path), 'utf8'),
    ),
  );

  const restarted = await fixture.runOa(['instance', 'start', instanceId, '--json', '--no-open']);
  assert.equal(restarted.status, 0, restarted.stderr || restarted.stdout);
  activeSession = JSON.parse(restarted.stdout);
  assert.equal(activeSession.instanceId, instanceId);
  assert.equal(activeSession.bundlePath, bundlePath);

  assert.equal((await fixture.runOa(['instance', 'stop', instanceId, '--json'])).status, 0);
  activeSession = undefined;

  const archived = await fixture.runOa(['instance', 'archive', instanceId, '--json']);
  assert.equal(archived.status, 0, archived.stderr || archived.stdout);
  assert.equal(JSON.parse(archived.stdout).state, 'archived');
  const archivedStart = await fixture.runOa([
    'instance',
    'start',
    instanceId,
    '--json',
    '--no-open',
  ]);
  assert.notEqual(archivedStart.status, 0);

  const restored = await fixture.runOa(['instance', 'restore', instanceId, '--json']);
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.equal(JSON.parse(restored.stdout).state, 'stopped');

  const destination = join(fixture.installRoot, 'moved.openartifact');
  const moved = await fixture.runOa(['instance', 'move', instanceId, destination, '--json']);
  assert.equal(moved.status, 0, moved.stderr || moved.stdout);
  assert.equal(JSON.parse(moved.stdout).bundlePath, destination);
  await assert.rejects(access(bundlePath));
  await access(destination);

  const movedStart = await fixture.runOa(['instance', 'start', destination, '--json', '--no-open']);
  assert.equal(movedStart.status, 0, movedStart.stderr || movedStart.stdout);
  activeSession = JSON.parse(movedStart.stdout);
  assert.equal(activeSession.instanceId, instanceId);
  assert.equal(activeSession.bundlePath, destination);
  assert.equal((await fixture.runOa(['instance', 'stop', instanceId, '--json'])).status, 0);
  activeSession = undefined;

  const manuallyMoved = join(fixture.installRoot, 'manual.openartifact');
  await rename(destination, manuallyMoved);
  const registered = await fixture.runOa(['instance', 'register', manuallyMoved, '--json']);
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  assert.equal(JSON.parse(registered.stdout).instanceId, instanceId);

  const finalList = await fixture.runOa(['instance', 'list', '--json']);
  assert.equal(finalList.status, 0, finalList.stderr || finalList.stdout);
  const finalInstances = JSON.parse(finalList.stdout).instances;
  assert.equal(finalInstances.length, 1);
  assert.equal(finalInstances[0].bundlePath, manuallyMoved);
  assert.equal(finalInstances[0].instanceId, instanceId);
  assert.equal(finalInstances[0].state, 'stopped');
  assert.deepEqual(
    await Promise.all(
      ['data/document.md', 'annotations.json', 'package.lock.json'].map((path) =>
        readFile(join(manuallyMoved, path), 'utf8'),
      ),
    ),
    durableContents,
  );
});
