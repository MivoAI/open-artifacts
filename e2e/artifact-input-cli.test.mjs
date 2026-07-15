import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { buildCli, repositoryRoot, runBuiltCli } from './helpers/cli.mjs';

const artifactRoot = resolve(repositoryRoot, 'packages/artifact-evidence-trace');

async function exampleInput(title) {
  const input = JSON.parse(await readFile(join(artifactRoot, 'example.json'), 'utf8'));
  input.title = title;
  return input;
}

async function stopSession(home, sessionId) {
  const sessionDirectory = join(home, '.open-artifacts', 'sessions', sessionId);
  const record = JSON.parse(await readFile(join(sessionDirectory, 'record.json'), 'utf8'));

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  await rm(sessionDirectory, { force: true, recursive: true });
}

async function sessionDirectories(home) {
  return readdir(join(home, '.open-artifacts', 'sessions')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

function parseJsonError(result) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  return JSON.parse(result.stderr);
}

function parseHumanSession(stdout) {
  const [sessionLine, artifactName, url] = stdout.trim().split('\n');
  assert.match(sessionLine, /^Artifact Session [0-9a-f-]{36}$/);
  return {
    artifact: { name: artifactName },
    sessionId: sessionLine.slice('Artifact Session '.length),
    url,
  };
}

async function assertRuntimeInput(home, session, expectedInput, marker) {
  const runtimeConfig = JSON.parse(
    await readFile(
      join(home, '.open-artifacts', 'sessions', session.sessionId, 'runtime.json'),
      'utf8',
    ),
  );
  assert.deepEqual(runtimeConfig.artifactInput, expectedInput);

  const renderEntry = await globalThis
    .fetch(new URL('/@id/virtual:open-artifacts-session-entry', session.url))
    .then((response) => response.text());
  assert.match(renderEntry, new RegExp(marker));
}

test.before(buildCli);

test('oa run --data passes inline JSON unchanged to the Render in JSON mode', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-inline-input-'));
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });
  const input = await exampleInput('inline-input-marker');

  const result = runBuiltCli(
    ['run', artifactRoot, '--data', JSON.stringify(input), '--json', '--no-open'],
    { home },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  await assertRuntimeInput(home, session, input, 'inline-input-marker');
});

test('oa run --input resolves files from invocation cwd and reaches the Render in human mode', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-file-input-'));
  const invocationDirectory = join(home, 'invocation');
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });
  await mkdir(invocationDirectory);
  const input = await exampleInput('file-input-marker');
  await writeFile(join(invocationDirectory, 'artifact-input.json'), JSON.stringify(input));

  const result = runBuiltCli(
    ['run', artifactRoot, '--input', './artifact-input.json', '--no-open'],
    { cwd: invocationDirectory, home },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = parseHumanSession(result.stdout);
  sessionId = session.sessionId;
  assert.equal(session.artifact.name, '@open-artifacts/evidence-trace');
  await assertRuntimeInput(home, session, input, 'file-input-marker');
});

test('oa run keeps the invocation cwd when trusted source changes the process cwd', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-stable-input-cwd-'));
  const invocationDirectory = join(home, 'invocation');
  const artifactCopy = join(home, 'artifact');
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });
  await Promise.all([
    mkdir(invocationDirectory),
    cp(artifactRoot, artifactCopy, { recursive: true }),
  ]);
  const sourcePath = join(artifactCopy, 'src/index.tsx');
  const source = await readFile(sourcePath, 'utf8');
  await writeFile(
    sourcePath,
    `if (typeof process !== 'undefined') process.chdir(${JSON.stringify(tmpdir())});\n${source}`,
  );
  const input = await exampleInput('stable-invocation-cwd-marker');
  await writeFile(join(invocationDirectory, 'artifact-input.json'), JSON.stringify(input));

  const result = runBuiltCli(
    ['run', artifactCopy, '--input', './artifact-input.json', '--json', '--no-open'],
    { cwd: invocationDirectory, home },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  await assertRuntimeInput(home, session, input, 'stable-invocation-cwd-marker');
});

test('oa run rejects conflicting input options before creating a Session', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-input-conflict-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const input = await exampleInput('conflict-marker');
  await writeFile(join(home, 'input.json'), JSON.stringify(input));

  const error = parseJsonError(
    runBuiltCli(
      [
        'run',
        artifactRoot,
        '--input',
        join(home, 'input.json'),
        '--data',
        JSON.stringify(input),
        '--json',
        '--no-open',
      ],
      { home },
    ),
  );

  assert.equal(error.error.code, 'ARTIFACT_INPUT_OPTIONS_CONFLICT');
  assert.equal(error.error.kind, 'input');
  assert.deepEqual(await sessionDirectories(home), []);
});

test('oa run rejects malformed inline and file JSON before creating a Session', async (t) => {
  for (const inputCase of [
    { name: 'inline JSON', arguments: ['--data', '{'] },
    { name: 'file JSON', arguments: ['--input', './malformed.json'], writeFile: true },
  ]) {
    await t.test(inputCase.name, async (subtest) => {
      const home = await mkdtemp(join(tmpdir(), 'open-artifacts-malformed-input-'));
      subtest.after(() => rm(home, { force: true, recursive: true }));
      if (inputCase.writeFile) await writeFile(join(home, 'malformed.json'), '{');

      const error = parseJsonError(
        runBuiltCli(['run', artifactRoot, ...inputCase.arguments, '--json', '--no-open'], {
          cwd: home,
          home,
        }),
      );

      assert.equal(error.error.code, 'ARTIFACT_INPUT_JSON_INVALID');
      assert.equal(error.error.kind, 'input');
      assert.deepEqual(await sessionDirectories(home), []);
    });
  }
});

test('oa run rejects unreadable files and Input Contract violations before Session creation', async (t) => {
  const cases = [
    {
      name: 'unreadable input file',
      arguments: ['--input', './missing.json'],
      code: 'ARTIFACT_INPUT_FILE_UNREADABLE',
    },
    {
      name: 'schema-invalid input',
      arguments: ['--data', '{}'],
      code: 'ARTIFACT_INPUT_CONTRACT_INVALID',
      expectedPath: '$.title',
    },
  ];

  for (const inputCase of cases) {
    await t.test(inputCase.name, async (subtest) => {
      const home = await mkdtemp(join(tmpdir(), 'open-artifacts-invalid-input-'));
      subtest.after(() => rm(home, { force: true, recursive: true }));

      const error = parseJsonError(
        runBuiltCli(['run', artifactRoot, ...inputCase.arguments, '--json', '--no-open'], {
          cwd: home,
          home,
        }),
      );

      assert.equal(error.error.code, inputCase.code);
      assert.equal(error.error.kind, 'input');
      if (inputCase.expectedPath) {
        assert.ok(error.error.issues.some((issue) => issue.path === inputCase.expectedPath));
      }
      assert.deepEqual(await sessionDirectories(home), []);
    });
  }
});

test('oa run help exposes both custom Artifact Input forms', () => {
  const result = runBuiltCli(['run', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--input <file>/);
  assert.match(result.stdout, /--data <json>/);
});
