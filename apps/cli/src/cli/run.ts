import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  ArtifactIdentity,
  RuntimeReadyState,
  SessionRuntimeConfig,
} from '../runtime/config.js';
import { resolveLocalArtifactPackage } from './artifact-package.js';
import { ArtifactSessionStartError } from './errors.js';

interface RunOptions {
  json: boolean;
  open: boolean;
}

interface SessionRecord {
  artifact: ArtifactIdentity;
  pid: number;
  sessionId: string;
  startedAt: string;
  url: string;
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
): Promise<RuntimeReadyState> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (!isProcessRunning(childPid)) {
      throw new Error('local runtime exited before Artifact Session readiness');
    }
    const ready = await readFile(readyFile, 'utf8')
      .then((value) => JSON.parse(value) as RuntimeReadyState)
      .catch(() => undefined);

    if (ready) {
      if (ready.pid !== childPid) throw new Error('local runtime process identity mismatch');
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

  throw new Error('Artifact Session did not become ready within 20 seconds');
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

async function terminateFailedRuntime(child: ChildProcess) {
  if (await waitForChildExit(child, 0)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 1_000);
}

function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const arguments_ = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, arguments_, { detached: true, stdio: 'ignore' });
  child.unref();
}

export async function runArtifactPackage(reference: string, options: RunOptions) {
  const artifactPackage = await resolveLocalArtifactPackage(reference, process.cwd());
  const sessionId = randomUUID();
  const sessionDirectory = resolve(homedir(), '.open-artifacts', 'sessions', sessionId);
  const readyFile = resolve(sessionDirectory, 'ready.json');
  const runtimeConfig: SessionRuntimeConfig = {
    artifact: artifactPackage.identity,
    exampleInput: artifactPackage.exampleInput,
    readyFile,
    sessionDirectory,
    sessionId,
  };

  const configPath = resolve(sessionDirectory, 'runtime.json');
  const logPath = resolve(sessionDirectory, 'runtime.log');
  const runtimeEntry = fileURLToPath(new URL('../runtime/index.js', import.meta.url));
  let child: ChildProcess | undefined;

  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`);
    const log = await open(logPath, 'a');
    child = spawn(process.execPath, [runtimeEntry, configPath], {
      cwd: artifactPackage.identity.root,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await log.close();
    const childPid = child.pid;
    if (!childPid) throw new Error('local runtime process did not start');

    const ready = await Promise.race([
      waitForRuntime(readyFile, childPid),
      new Promise<never>((_resolve, reject) => child?.once('error', reject)),
    ]);
    const record: SessionRecord = {
      artifact: artifactPackage.identity,
      pid: ready.pid,
      sessionId,
      startedAt: new Date().toISOString(),
      url: ready.url,
    };
    await writeFile(
      resolve(sessionDirectory, 'record.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    );
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
    if (child) await terminateFailedRuntime(child);
    await rm(sessionDirectory, { force: true, recursive: true });
    throw new ArtifactSessionStartError();
  }
}
