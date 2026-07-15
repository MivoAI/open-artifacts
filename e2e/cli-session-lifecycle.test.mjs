import assert from 'node:assert/strict';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');
const artifactRoot = resolve(repositoryRoot, 'packages/artifact-decision-board');
const plainArtifactRoot = resolve(repositoryRoot, 'packages/artifact-evidence-trace');

function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runCli(arguments_, home, environment = {}) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment, HOME: home },
    timeout: 10_000,
  });
}

function startSession(home, environment) {
  const result = runCli(['run', artifactRoot, '--json', '--no-open'], home, environment);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function listSessions(home, environment) {
  const result = runCli(['session', 'list', '--json'], home, environment);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function stopSession(home, sessionId, environment) {
  return runCli(['session', 'stop', sessionId, '--json'], home, environment);
}

async function sessionRecord(home, sessionId) {
  return JSON.parse(
    await readFile(join(home, '.open-artifacts', 'sessions', sessionId, 'record.json'), 'utf8'),
  );
}

async function writeSessionRecord(home, sessionId, record) {
  await writeFile(
    join(home, '.open-artifacts', 'sessions', sessionId, 'record.json'),
    `${JSON.stringify(record)}\n`,
  );
}

async function expectRemoved(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

async function expectUnreachable(url) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      await response.body?.cancel();
    } catch {
      return;
    }
    await delay(25);
  }
  assert.fail(`expected ${url} to become unreachable`);
}

test('the built oa executable exposes the session command tree', () => {
  buildCli();
  const topLevel = runCli(['--help'], process.env.HOME);
  const session = runCli(['session', '--help'], process.env.HOME);
  const list = runCli(['session', 'list', '--help'], process.env.HOME);
  const stop = runCli(['session', 'stop', '--help'], process.env.HOME);
  const topLevelHelpCommand = runCli(['help'], process.env.HOME);
  const sessionHelpCommand = runCli(['session', 'help'], process.env.HOME);

  assert.equal(topLevel.status, 0, topLevel.stderr);
  assert.match(topLevel.stdout, /session/);
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /list \[options\]/);
  assert.match(session.stdout, /stop \[options\] <id>/);
  assert.doesNotMatch(session.stdout, /^\s+help\b/m);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /--json/);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /--json/);
  assert.equal(topLevelHelpCommand.status, 1);
  assert.equal(sessionHelpCommand.status, 1);
});

