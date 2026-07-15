import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  ArtifactIdentity,
  RuntimeReadyState,
  SessionRuntimeConfig,
} from '../runtime/config.js';

interface ArtifactManifest {
  exports?: Record<string, string>;
  name?: string;
  openArtifacts?: {
    format?: string;
  };
  version?: string;
}

interface RunOptions {
  json: boolean;
  open: boolean;
}

interface ResolvedArtifactPackage {
  exampleInput: unknown;
  identity: ArtifactIdentity;
}

interface SessionRecord {
  artifact: ArtifactIdentity;
  pid: number;
  sessionId: string;
  startedAt: string;
  url: string;
}

function resolvePackageFile(root: string, packagePath: string) {
  const resolved = resolve(root, packagePath);
  const pathWithinPackage = relative(root, resolved);
  if (pathWithinPackage.startsWith('..') || isAbsolute(pathWithinPackage)) {
    throw new Error(`Artifact Package export leaves the package root: ${packagePath}`);
  }
  return resolved;
}

export async function resolveLocalArtifactPackage(
  reference: string,
  cwd: string,
): Promise<ResolvedArtifactPackage> {
  const isExplicitRelative =
    reference === '.' ||
    reference === '..' ||
    reference.startsWith('./') ||
    reference.startsWith('../');
  if (!isExplicitRelative && !isAbsolute(reference)) {
    throw new Error(
      `Issue #3 supports explicit local Artifact References only; received: ${reference}`,
    );
  }

  const root = await realpath(resolve(cwd, reference));
  if (!(await stat(root)).isDirectory())
    throw new Error(`Artifact Reference is not a directory: ${root}`);

  const manifest = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  ) as ArtifactManifest;
  if (manifest.openArtifacts?.format !== 'react-render/v0') {
    throw new Error(`Unsupported Artifact Package format in ${root}`);
  }
  if (!manifest.name || !manifest.version)
    throw new Error(`Artifact Package identity is missing in ${root}`);

  const entryExport = manifest.exports?.['.'];
  const exampleExport = manifest.exports?.['./example'];
  if (!entryExport || !exampleExport)
    throw new Error(`Artifact Package exports are incomplete in ${root}`);

  return {
    exampleInput: JSON.parse(await readFile(resolvePackageFile(root, exampleExport), 'utf8')),
    identity: {
      entryPath: resolvePackageFile(root, entryExport),
      name: manifest.name,
      root,
      version: manifest.version,
    },
  };
}

export async function waitForRuntime(
  readyFile: string,
  childPid: number,
): Promise<RuntimeReadyState> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const ready = await readFile(readyFile, 'utf8')
      .then((value) => JSON.parse(value) as RuntimeReadyState)
      .catch(() => undefined);

    if (ready) {
      if (ready.pid !== childPid) throw new Error('Artifact Session Runtime identity mismatch');
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

  await mkdir(sessionDirectory, { recursive: true });
  const configPath = resolve(sessionDirectory, 'runtime.json');
  const logPath = resolve(sessionDirectory, 'runtime.log');
  await writeFile(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`);
  const log = await open(logPath, 'a');
  const runtimeEntry = fileURLToPath(new URL('../runtime/index.js', import.meta.url));
  const child = spawn(process.execPath, [runtimeEntry, configPath], {
    cwd: artifactPackage.identity.root,
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();

  if (!child.pid) {
    await rm(sessionDirectory, { force: true, recursive: true });
    throw new Error('Artifact Session Runtime process did not start');
  }

  try {
    const ready = await waitForRuntime(readyFile, child.pid);
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
  } catch (error) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // The Runtime already exited.
    }
    await rm(sessionDirectory, { force: true, recursive: true });
    throw error;
  }
}
