import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');
const artifactRoot = resolve(repositoryRoot, 'packages/artifact-decision-board');

function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runCli(arguments_, home) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 10_000,
  });
}

function startSession(home) {
  const result = runCli(['run', artifactRoot, '--json', '--no-open'], home);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function listSessions(home) {
  const result = runCli(['session', 'list', '--json'], home);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function stopSession(home, sessionId) {
  return runCli(['session', 'stop', sessionId, '--json'], home);
}

async function sessionRecord(home, sessionId) {
  return JSON.parse(
    await readFile(join(home, '.open-artifacts', 'sessions', sessionId, 'record.json'), 'utf8'),
  );
}

async function expectRemoved(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

test('the built oa executable exposes the session command tree', () => {
  buildCli();
  const topLevel = runCli(['--help'], process.env.HOME);
  const session = runCli(['session', '--help'], process.env.HOME);
  const list = runCli(['session', 'list', '--help'], process.env.HOME);
  const stop = runCli(['session', 'stop', '--help'], process.env.HOME);

  assert.equal(topLevel.status, 0, topLevel.stderr);
  assert.match(topLevel.stdout, /session/);
  assert.equal(session.status, 0, session.stderr);
  assert.match(session.stdout, /list \[options\]/);
  assert.match(session.stdout, /stop \[options\] <id>/);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /--json/);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /--json/);
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
  await assert.rejects(globalThis.fetch(sessions[0].url));
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

test('list prunes nonexistent, misowned, unreachable, and malformed Session Records', async (t) => {
  buildCli();
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-stale-'));
  const active = startSession(home);
  const activeRecord = await sessionRecord(home, active.sessionId);
  const sessionsRoot = join(home, '.open-artifacts', 'sessions');
  const staleIds = ['nonexistent', 'misowned', 'unreachable', 'malformed'];

  t.after(async () => {
    stopSession(home, active.sessionId);
    await rm(home, { force: true, recursive: true });
  });

  for (const staleId of staleIds) await mkdir(join(sessionsRoot, staleId), { recursive: true });
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
    join(sessionsRoot, 'unreachable', 'record.json'),
    `${JSON.stringify({
      ...activeRecord,
      sessionId: 'unreachable',
      url: 'http://127.0.0.1:1/',
    })}\n`,
  );
  await writeFile(join(sessionsRoot, 'malformed', 'record.json'), '{oops\n');

  assert.deepEqual(
    listSessions(home).sessions.map(({ sessionId }) => sessionId),
    [active.sessionId],
  );
  await Promise.all(
    staleIds.map((staleId) => expectRemoved(join(sessionsRoot, staleId, 'record.json'))),
  );
});

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
  assert.match(unknown.stderr, /Unknown Artifact Session: unknown-session/);

  await writeFile(
    join(home, '.open-artifacts', 'sessions', active.sessionId, 'record.json'),
    `${JSON.stringify({
      ...record,
      processSignature: { ...record.processSignature, command: 'not-the-runtime' },
    })}\n`,
  );
  const misowned = stopSession(home, active.sessionId);
  assert.notEqual(misowned.status, 0);
  assert.match(misowned.stderr, /no longer belongs to this Artifact Session/);
  assert.equal((await globalThis.fetch(active.url)).status, 200);
});

test('stop force-kills an owned Runtime that cannot handle SIGTERM within three seconds', async (t) => {
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
});