test('run, list, and stop manage concurrent Active Sessions independently', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-lifecycle-'));
  const sessions = [];

  t.after(async () => {
    for (const session of sessions) stopSession(home, session.sessionId);
    await rm(home, { force: true, recursive: true });
  });

  sessions.push(startSession(home), startSession(home));
  const records = await Promise.all(
    sessions.map((session) => sessionRecord(home, session.sessionId)),
  );

  const unauthorizedShutdown = await globalThis.fetch(`${sessions[0].url}__oa/shutdown`, {
    method: 'POST',
  });
  assert.equal(unauthorizedShutdown.status, 401);
  assert.equal((await globalThis.fetch(sessions[0].url)).status, 200);

  const sessionRoot = join(home, '.open-artifacts', 'sessions', sessions[0].sessionId);
  const secret = (await readFile(join(sessionRoot, 'instance.secret'), 'utf8')).trim();
  const directSecretResponse = await globalThis.fetch(`${sessions[0].url}instance.secret`);
  assert.doesNotMatch(await directSecretResponse.text(), new RegExp(secret));
  const fileSystemSecretResponse = await globalThis.fetch(
    new globalThis.URL(`/@fs/${join(sessionRoot, 'instance.secret')}`, sessions[0].url),
  );
  assert.equal(fileSystemSecretResponse.status, 403);

  assert.equal(new Set(sessions.map(({ sessionId }) => sessionId)).size, 2);
  assert.equal(new Set(sessions.map(({ url }) => url)).size, 2);
  assert.equal(new Set(records.map(({ pid }) => pid)).size, 2);

  const listed = listSessions(home);
  assert.deepEqual(
    listed.sessions.map(({ artifact, sessionId, startedAt, status, url }) => ({
      artifact,
      sessionId,
      startedAt,
      status,
      url,
    })),
    sessions
      .map((session) => ({
        artifact: session.artifact,
        sessionId: session.sessionId,
        startedAt: records.find(({ sessionId }) => sessionId === session.sessionId).startedAt,
        status: 'active',
        url: session.url,
      }))
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      ),
  );

  const humanList = runCli(['session', 'list'], home);
  assert.equal(humanList.status, 0, humanList.stderr);
  assert.match(humanList.stdout, /Active Artifact Sessions/);
  assert.match(humanList.stdout, /active · started/);
  for (const session of sessions) assert.match(humanList.stdout, new RegExp(session.sessionId));

  const gracefulStartedAt = Date.now();
  const stopped = stopSession(home, sessions[0].sessionId);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.ok(Date.now() - gracefulStartedAt < 3_000, 'expected graceful shutdown before fallback');
  assert.deepEqual(JSON.parse(stopped.stdout), {
    sessionId: sessions[0].sessionId,
    status: 'stopped',
  });
  await expectUnreachable(sessions[0].url);
  assert.equal((await globalThis.fetch(sessions[1].url)).status, 200);
  assert.deepEqual(
    listSessions(home).sessions.map(({ sessionId }) => sessionId),
    [sessions[1].sessionId],
  );

  const stoppedSecond = stopSession(home, sessions[1].sessionId);
  assert.equal(stoppedSecond.status, 0, stoppedSecond.stderr || stoppedSecond.stdout);
  assert.deepEqual(listSessions(home), { sessions: [] });
  const emptyHumanList = runCli(['session', 'list'], home);
  assert.equal(emptyHumanList.status, 0, emptyHumanList.stderr);
  assert.equal(emptyHumanList.stdout, 'No Active Artifact Sessions.\n');
});

test('the Runtime denies Session control files when the Artifact root contains them', async (t) => {
  buildCli();
  const root = await mkdtemp(join(tmpdir(), 'open-artifacts-control%20-boundary-'));
  const home = join(root, 'artifact-home');
  await cp(plainArtifactRoot, home, { recursive: true });
  let session;

  t.after(async () => {
    if (session) stopSession(home, session.sessionId);
    await rm(root, { force: true, recursive: true });
  });

  const result = runCli(['run', home, '--json', '--no-open'], home);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  session = JSON.parse(result.stdout);
  const secretPath = join(
    home,
    '.open-artifacts',
    'sessions',
    session.sessionId,
    'instance.secret',
  );
  const secret = (await readFile(secretPath, 'utf8')).trim();
  const browserSecretPath = secretPath.replaceAll('%', '%25');

  const response = await globalThis.fetch(
    new globalThis.URL(`/@fs/${browserSecretPath}?raw&import`, session.url),
  );
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), new RegExp(secret));

  const encodedResponse = await globalThis.fetch(
    new globalThis.URL(`/%40fs/${browserSecretPath}?raw&import`, session.url),
  );
  assert.equal(encodedResponse.status, 403);
  assert.doesNotMatch(await encodedResponse.text(), new RegExp(secret));

  const controlLink = join(home, 'linked-session-control');
  await symlink(join(home, '.open-artifacts', 'sessions', session.sessionId), controlLink);
  const browserControlLink = join(controlLink, 'instance.secret').replaceAll('%', '%25');
  const linkedResponse = await globalThis.fetch(
    new globalThis.URL(`/@fs/${browserControlLink}`, session.url),
  );
  assert.equal(linkedResponse.status, 403);
  assert.doesNotMatch(await linkedResponse.text(), new RegExp(secret));

  const stopped = stopSession(home, session.sessionId);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  session = undefined;
});

