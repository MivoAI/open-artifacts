import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('the server application slot remains an empty placeholder', async () => {
  const entries = await readdir(resolve('apps/server'));
  const lockfile = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  const rootTypeScriptConfig = JSON.parse(await readFile(resolve('tsconfig.json'), 'utf8'));

  assert.deepEqual(entries, ['.gitkeep']);
  assert.equal(lockfile.packages['apps/server'], undefined);
  assert.equal(
    rootTypeScriptConfig.references.some(({ path }) => path === './apps/server'),
    false,
  );
});
