import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');

function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runCli(arguments_, options = {}) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: options.home ?? process.env.HOME,
    },
    timeout: 30_000,
  });
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

async function waitForSource(url, expected) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const source = await globalThis
      .fetch(`${url}?t=${Date.now()}`)
      .then((response) => response.text());
    if (source.includes(expected)) return source;
    await delay(50);
  }

  throw new Error(`Timed out waiting for transformed source to include: ${expected}`);
}

test('the built oa executable exposes the approved first command surface', () => {
  buildCli();
  const result = runCli(['--help']);
  const runHelp = runCli(['run', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: oa/);
  assert.match(result.stdout, /run \[options\] <artifact>/);
  assert.equal(runHelp.status, 0, runHelp.stderr);
  assert.match(runHelp.stdout, /--json/);
  assert.match(runHelp.stdout, /--no-open/);
});

test('oa run starts local Artifact Packages from relative and absolute references', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-cli-'));
  const sessions = [];
  const results = [];

  t.after(async () => {
    await Promise.allSettled(sessions.map((sessionId) => stopSession(home, sessionId)));
    await rm(home, { force: true, recursive: true });
  });

  const references = [
    {
      argument: './artifact-decision-board',
      cwd: resolve(repositoryRoot, 'packages'),
      name: '@open-artifacts/decision-board',
    },
    {
      argument: resolve(repositoryRoot, 'packages/artifact-evidence-trace'),
      cwd: repositoryRoot,
      name: '@open-artifacts/evidence-trace',
    },
  ];

  for (const reference of references) {
    const result = runCli(['run', reference.argument, '--json', '--no-open'], {
      cwd: reference.cwd,
      home,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const session = JSON.parse(result.stdout);
    sessions.push(session.sessionId);
    results.push(session);

    assert.equal(session.artifact.name, reference.name);
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
    assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const healthResponse = await globalThis.fetch(`${session.url}__oa/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      artifact: reference.name,
      sessionId: session.sessionId,
      status: 'active',
    });

    const preflightResponse = await globalThis.fetch(`${session.url}__oa/preflight`);
    assert.equal(preflightResponse.status, 200);
    assert.deepEqual(await preflightResponse.json(), { status: 'ready' });

    const pageResponse = await globalThis.fetch(session.url);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /<div id="root"><\/div>/);
    assert.match(page, /#root \{ min-height: 100vh; \}/);
  }

  assert.equal(new Set(results.map(({ sessionId }) => sessionId)).size, references.length);
  assert.equal(new Set(results.map(({ url }) => url)).size, references.length);
});

test('an active local Session reads Artifact source edits in place', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-source-edit-'));
  const artifactRoot = join(home, 'editable-artifact');
  const sourcePath = join(artifactRoot, 'src/index.tsx');
  let sessionId;

  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });

  await mkdir(join(artifactRoot, 'src'), { recursive: true });
  await writeFile(
    join(artifactRoot, 'package.json'),
    `${JSON.stringify({
      exports: {
        '.': './src/index.tsx',
        './example': './example.json',
      },
      name: '@open-artifacts/editable-fixture',
      openArtifacts: { format: 'react-render/v0' },
      type: 'module',
      version: '0.0.0',
    })}\n`,
  );
  await writeFile(join(artifactRoot, 'example.json'), '{}\n');
  await writeFile(
    sourcePath,
    `export default function EditableArtifact() { return <h1>source version one</h1>; }\n`,
  );

  const result = runCli(['run', artifactRoot, '--json', '--no-open'], { home });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;

  const sourceUrl = new URL(`/@fs/${session.artifact.root}/src/index.tsx`, session.url);
  const firstSource = await globalThis.fetch(sourceUrl).then((response) => response.text());
  assert.match(firstSource, /source version one/);

  await writeFile(
    sourcePath,
    `export default function EditableArtifact() { return <h1>source version two</h1>; }\n`,
  );

  const secondSource = await waitForSource(sourceUrl.href, 'source version two');
  assert.match(secondSource, /source version two/);
});
