import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: options.home ?? process.env.HOME },
    timeout: options.timeout ?? 30_000,
  });
}
