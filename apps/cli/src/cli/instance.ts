import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

import { readInstanceBundle, setInstanceState } from '@open-artifacts/runtime';

import { CliError } from './errors.js';
import { startArtifactInstanceBundle, type StartInstanceOptions } from './run.js';
import {
  findActiveSessionRecordByInstanceId,
  publishJsonAtomically,
  stopArtifactSession,
} from './session.js';

interface InstanceCommandOptions {
  json: boolean;
}

interface InstanceRegistration {
  bundlePath: string;
  instanceId: string;
  updatedAt: string;
}

class InstanceLifecycleError extends CliError {
  constructor(code: string, message: string) {
    super(code, 'session', message);
  }
}

function registrationsRoot() {
  return resolve(homedir(), '.open-artifacts', 'registrations');
}

function registrationPath(instanceId: string) {
  return resolve(registrationsRoot(), `${instanceId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRegistration(value: unknown): InstanceRegistration | undefined {
  if (
    !isRecord(value) ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    typeof value.bundlePath !== 'string' ||
    !isAbsolute(value.bundlePath) ||
    !value.bundlePath.endsWith('.openartifact') ||
    typeof value.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    return undefined;
  }
  return value as unknown as InstanceRegistration;
}

async function readRegistration(instanceId: string) {
  try {
    return parseRegistration(JSON.parse(await readFile(registrationPath(instanceId), 'utf8')));
  } catch {
    return undefined;
  }
}

async function writeRegistration(instanceId: string, bundlePath: string) {
  await mkdir(registrationsRoot(), { mode: 0o700, recursive: true });
  const registration = {
    bundlePath: resolve(bundlePath),
    instanceId,
    updatedAt: new Date().toISOString(),
  } satisfies InstanceRegistration;
  await publishJsonAtomically(registrationPath(instanceId), registration);
  return registration;
}

async function bundleForId(instanceId: string) {
  const registration = await readRegistration(instanceId);
  if (!registration) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_NOT_FOUND',
      `Unknown Artifact Instance: ${instanceId}`,
    );
  }
  try {
    return await readInstanceBundle(registration.bundlePath);
  } catch {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_BUNDLE_UNAVAILABLE',
      `Artifact Instance Bundle is unavailable; register its current path: ${instanceId}`,
    );
  }
}

async function registerBundle(bundlePath: string) {
  const path = resolve(bundlePath);
  const bundle = await readInstanceBundle(path);
  if (await findActiveSessionRecordByInstanceId(bundle.instance.instanceId)) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Active Artifact Instance cannot be re-registered: ${bundle.instance.instanceId}`,
    );
  }
  await writeRegistration(bundle.instance.instanceId, path);
  return bundle;
}

function writeResult(value: unknown, options: InstanceCommandOptions, message: string) {
  process.stdout.write(options.json ? `${JSON.stringify(value)}\n` : `${message}\n`);
}

export async function listArtifactInstances(options: InstanceCommandOptions) {
  const entries = await readdir(registrationsRoot(), { withFileTypes: true }).catch(() => []);
  const instances = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
          const registration = await readRegistration(entry.name.slice(0, -'.json'.length));
          if (!registration) return undefined;
          try {
            const bundle = await readInstanceBundle(registration.bundlePath);
            return {
              bundlePath: bundle.path,
              instanceId: bundle.instance.instanceId,
              name: bundle.instance.name,
              package: {
                format: bundle.packageBinding.format,
                name: bundle.packageBinding.name,
                version: bundle.packageBinding.version,
              },
              state: bundle.instance.state,
            };
          } catch {
            return {
              bundlePath: registration.bundlePath,
              instanceId: registration.instanceId,
              state: 'unavailable' as const,
            };
          }
        }),
    )
  )
    .filter((instance): instance is NonNullable<typeof instance> => instance !== undefined)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ instances })}\n`);
    return;
  }
  if (instances.length === 0) {
    process.stdout.write('No Artifact Instances.\n');
    return;
  }
  process.stdout.write(
    `Artifact Instances\n${instances
      .map(
        (instance) =>
          `${instance.instanceId}\n  ${'name' in instance ? instance.name : 'Unavailable Bundle'}\n  ${instance.state} · ${instance.bundlePath}`,
      )
      .join('\n')}\n`,
  );
}

export async function startArtifactInstance(identifier: string, options: StartInstanceOptions) {
  const bundle = identifier.endsWith('.openartifact')
    ? await registerBundle(identifier)
    : await bundleForId(identifier);
  if (await findActiveSessionRecordByInstanceId(bundle.instance.instanceId)) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Artifact Instance is already active: ${bundle.instance.instanceId}`,
    );
  }
  await startArtifactInstanceBundle(bundle.path, options);
}

