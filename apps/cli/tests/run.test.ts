import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLocalArtifact, waitForRuntime } from '../src/cli/run.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

async function createArtifactFixture(format = 'react-render/v0') {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-unit-'));
  const artifactRoot = join(fixtureRoot, 'artifact');
  temporaryDirectories.push(fixtureRoot);
  await mkdir(join(artifactRoot, 'src'), { recursive: true });
  await writeFile(
    join(artifactRoot, 'package.json'),
    `${JSON.stringify({
      exports: {
        '.': './src/index.tsx',
        './example': './example.json',
      },
      name: '@open-artifacts/unit-fixture',
      openArtifacts: { format },
      type: 'module',
      version: '0.0.0',
    })}\n`,
  );
  await writeFile(join(artifactRoot, 'example.json'), '{"message":"hello"}\n');
  await writeFile(
    join(artifactRoot, 'src/index.tsx'),
    'export default function UnitFixture() { return null; }\n',
  );
  return { artifactRoot, fixtureRoot };
}

describe('local Artifact resolution', () => {
  it('resolves explicit relative references and loads Package-owned Example Input', async () => {
    const fixture = await createArtifactFixture();
    const artifact = await resolveLocalArtifact('./artifact', fixture.fixtureRoot);

    expect(artifact.identity).toMatchObject({
      name: '@open-artifacts/unit-fixture',
      version: '0.0.0',
    });
    expect(artifact.identity.root).toBe(
      await import('node:fs/promises').then(({ realpath }) => realpath(fixture.artifactRoot)),
    );
    expect(artifact.exampleData).toEqual({ message: 'hello' });
  });

  it('keeps bare npm-like references outside the local tracer bullet', async () => {
    await expect(resolveLocalArtifact('@scope/package', process.cwd())).rejects.toThrow(
      /explicit local Artifact References only/,
    );
  });

  it('rejects an unsupported Artifact format before creating a Session', async () => {
    const fixture = await createArtifactFixture('render-package/v0');

    await expect(resolveLocalArtifact(fixture.artifactRoot, fixture.fixtureRoot)).rejects.toThrow(
      /Unsupported Artifact Package format/,
    );
  });
});

describe('Runtime readiness', () => {
  it('returns only after the matching Runtime health endpoint is reachable', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-ready-'));
    temporaryDirectories.push(fixtureRoot);
    const readyFile = join(fixtureRoot, 'session', 'ready.json');
    await mkdir(dirname(readyFile), { recursive: true });
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end('ok');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const ready = { pid: process.pid, url: `http://127.0.0.1:${address.port}/` };
    await writeFile(readyFile, JSON.stringify(ready));

    try {
      await expect(waitForRuntime(readyFile, process.pid)).resolves.toEqual(ready);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });

  it('rejects a ready file owned by a different process', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-ready-mismatch-'));
    temporaryDirectories.push(fixtureRoot);
    const readyFile = join(fixtureRoot, 'ready.json');
    await writeFile(readyFile, JSON.stringify({ pid: process.pid + 1, url: 'http://127.0.0.1/' }));

    await expect(waitForRuntime(readyFile, process.pid)).rejects.toThrow(/identity mismatch/);
  });
});
