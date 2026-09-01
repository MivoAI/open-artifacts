import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInstanceBundle, type PackageBinding } from './bundle.js';
import { InstanceRuntime } from './instance-runtime.js';

export async function createOaTestRuntime<TInput>(options: {
  input: TInput;
  name?: string;
  packageBinding?: PackageBinding;
}) {
  const root = await mkdtemp(join(tmpdir(), 'oa-test-runtime-'));
  const bundle = await createInstanceBundle({
    bundlePath: join(root, 'fixture.openartifact'),
    input: options.input,
    name: options.name ?? 'Test Artifact',
    packageBinding: options.packageBinding ?? {
      name: '@open-artifacts/test-fixture',
      reference: './fixture',
      version: '0.0.0',
    },
  });
  return new InstanceRuntime<TInput>(bundle, {
    cleanup: () => rm(root, { force: true, recursive: true }),
  });
}