export async function stopArtifactInstance(instanceId: string, options: InstanceCommandOptions) {
  const record = await findActiveSessionRecordByInstanceId(instanceId);
  if (!record) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_NOT_ACTIVE',
      `Artifact Instance is not active: ${instanceId}`,
    );
  }
  await stopArtifactSession(record.sessionId, options);
}

export async function archiveArtifactInstance(instanceId: string, options: InstanceCommandOptions) {
  if (await findActiveSessionRecordByInstanceId(instanceId)) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Active Artifact Instance must be stopped before archive: ${instanceId}`,
    );
  }
  const bundle = await bundleForId(instanceId);
  if (bundle.instance.state !== 'stopped') {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_STATE_INVALID',
      `Only a stopped Artifact Instance can be archived; current state: ${bundle.instance.state}`,
    );
  }
  const archived = await setInstanceState(bundle, 'archived');
  writeResult(
    { instanceId, state: archived.instance.state },
    options,
    `Archived Artifact Instance ${instanceId}.`,
  );
}

export async function restoreArtifactInstance(instanceId: string, options: InstanceCommandOptions) {
  if (await findActiveSessionRecordByInstanceId(instanceId)) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Active Artifact Instance cannot be restored: ${instanceId}`,
    );
  }
  const bundle = await bundleForId(instanceId);
  if (bundle.instance.state !== 'archived') {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_STATE_INVALID',
      `Only an archived Artifact Instance can be restored; current state: ${bundle.instance.state}`,
    );
  }
  const restored = await setInstanceState(bundle, 'stopped');
  writeResult(
    { instanceId, state: restored.instance.state },
    options,
    `Restored Artifact Instance ${instanceId}.`,
  );
}

export async function moveArtifactInstance(
  instanceId: string,
  destination: string,
  options: InstanceCommandOptions,
) {
  if (await findActiveSessionRecordByInstanceId(instanceId)) {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Active Artifact Instance cannot be moved: ${instanceId}`,
    );
  }
  const bundle = await bundleForId(instanceId);
  if (bundle.instance.state === 'active') {
    throw new InstanceLifecycleError(
      'ARTIFACT_INSTANCE_ACTIVE',
      `Artifact Instance state must not be active before move: ${instanceId}`,
    );
  }
  const destinationPath = resolve(destination);
  if (!destinationPath.endsWith('.openartifact')) {
    throw new InstanceLifecycleError(
      'INSTANCE_BUNDLE_PATH_INVALID',
      'Instance Bundle destination must end with .openartifact',
    );
  }
  if (await stat(destinationPath).catch(() => undefined)) {
    throw new InstanceLifecycleError(
      'INSTANCE_BUNDLE_EXISTS',
      `Instance Bundle destination already exists: ${destinationPath}`,
    );
  }
  await mkdir(dirname(destinationPath), { mode: 0o700, recursive: true });
  await rename(bundle.path, destinationPath);
  try {
    await writeRegistration(instanceId, destinationPath);
  } catch (error) {
    await rename(destinationPath, bundle.path);
    throw error;
  }
  writeResult(
    { bundlePath: destinationPath, instanceId, state: bundle.instance.state },
    options,
    `Moved Artifact Instance ${instanceId} to ${destinationPath}.`,
  );
}

export async function registerArtifactInstance(
  bundlePath: string,
  options: InstanceCommandOptions,
) {
  const bundle = await registerBundle(bundlePath);
  writeResult(
    {
      bundlePath: bundle.path,
      instanceId: bundle.instance.instanceId,
      state: bundle.instance.state,
    },
    options,
    `Registered Artifact Instance ${bundle.instance.instanceId}.`,
  );
}