test('process ownership remains stable when Session commands use different timezones', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-timezone-'));
  const session = startSession(home, { TZ: 'UTC' });

  t.after(async () => {
    stopSession(home, session.sessionId, { TZ: 'UTC' });
    await rm(home, { force: true, recursive: true });
  });

  assert.deepEqual(
    listSessions(home, { TZ: 'America/New_York' }).sessions.map(({ sessionId }) => sessionId),
    [session.sessionId],
  );

  const stopped = stopSession(home, session.sessionId, { TZ: 'Asia/Shanghai' });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.deepEqual(JSON.parse(stopped.stdout), {
    sessionId: session.sessionId,
    status: 'stopped',
  });
});

test('list prunes malformed, dead, misowned, and ready-mismatched Session Records', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-stale-'));
  const active = startSession(home);
  const activeRecord = await sessionRecord(home, active.sessionId);
  const sessionsRoot = join(home, '.open-artifacts', 'sessions');
  const staleIds = ['malformed', 'nonexistent', 'misowned', 'ready-mismatch'];

  t.after(async () => {
    stopSession(home, active.sessionId);
    await rm(home, { force: true, recursive: true });
  });

  for (const staleId of staleIds) await mkdir(join(sessionsRoot, staleId), { recursive: true });
  await writeFile(join(sessionsRoot, 'malformed', 'record.json'), '{oops\n');
  await writeFile(
    join(sessionsRoot, 'nonexistent', 'record.json'),
    `${JSON.stringify({ ...activeRecord, pid: 999_999, sessionId: 'nonexistent' })}\n`,
  );
  await writeFile(
    join(sessionsRoot, 'misowned', 'record.json'),
    `${JSON.stringify({
      ...activeRecord,
      processSignature: { ...activeRecord.processSignature, command: 'not-the-runtime' },
      sessionId: 'misowned',
    })}\n`,
  );
  await writeFile(
    join(sessionsRoot, 'ready-mismatch', 'record.json'),
    `${JSON.stringify({
      ...activeRecord,
      sessionId: 'ready-mismatch',
      url: 'http://127.0.0.1:1/',
    })}\n`,
  );

  assert.deepEqual(
    listSessions(home).sessions.map(({ sessionId }) => sessionId),
    [active.sessionId],
  );
  await Promise.all(
    staleIds.map((staleId) => expectRemoved(join(sessionsRoot, staleId, 'record.json'))),
  );
});

test(
  'list hides a temporarily unreachable owned Runtime without removing its stoppable record',
  { skip: process.platform === 'win32' },
  async (t) => {
    buildCli();
    const home = await mkdtemp(join(tmpdir(), 'open-artifacts-unreachable-'));
    const session = startSession(home);
    const record = await sessionRecord(home, session.sessionId);
    const recordPath = join(home, '.open-artifacts', 'sessions', session.sessionId, 'record.json');

    t.after(async () => {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // The stop command already terminated the Runtime.
      }
      await rm(home, { force: true, recursive: true });
    });

    process.kill(record.pid, 'SIGSTOP');
    assert.deepEqual(listSessions(home), { sessions: [] });
    await access(recordPath);

    const stopped = stopSession(home, session.sessionId);
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  },
);

test('stop refuses unknown or misowned records without signaling the recorded process', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-stop-safety-'));
  const active = startSession(home);
  const record = await sessionRecord(home, active.sessionId);

  t.after(async () => {
    await writeFile(
      join(home, '.open-artifacts', 'sessions', active.sessionId, 'record.json'),
      `${JSON.stringify(record)}\n`,
    ).catch(() => undefined);
    stopSession(home, active.sessionId);
    await rm(home, { force: true, recursive: true });
  });

  const unknown = stopSession(home, 'unknown-session');
  assert.notEqual(unknown.status, 0);
  assert.deepEqual(JSON.parse(unknown.stderr), {
    error: {
      code: 'ARTIFACT_SESSION_NOT_FOUND',
      kind: 'session',
      message: 'Unknown Artifact Session: unknown-session',
    },
  });

  await writeFile(
    join(home, '.open-artifacts', 'sessions', active.sessionId, 'record.json'),
    `${JSON.stringify({
      ...record,
      processSignature: { ...record.processSignature, command: 'not-the-runtime' },
    })}\n`,
  );
  const misowned = stopSession(home, active.sessionId);
  assert.notEqual(misowned.status, 0);
  assert.deepEqual(JSON.parse(misowned.stderr), {
    error: {
      code: 'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
      kind: 'session',
      message: `Process ${record.pid} no longer belongs to this Artifact Session: ${active.sessionId}`,
    },
  });
  assert.equal((await globalThis.fetch(active.url)).status, 200);
});

