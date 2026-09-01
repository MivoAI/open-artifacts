import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { GitDataAuthority, createInstanceBundle, readInstanceBundle } from '../src/index.js';
import type { RuntimeError } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oa-runtime-'));
  roots.push(root);
  const bundlePath = join(root, 'counter.openartifact');
  const bundle = await createInstanceBundle({
    bundlePath,
    input: { initialValue: 0 },
    name: 'Counter',
    packageBinding: {
      name: '@open-artifacts/counter',
      reference: './counter',
      version: '1.0.0',
    },
  });
  return { bundle, bundlePath, root };
}

it('creates a movable Instance Bundle whose identity survives relocation', async () => {
  const { bundle, bundlePath, root } = await fixture();
  const movedPath = join(root, 'moved.openartifact');
  await rename(bundlePath, movedPath);
  const moved = await readInstanceBundle(movedPath);

  expect(moved.instance.instanceId).toBe(bundle.instance.instanceId);
  expect(JSON.parse(await readFile(join(movedPath, 'input.json'), 'utf8'))).toEqual({
    initialValue: 0,
  });
  expect(moved.instance.state).toBe('active');
  expect(JSON.parse(await readFile(join(movedPath, 'package.lock.json'), 'utf8'))).toMatchObject({
    name: '@open-artifacts/counter',
    version: '1.0.0',
  });
  expect((await stat(movedPath)).mode & 0o777).toBe(0o700);
  expect((await stat(join(movedPath, 'input.json'))).mode & 0o777).toBe(0o600);
});

it('preserves a legacy Package format independently from the Bundle format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oa-runtime-v0-'));
  roots.push(root);
  const bundle = await createInstanceBundle({
    bundlePath: join(root, 'legacy.openartifact'),
    input: { message: 'hello' },
    name: 'Legacy',
    packageBinding: {
      format: 'react-render/v0',
      name: '@open-artifacts/legacy',
      reference: './legacy',
      version: '1.0.0',
    },
  });
  expect(bundle.packageBinding.format).toBe('react-render/v0');
  await expect(readInstanceBundle(bundle.path)).resolves.toMatchObject({
    packageBinding: { format: 'react-render/v0' },
  });
});

it('uses the data Git commit as revision and rejects stale or non-idempotent writes', async () => {
  const { bundle } = await fixture();
  const authority = new GitDataAuthority(bundle);
  const counter = await authority.bind({
    initial: { value: 0 },
    path: 'counter.json',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['value'],
      additionalProperties: false,
      properties: { value: { type: 'integer' } },
    },
  });
  expect(counter.revision).toMatch(/^[0-9a-f]{40,64}$/);

  const committed = await authority.commit({
    actor: { type: 'human', id: 'onee' },
    baseRevision: counter.revision,
    data: { value: 1 },
    idempotencyKey: 'counter-1',
    path: 'counter.json',
  });
  expect(committed.revision).not.toBe(counter.revision);
  expect(committed.revision).toBe(await authority.revision());
  await expect(
    authority.commit({
      actor: { type: 'human', id: 'onee' },
      baseRevision: committed.revision,
      data: { value: 1 },
      idempotencyKey: 'counter-no-op',
      path: 'counter.json',
    }),
  ).resolves.toMatchObject({ revision: committed.revision });

  await expect(
    authority.commit({
      actor: { type: 'agent', id: 'agent-1' },
      baseRevision: counter.revision,
      data: { value: 2 },
      idempotencyKey: 'stale',
      path: 'counter.json',
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

  await expect(
    authority.commit({
      actor: { type: 'human', id: 'onee' },
      baseRevision: counter.revision,
      data: { value: 1 },
      idempotencyKey: 'counter-1',
      path: 'counter.json',
    }),
  ).resolves.toEqual(committed);

  await expect(
    authority.commit({
      actor: { type: 'human', id: 'onee' },
      baseRevision: committed.revision,
      data: { value: 3 },
      idempotencyKey: 'counter-1',
      path: 'counter.json',
    }),
  ).rejects.toEqual(
    expect.objectContaining<Partial<RuntimeError>>({ code: 'IDEMPOTENCY_CONFLICT' }),
  );
});

it('supports text bindings and rejects paths outside bundle Data', async () => {
  const { bundle, root } = await fixture();
  const authority = new GitDataAuthority(bundle);
  await expect(
    authority.bindText({ initial: '# Hello\n', path: 'notes/readme.md' }),
  ).resolves.toEqual(expect.objectContaining({ data: '# Hello\n' }));
  await expect(
    authority.bindText({ initial: 'escape', path: '../outside.md' }),
  ).rejects.toMatchObject({ code: 'DATA_PATH_INVALID' });
  await expect(
    authority.bindText({ initial: 'escape', path: 'notes/../outside.md' }),
  ).rejects.toMatchObject({ code: 'DATA_PATH_INVALID' });
  await expect(
    authority.bindText({ initial: 'escape', path: '.Git/config' }),
  ).rejects.toMatchObject({ code: 'DATA_PATH_INVALID' });

  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'private');
  await symlink(outside, join(bundle.dataPath, 'escape.txt'));
  await expect(
    authority.bindText({ initial: 'overwrite', path: 'escape.txt' }),
  ).rejects.toMatchObject({ code: 'DATA_PATH_INVALID' });
  await expect(readFile(outside, 'utf8')).resolves.toBe('private');
});

it('enforces the complete JSON Schema contract used by a Package', async () => {
  const { bundle } = await fixture();
  const authority = new GitDataAuthority(bundle);
  await expect(
    authority.bind({
      initial: { values: ['duplicate', 'duplicate'] },
      path: 'unique.json',
      schema: {
        type: 'object',
        required: ['values'],
        additionalProperties: false,
        properties: {
          values: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
          },
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'DATA_SCHEMA_INVALID' });
});
