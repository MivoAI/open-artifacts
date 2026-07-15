import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '../..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');

export function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

export function runBuiltCli(arguments_, options = {}) {
  return spawnSync(process.execPath, [options.entry ?? cliEntry, ...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: options.home ?? process.env.HOME },
    timeout: options.timeout ?? 30_000,
  });
}

export function runProcess(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...options.env, HOME: options.home ?? process.env.HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timeout = globalThis.setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`Command timed out: ${stderr || stdout}`));
    }, options.timeout ?? 30_000);
    child.once('error', (error) => {
      globalThis.clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      globalThis.clearTimeout(timeout);
      resolveRun({ signal, status: code, stderr, stdout });
    });
  });
}

export function runBuiltCliAsync(arguments_, options = {}) {
  return runProcess(process.execPath, [options.entry ?? cliEntry, ...arguments_], options);
}

export async function stopSession(home, sessionId) {
  const sessionDirectory = join(home, '.open-artifacts', 'sessions', sessionId);
  const record = JSON.parse(await readFile(join(sessionDirectory, 'record.json'), 'utf8'));
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(record.pid, 0);
      await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 25));
    } catch {
      break;
    }
  }
  await rm(sessionDirectory, { force: true, recursive: true });
}
