import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildCli, repositoryRoot, runBuiltCli } from './helpers/cli.mjs';

async function createArtifactPackage(home, overrides = {}) {
  const root = join(home, overrides.directory ?? 'artifact');
  await mkdir(join(root, 'src'), { recursive: true });

  const manifest = {
    name: '@open-artifacts/contract-fixture',
    version: '0.0.0',
    description: 'Contract fixture',
    type: 'module',
    files: ['src', 'input.schema.json', 'example.json', 'tsconfig.json', 'README.md'],
    exports: {
      '.': './src/index.tsx',
      './schema': './input.schema.json',
      './example': './example.json',
      './package.json': './package.json',
    },
    openArtifacts: { format: 'react-render/v0' },
    peerDependencies: { react: '^19.0.0' },
    ...overrides.manifest,
  };

  await Promise.all([
    writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(
      join(root, 'input.schema.json'),
      `${JSON.stringify(
        overrides.schema ?? {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: { message: { type: 'string' } },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(root, 'example.json'),
      `${JSON.stringify(overrides.example ?? { message: 'valid' })}\n`,
    ),
    writeFile(
      join(root, 'src/index.tsx'),
      overrides.source ??
        'export default function ContractFixture({ data }) { return <h1>{data.message}</h1>; }\n',
    ),
    writeFile(join(root, 'tsconfig.json'), '{}\n'),
    writeFile(
      join(root, 'README.md'),
      '# Contract fixture\n\nRenders Artifact Input shaped as `{ message: string }` with React. React is provided as a peer dependency. Copy the directory to create a Local Fork.\n',
    ),
  ]);

  return root;
}

async function sessionDirectories(home) {
  return readdir(join(home, '.open-artifacts', 'sessions')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function stopSession(home, sessionId) {
  const sessionDirectory = join(home, '.open-artifacts', 'sessions', sessionId);
  const record = JSON.parse(await readFile(join(sessionDirectory, 'record.json'), 'utf8'));
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await rm(sessionDirectory, { force: true, recursive: true });
}

function assertNoSessionProcessForHome(home) {
  const processes = spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' });
  assert.equal(processes.status, 0, processes.stderr);
  assert.doesNotMatch(processes.stdout, new RegExp(home.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

function parseJsonError(result) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  return JSON.parse(result.stderr);
}

test.before(buildCli);

test('oa run accepts standard Input Contracts and memoized React exports', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-contract-compatibility-'));
  let sessionId;
  t.after(async () => {
    if (sessionId) await stopSession(home, sessionId);
    await rm(home, { force: true, recursive: true });
  });
  const artifactRoot = await createArtifactPackage(home, {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { message: { format: 'email' } },
    },
    source: `import { memo } from 'react';
export default memo(function CompatibleFixture({ data }) { return <h1>{data.message}</h1>; });
`,
  });

  const result = runBuiltCli(['run', artifactRoot, '--json', '--no-open'], {
    home,
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const session = JSON.parse(result.stdout);
  sessionId = session.sessionId;
  assert.equal((await globalThis.fetch(session.url)).status, 200);
});

test('oa run reports stable Artifact Package contract errors before process creation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-contract-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const artifactRoot = await createArtifactPackage(home, {
    manifest: { exports: { '.': './dist/index.js' } },
  });

  const error = parseJsonError(
    runBuiltCli(['run', artifactRoot, '--json', '--no-open'], { home, timeout: 10_000 }),
  );

  assert.equal(error.error.code, 'ARTIFACT_PACKAGE_CONTRACT_INVALID');
  assert.equal(error.error.kind, 'contract');
  assert.match(error.error.message, /does not satisfy react-render\/v0/);
  assert.ok(
    error.error.issues.some(
      (issue) => issue.path === '$.exports["."]' && issue.message.includes('./src/index.tsx'),
    ),
  );
  assert.deepEqual(await sessionDirectories(home), []);

  const humanResult = runBuiltCli(['run', artifactRoot, '--no-open'], {
    home,
    timeout: 10_000,
  });
  assert.equal(humanResult.status, 1);
  assert.equal(humanResult.stdout, '');
  assert.match(humanResult.stderr, /^oa: Artifact Package contract error:/);
  assert.doesNotMatch(humanResult.stderr, /file:\/\/|\n\s+at /);
});

test('oa run rejects each required Artifact Package Contract boundary', async (t) => {
  const cases = [
    {
      name: 'missing manifest',
      arrange: async (home) => {
        const root = join(home, 'missing-manifest');
        await mkdir(root, { recursive: true });
        return root;
      },
      expectedPath: '$.packageJson',
    },
    {
      name: 'unsupported format',
      arrange: (home) =>
        createArtifactPackage(home, { manifest: { openArtifacts: { format: 'unknown/v0' } } }),
      expectedPath: '$.openArtifacts.format',
    },
    {
      name: 'manifest symlink escaping the Package',
      arrange: async (home) => {
        const root = await createArtifactPackage(home);
        const manifestPath = join(root, 'package.json');
        const externalManifest = join(home, 'external-package.json');
        await writeFile(externalManifest, await readFile(manifestPath, 'utf8'));
        await rm(manifestPath);
        await symlink(externalManifest, manifestPath);
        return root;
      },
      expectedPath: '$.packageJson',
    },
    {
      name: 'missing canonical exports',
      arrange: (home) => createArtifactPackage(home, { manifest: { exports: {} } }),
      expectedPath: '$.exports["."]',
    },
    {
      name: 'missing editable source',
      arrange: async (home) => {
        const root = await createArtifactPackage(home);
        await rm(join(root, 'src/index.tsx'));
        return root;
      },
      expectedPath: '$.files["src/index.tsx"]',
    },
    {
      name: 'source symlink escaping the Package',
      arrange: async (home) => {
        const root = await createArtifactPackage(home);
        const externalSource = join(home, 'external.tsx');
        await writeFile(externalSource, 'export default function External() { return null; }\n');
        await rm(join(root, 'src/index.tsx'));
        await symlink(externalSource, join(root, 'src/index.tsx'));
        return root;
      },
      expectedPath: '$.files["src/index.tsx"]',
    },
    {
      name: 'source without a default export',
      arrange: (home) =>
        createArtifactPackage(home, {
          source: 'export function NamedRender() { return <main />; }\n',
        }),
      expectedPath: '$.exports["."]',
    },
    {
      name: 'default export that is not a React component',
      arrange: (home) =>
        createArtifactPackage(home, {
          source: 'export default 42;\n',
        }),
      expectedPath: '$.exports["."]',
    },
    {
      name: 'Example Input that throws during the smoke Render',
      arrange: (home) =>
        createArtifactPackage(home, {
          source: 'export default function Broken({ data }) { throw new Error(data.message); }\n',
        }),
      expectedPath: '$.example',
    },
    {
      name: 'wrong JSON Schema draft',
      arrange: (home) =>
        createArtifactPackage(home, {
          schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
        }),
      expectedPath: '$.inputContract.$schema',
    },
    {
      name: 'React implementation dependency',
      arrange: (home) =>
        createArtifactPackage(home, { manifest: { dependencies: { react: '^19.0.0' } } }),
      expectedPath: '$.dependencies.react',
    },
  ];

  for (const contractCase of cases) {
    await t.test(contractCase.name, async (subtest) => {
      const home = await mkdtemp(join(tmpdir(), 'open-artifacts-contract-boundary-'));
      subtest.after(() => rm(home, { force: true, recursive: true }));
      const artifactRoot = await contractCase.arrange(home);

      const error = parseJsonError(
        runBuiltCli(['run', artifactRoot, '--json', '--no-open'], {
          home,
          timeout: 10_000,
        }),
      );

      assert.equal(error.error.code, 'ARTIFACT_PACKAGE_CONTRACT_INVALID');
      assert.ok(error.error.issues.some((issue) => issue.path === contractCase.expectedPath));
      assert.deepEqual(await sessionDirectories(home), []);
      assertNoSessionProcessForHome(home);
    });
  }
});

test('oa run validates Example Input against the Input Contract before process creation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-example-contract-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const artifactRoot = await createArtifactPackage(home, { example: {} });

  const error = parseJsonError(
    runBuiltCli(['run', artifactRoot, '--json', '--no-open'], { home, timeout: 10_000 }),
  );

  assert.equal(error.error.code, 'ARTIFACT_PACKAGE_CONTRACT_INVALID');
  assert.ok(
    error.error.issues.some(
      (issue) => issue.path === '$.example.message' && issue.message.includes('required'),
    ),
  );
  assert.deepEqual(await sessionDirectories(home), []);
});

test('oa run reports startup failure and removes the incomplete Artifact Session', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-session-failure-'));
  const cliCopyRoot = await mkdtemp(
    join(resolve(repositoryRoot, 'apps/cli'), '.runtime-failure-cli-'),
  );
  t.after(async () => {
    await Promise.all([
      rm(home, { force: true, recursive: true }),
      rm(cliCopyRoot, { force: true, recursive: true }),
    ]);
  });
  const artifactRoot = await createArtifactPackage(home);
  await cp(resolve(repositoryRoot, 'apps/cli/dist'), join(cliCopyRoot, 'dist'), {
    recursive: true,
  });
  await writeFile(
    join(cliCopyRoot, 'dist/runtime/index.js'),
    'throw new Error("injected failure before readiness");\n',
  );
  const cliEntry = join(cliCopyRoot, 'dist/cli/index.js');

  const error = parseJsonError(
    runBuiltCli(['run', artifactRoot, '--json', '--no-open'], {
      entry: cliEntry,
      home,
      timeout: 10_000,
    }),
  );

  assert.equal(error.error.code, 'ARTIFACT_SESSION_START_FAILED');
  assert.equal(error.error.kind, 'session');
  assert.match(error.error.message, /failed to start/);
  assert.deepEqual(await sessionDirectories(home), []);
  assertNoSessionProcessForHome(home);

  const humanResult = runBuiltCli(['run', artifactRoot, '--no-open'], {
    entry: cliEntry,
    home,
    timeout: 10_000,
  });
  assert.equal(humanResult.status, 1);
  assert.equal(humanResult.stdout, '');
  assert.match(humanResult.stderr, /^oa: Artifact Session error:/);
  assert.doesNotMatch(humanResult.stderr, /file:\/\/|\n\s+at /);
  assertNoSessionProcessForHome(home);
});

test('oa help states the trusted-source execution boundary', () => {
  const home = resolve(tmpdir(), 'open-artifacts-help-home');
  const result = runBuiltCli(['run', '--help'], { home, timeout: 10_000 });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted Artifact Source/i);
  assert.match(result.stdout, /without a security sandbox/i);
});