test('stop binds each tampered record to its own Runtime-written ready identity', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-stop-ready-binding-'));
  const first = startSession(home);
  const second = startSession(home);
  const firstRecord = await sessionRecord(home, first.sessionId);
  const secondRecord = await sessionRecord(home, second.sessionId);
  const instanceToken = (
    await readFile(
      join(home, '.open-artifacts', 'sessions', first.sessionId, 'instance.secret'),
      'utf8',
    )
  ).trim();
  assert.equal(JSON.stringify(firstRecord).includes(instanceToken), false);
  if (process.platform !== 'win32') {
    const secret = await stat(
      join(home, '.open-artifacts', 'sessions', first.sessionId, 'instance.secret'),
    );
    assert.equal(secret.mode & 0o777, 0o600);
  }

  t.after(async () => {
    await Promise.all([
      writeSessionRecord(home, first.sessionId, firstRecord),
      writeSessionRecord(home, second.sessionId, secondRecord),
    ]);
    stopSession(home, first.sessionId);
    stopSession(home, second.sessionId);
    await rm(home, { force: true, recursive: true });
  });

  await writeSessionRecord(home, first.sessionId, {
    ...firstRecord,
    pid: secondRecord.pid,
    processSignature: secondRecord.processSignature,
  });
  const redirectedProcess = stopSession(home, first.sessionId);
  assert.notEqual(redirectedProcess.status, 0);
  assert.equal(
    JSON.parse(redirectedProcess.stderr).error.code,
    'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
  );

  await writeSessionRecord(home, second.sessionId, {
    ...secondRecord,
    instanceId: firstRecord.instanceId,
    url: firstRecord.url,
  });
  const redirectedEndpoint = stopSession(home, second.sessionId);
  assert.notEqual(redirectedEndpoint.status, 0);
  assert.equal(
    JSON.parse(redirectedEndpoint.stderr).error.code,
    'ARTIFACT_SESSION_OWNERSHIP_MISMATCH',
  );

  assert.equal((await globalThis.fetch(first.url)).status, 200);
  assert.equal((await globalThis.fetch(second.url)).status, 200);
});

test(
  'stop force-kills an owned Runtime when authenticated shutdown cannot complete in three seconds',
  { skip: process.platform === 'win32' },
  async (t) => {
    buildCli();
    const home = await mkdtemp(join(tmpdir(), 'open-artifacts-force-stop-'));
    const session = startSession(home);
    const record = await sessionRecord(home, session.sessionId);
    const sessionDirectory = join(home, '.open-artifacts', 'sessions', session.sessionId);

    t.after(async () => {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // The stop command already terminated the Runtime.
      }
      await rm(home, { force: true, recursive: true });
    });

    process.kill(record.pid, 'SIGSTOP');
    const startedAt = Date.now();
    const stopped = stopSession(home, session.sessionId);
    const elapsed = Date.now() - startedAt;

    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    assert.ok(elapsed >= 2_900, `expected the graceful timeout, got ${elapsed}ms`);
    assert.ok(elapsed < 6_000, `expected SIGKILL fallback, got ${elapsed}ms`);
    assert.deepEqual(JSON.parse(stopped.stdout), {
      sessionId: session.sessionId,
      status: 'stopped',
    });
    await expectRemoved(sessionDirectory);
  },
);
