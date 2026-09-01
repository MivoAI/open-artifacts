import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { JsonValue } from '@open-artifacts/sdk';

import { RuntimeError } from './errors.js';
import { readJson, writeJsonAtomically } from './fs.js';

const execute = promisify(execFile);
export const artifactRuntimeFormat = 'react-runtime/v1' as const;
export type ArtifactPackageFormat = 'react-render/v0' | typeof artifactRuntimeFormat;

export interface PackageBinding {
  readonly reference: string;
  readonly name: string;
  readonly version: string;
  readonly integrity?: string;
  readonly format?: ArtifactPackageFormat;
}

export interface InstanceManifest {
  readonly formatVersion: 1;
  readonly instanceId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly state: 'active' | 'stopped' | 'archived';
}

export interface InstanceBundle<TInput = JsonValue> {
  readonly path: string;
  readonly dataPath: string;
  readonly instance: InstanceManifest;
  readonly packageBinding: PackageBinding & { readonly format: ArtifactPackageFormat };
  readonly input: TInput;
}

async function git(dataPath: string, arguments_: string[]) {
  return execute('git', ['-C', dataPath, ...arguments_], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'runtime@open-artifacts.local',
      GIT_AUTHOR_NAME: 'Open Artifacts Runtime',
      GIT_COMMITTER_EMAIL: 'runtime@open-artifacts.local',
      GIT_COMMITTER_NAME: 'Open Artifacts Runtime',
    },
  });
}

export async function createInstanceBundle<TInput>(options: {
  bundlePath: string;
  name: string;
  packageBinding: PackageBinding;
  input: TInput;
  instanceId?: string;
}): Promise<InstanceBundle<TInput>> {
  const bundlePath = resolve(options.bundlePath);
  if (!bundlePath.endsWith('.openartifact')) {
    throw new RuntimeError(
      'INSTANCE_BUNDLE_PATH_INVALID',
      'Instance Bundle path must end with .openartifact',
    );
  }
  if (await stat(bundlePath).catch(() => undefined)) {
    throw new RuntimeError(
      'INSTANCE_BUNDLE_EXISTS',
      `Instance Bundle already exists: ${bundlePath}`,
    );
  }
  const temporaryPath = `${bundlePath}.creating-${randomUUID()}`;
  const temporaryDataPath = join(temporaryPath, 'data');
  const instance: InstanceManifest = {
    createdAt: new Date().toISOString(),
    formatVersion: 1,
    instanceId: options.instanceId ?? randomUUID(),
    name: options.name,
    state: 'active',
  };
  const packageBinding = {
    ...options.packageBinding,
    format: options.packageBinding.format ?? artifactRuntimeFormat,
  } satisfies InstanceBundle<TInput>['packageBinding'];

  await mkdir(dirname(bundlePath), { mode: 0o700, recursive: true });
  try {
    await mkdir(join(temporaryDataPath, '.oa'), { mode: 0o700, recursive: true });
    await Promise.all([
      writeJsonAtomically(join(temporaryPath, 'instance.json'), instance),
      writeJsonAtomically(join(temporaryPath, 'package.lock.json'), packageBinding),
      writeJsonAtomically(join(temporaryPath, 'input.json'), options.input),
      writeJsonAtomically(join(temporaryPath, 'annotations.json'), {
        annotations: [],
        revision: 0,
      }),
      writeJsonAtomically(join(temporaryPath, 'data-receipts.json'), { receipts: {} }),
      writeJsonAtomically(join(temporaryPath, 'tool-calls.json'), { calls: {} }),
      writeJsonAtomically(join(temporaryDataPath, '.oa', 'schemas.json'), { bindings: {} }),
    ]);
    await git(temporaryDataPath, ['init', '--quiet']);
    await git(temporaryDataPath, ['add', '--all']);
    await git(temporaryDataPath, ['commit', '--quiet', '-m', 'Initialize managed Instance Data']);
    await rename(temporaryPath, bundlePath);
  } catch (error) {
    await rm(temporaryPath, { force: true, recursive: true });
    throw error;
  }

  return {
    dataPath: join(bundlePath, 'data'),
    input: options.input,
    instance,
    packageBinding,
    path: bundlePath,
  };
}

export async function readInstanceBundle(bundlePath: string): Promise<InstanceBundle> {
  const path = resolve(bundlePath);
  const [instance, packageBinding, input] = await Promise.all([
    readJson<InstanceManifest>(join(path, 'instance.json')),
    readJson<InstanceBundle['packageBinding']>(join(path, 'package.lock.json')),
    readJson<JsonValue>(join(path, 'input.json')),
  ]).catch((error: unknown) => {
    throw new RuntimeError(
      'INSTANCE_BUNDLE_INVALID',
      `Could not read Instance Bundle: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (
    instance.formatVersion !== 1 ||
    !instance.instanceId ||
    !['active', 'stopped', 'archived'].includes(instance.state) ||
    !['react-render/v0', artifactRuntimeFormat].includes(packageBinding.format)
  ) {
    throw new RuntimeError('INSTANCE_BUNDLE_INVALID', 'Instance Bundle metadata is invalid');
  }
  const dataPath = join(path, 'data');
  const gitHead = await readFile(join(dataPath, '.git', 'HEAD'), 'utf8').catch(() => undefined);
  if (!gitHead) {
    throw new RuntimeError('INSTANCE_BUNDLE_INVALID', 'Managed Data Git repository is missing');
  }
  return { dataPath, input, instance, packageBinding, path };
}

export async function setInstanceState<TInput>(
  bundle: InstanceBundle<TInput>,
  state: InstanceManifest['state'],
): Promise<InstanceBundle<TInput>> {
  const instance = { ...bundle.instance, state };
  await writeJsonAtomically(join(bundle.path, 'instance.json'), instance);
  return { ...bundle, instance };
}

export async function runGit(dataPath: string, arguments_: string[]) {
  return git(dataPath, arguments_);
}
