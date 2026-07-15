import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveLocalArtifactPackage } from '../src/cli/artifact-package.js';
import { waitForRuntime } from '../src/cli/run.js';

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

async function createArtifactFixture(
  format = 'react-render/v0',
  source = 'export default function UnitFixture({ data }: { data: unknown }) { void data; return null; }\n',
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-unit-'));
  const artifactRoot = join(fixtureRoot, 'artifact');
  temporaryDirectories.push(fixtureRoot);
  await mkdir(join(artifactRoot, 'src'), { recursive: true });
  await writeFile(
    join(artifactRoot, 'package.json'),
    `${JSON.stringify({
      files: ['src', 'input.schema.json', 'example.json', 'tsconfig.json', 'README.md'],
      exports: {
        '.': './src/index.tsx',
        './schema': './input.schema.json',
        './example': './example.json',
        './package.json': './package.json',
      },
      name: '@open-artifacts/unit-fixture',
      openArtifacts: { format },
      peerDependencies: { react: '^19.0.0' },
      type: 'module',
      version: '0.0.0',
    })}\n`,
  );
  await Promise.all([
    writeFile(join(artifactRoot, 'example.json'), '{"message":"hello"}\n'),
    writeFile(
      join(artifactRoot, 'input.schema.json'),
      `${JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string' } },
      })}\n`,
    ),
    writeFile(
      join(artifactRoot, 'README.md'),
      '# Unit fixture\n\nRenders Artifact Input shaped as `{ message: string }` with React. React is provided as a peer dependency. Copy the directory to create a Local Fork.\n',
    ),
    writeFile(join(artifactRoot, 'tsconfig.json'), '{}\n'),
    writeFile(join(artifactRoot, 'src/index.tsx'), source),
  ]);
  return { artifactRoot, fixtureRoot };
}

describe('local Artifact Package resolution', () => {
  it('resolves explicit relative references and loads Package-owned Example Input', async () => {
    const fixture = await createArtifactFixture();
    const artifactPackage = await resolveLocalArtifactPackage('./artifact', fixture.fixtureRoot);

    expect(artifactPackage.identity).toMatchObject({
      name: '@open-artifacts/unit-fixture',
      version: '0.0.0',
    });
    expect(artifactPackage.identity.root).toBe(
      await import('node:fs/promises').then(({ realpath }) => realpath(fixture.artifactRoot)),
    );
    expect(artifactPackage.exampleInput).toEqual({ message: 'hello' });
  });

  it('accepts the current directory as an explicit local Artifact Reference', async () => {
    const fixture = await createArtifactFixture();

    await expect(resolveLocalArtifactPackage('.', fixture.artifactRoot)).resolves.toMatchObject({
      identity: { name: '@open-artifacts/unit-fixture' },
    });
  });

  it('keeps bare npm-like references outside the local tracer bullet', async () => {
    await expect(resolveLocalArtifactPackage('@scope/package', process.cwd())).rejects.toThrow(
      /Only explicit local Artifact References are currently supported/,
    );
  });

  it('rejects an unsupported Artifact format before creating a Session', async () => {
    const fixture = await createArtifactFixture('render-package/v0');

    await expect(
      resolveLocalArtifactPackage(fixture.artifactRoot, fixture.fixtureRoot),
    ).rejects.toThrow(/does not satisfy react-render\/v0/);
  });

  it('accepts a valid Input Contract without applying OA-internal strict lint rules', async () => {
    const fixture = await createArtifactFixture();
    await writeFile(
      join(fixture.artifactRoot, 'input.schema.json'),
      `${JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { message: { format: 'email' } },
      })}\n`,
    );

    await expect(
      resolveLocalArtifactPackage(fixture.artifactRoot, fixture.fixtureRoot),
    ).resolves.toMatchObject({ identity: { name: '@open-artifacts/unit-fixture' } });
  });

  it('accepts a memoized React component as the default Artifact Source export', async () => {
    const fixture = await createArtifactFixture(
      'react-render/v0',
      `import { memo } from 'react';
export default memo(function MemoFixture({ data }: { data: { message: string } }) {
  return <p>{data.message}</p>;
});
`,
    );

    await expect(
      resolveLocalArtifactPackage(fixture.artifactRoot, fixture.fixtureRoot),
    ).resolves.toMatchObject({ identity: { name: '@open-artifacts/unit-fixture' } });
  });

  it('rejects a default export that is not a React component', async () => {
    const fixture = await createArtifactFixture('react-render/v0', 'export default 42;\n');

    await expect(
      resolveLocalArtifactPackage(fixture.artifactRoot, fixture.fixtureRoot),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: 'default export must be a React component' })],
    });
  });

  it('rejects an Example Input that cannot complete a smoke Render', async () => {
    const fixture = await createArtifactFixture(
      'react-render/v0',
      `export default function Broken({ data }: { data: { message: string } }) { throw new Error(data.message); }\n`,
    );

    await expect(
      resolveLocalArtifactPackage(fixture.artifactRoot, fixture.fixtureRoot),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          message: 'Example Input must complete a smoke Render through the default export',
        }),
      ],
    });
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

  it('rejects a Runtime whose Render entry fails preflight', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-preflight-failure-'));
    temporaryDirectories.push(fixtureRoot);
    const readyFile = join(fixtureRoot, 'ready.json');
    const server = createServer((request, response) => {
      response.statusCode = request.url === '/__oa/preflight' ? 500 : 200;
      response.end(request.url === '/__oa/preflight' ? 'Render import failed' : 'ok');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    await writeFile(
      readyFile,
      JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${address.port}/` }),
    );

    try {
      await expect(waitForRuntime(readyFile, process.pid)).rejects.toThrow(
        /Artifact Render preflight failed: Render import failed/,
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});
