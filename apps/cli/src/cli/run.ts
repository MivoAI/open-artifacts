import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { RuntimeReadyState, SessionRuntimeConfig } from '../runtime/config.js';
import {
  assertArtifactInputOptions,
  selectArtifactInput,
  type ArtifactInputOptions,
} from './artifact-input.js';
import { resolveLocalArtifactPackage } from './artifact-package.js';
import { ArtifactSessionCleanupError, ArtifactSessionStartError } from './errors.js';
import {
  publishJsonAtomically,
  readProcessSignature,
  readRuntimeReadyState,
  requestRuntimeShutdown,
  type SessionRecord,
} from './session.js';

interface RunOptions extends ArtifactInputOptions {
  json: boolean;
  open: boolean;
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForRuntime(
  readyFile: string,
  childPid: number,
  instanceId: string,
): Promise<RuntimeReadyState> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (!isProcessRunning(childPid)) {
      throw new Error('Artifact Session Runtime exited before readiness');
    }
    const ready = await readFile(readyFile, 'utf8')
      .then((value) => JSON.parse(value) as RuntimeReadyState)
      .catch(() => undefined);

    if (ready) {
      if (ready.pid !== childPid) throw new Error('Artifact Session Runtime identity mismatch');
      if (ready.instanceId !== instanceId) {
        throw new Error('Artifact Session Runtime instance mismatch');
      }
      const [pageResponse, preflightResponse] = await Promise.all([
        fetch(ready.url).catch(() => undefined),
        fetch(`${ready.url}__oa/preflight`).catch(() => undefined),
      ]);
      if (pageResponse?.ok && preflightResponse?.ok) return ready;
      if (preflightResponse && preflightResponse.status >= 500) {
        throw new Error(`Artifact Render preflight failed: ${await preflightResponse.text()}`);
      }
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }

  throw new Error('Artifact Session Runtime did not become ready within 20 seconds');
}

function waitForChildExit(child: ChildProcess, timeout: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise<boolean>((resolveExit) => {
    const timeoutId = setTimeout(() => {
      child.removeListener('exit', handleExit);
      resolveExit(false);
    }, timeout);
    const handleExit = () => {
      clearTimeout(timeoutId);
      resolveExit(true);
    };
    child.once('exit', handleExit);
  });
}

export async function terminateFailedRuntime(
  child: ChildProcess,
  readyFile: string,
  instanceToken: string,
  gracefulTimeoutMs = 3_000,
  forceTimeoutMs = 1_000,
  requestShutdown: typeof requestRuntimeShutdown = requestRuntimeShutdown,
  platform: NodeJS.Platform = process.platform,
) {
  if (await waitForChildExit(child, 0)) return true;

  const ready = await readRuntimeReadyState(readyFile);
  if (ready && ready.pid === child.pid) {
    await requestShutdown(ready, instanceToken);
  }
  if (await waitForChildExit(child, 0)) return true;
  if (platform !== 'win32') {
    child.kill('SIGTERM');
  }
  if (await waitForChildExit(child, gracefulTimeoutMs)) return true;

  child.kill('SIGKILL');
  return waitForChildExit(child, forceTimeoutMs);
}

function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const arguments_ = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, arguments_, { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function runArtifactPackage(reference: string, options: RunOptions) {
  assertArtifactInputOptions(options);
  const invocationCwd = process.cwd();
  const artifactPackage = await resolveLocalArtifactPackage(reference, invocationCwd);
  const artifactInput = await selectArtifactInput(artifactPackage, options, invocationCwd);
  const sessionId = randomUUID();
  const instanceToken = randomBytes(32).toString('hex');
  const instanceId = createHash('sha256').update(instanceToken).digest('hex');
  const sessionDirectory = resolve(homedir(), '.open-artifacts', 'sessions', sessionId);
  const instanceSecretFile = resolve(sessionDirectory, 'instance.secret');
  const readyFile = resolve(sessionDirectory, 'ready.json');
  const runtimeConfig: SessionRuntimeConfig = {
    artifact: artifactPackage.identity,
    artifactInput,
    instanceId,
    instanceSecretFile,
    readyFile,
    sessionDirectory,
    sessionId,
  };

  const configPath = resolve(sessionDirectory, 'runtime.json');
  const logPath = resolve(sessionDirectory, 'runtime.log');
  const runtimeEntry = fileURLToPath(new URL('../runtime/index.js', import.meta.url));
  let child: ChildProcess | undefined;
  let childPid: number | undefined;

  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(instanceSecretFile, `${instanceToken}\n`, { mode: 0o600 });
    await writeFile(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`);
    const log = await open(logPath, 'a');
    child = spawn(process.execPath, [runtimeEntry, configPath], {
      cwd: artifactPackage.identity.root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    childPid = child.pid;
    if (!childPid) throw new Error('Artifact Session Runtime process did not start');

    const ready = await Promise.race([
      waitForRuntime(readyFile, childPid, instanceId),
      new Promise<never>((_resolve, reject) => child?.once('error', reject)),
    ]);
    const processSignature = await readProcessSignature(childPid);
    if (!processSignature) {
      throw new Error('Artifact Session Runtime process identity is unavailable');
    }
    const record: SessionRecord = {
      artifact: artifactPackage.identity,
      instanceId,
      pid: ready.pid,
      processSignature,
      sessionId,
      startedAt: new Date().toISOString(),
      url: ready.url,
    };
    await publishJsonAtomically(resolve(sessionDirectory, 'record.json'), record);
    child.unref();

    const result = {
      artifact: {
        name: artifactPackage.identity.name,
        root: artifactPackage.identity.root,
        version: artifactPackage.identity.version,
      },
      sessionId,
      url: ready.url,
    };

    if (options.open) openBrowser(ready.url);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `Artifact Session ${sessionId}\n${artifactPackage.identity.name}\n${ready.url}\n`,
    );
  } catch {
    if (child) {
      const stopped = await terminateFailedRuntime(child, readyFile, instanceToken).catch(
        () => false,
      );
      if (!stopped && childPid) throw new ArtifactSessionCleanupError(sessionId, childPid);
    }
    await rm(sessionDirectory, { force: true, recursive: true });
    throw new ArtifactSessionStartError();
  }
}
