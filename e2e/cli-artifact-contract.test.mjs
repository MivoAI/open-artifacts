import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const cliEntry = resolve(repositoryRoot, 'apps/cli/dist/cli/index.js');

function buildCli() {
  const result = spawnSync('npm', ['run', 'build', '--workspace', '@open-artifacts/cli'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runCli(arguments_, home) {
  return spawnSync(process.execPath, [cliEntry, ...arguments_], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    timeout: 10_000,
  });
}

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
    writeFile(join(root, 'README.md'), '# Contract fixture\n'),
  ]);

  return root;
}

async function sessionDirectories(home) {
  return readdir(join(home, '.open-artifacts', 'sessions')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

function assertNoRuntimeProcessForHome(home) {
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

test('oa run reports stable Artifact Contract errors before process creation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-contract-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const artifactRoot = await createArtifactPackage(home, {
    manifest: { exports: { '.': './dist/index.js' } },
  });

  const error = parseJsonError(runCli(['run', artifactRoot, '--json', '--no-open'], home));

  assert.equal(error.error.code, 'ARTIFACT_CONTRACT_INVALID');
  assert.equal(error.error.kind, 'contract');
  assert.match(error.error.message, /does not satisfy react-render\/v0/);
  assert.ok(
    error.error.issues.some(
      (issue) => issue.path === '$.exports["."]' && issue.message.includes('./src/index.tsx'),
    ),
  );
  assert.deepEqual(await sessionDirectories(home), []);

  const humanResult = runCli(['run', artifactRoot, '--no-open'], home);
  assert.equal(humanResult.status, 1);
  assert.equal(humanResult.stdout, '');
  assert.match(humanResult.stderr, /^oa: Artifact Contract error:/);
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

      const error = parseJsonError(runCli(['run', artifactRoot, '--json', '--no-open'], home));

      assert.equal(error.error.code, 'ARTIFACT_CONTRACT_INVALID');
      assert.ok(error.error.issues.some((issue) => issue.path === contractCase.expectedPath));
      assert.deepEqual(await sessionDirectories(home), []);
      assertNoRuntimeProcessForHome(home);
    });
  }
});

test('oa run validates Example Input against the Input Contract before process creation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-example-contract-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const artifactRoot = await createArtifactPackage(home, { example: {} });

  const error = parseJsonError(runCli(['run', artifactRoot, '--json', '--no-open'], home));

  assert.equal(error.error.code, 'ARTIFACT_CONTRACT_INVALID');
  assert.ok(
    error.error.issues.some(
      (issue) => issue.path === '$.example.message' && issue.message.includes('required'),
    ),
  );
  assert.deepEqual(await sessionDirectories(home), []);
});

test('oa run distinguishes Runtime startup failure and removes the incomplete Session', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-artifacts-runtime-failure-'));
  t.after(() => rm(home, { force: true, recursive: true }));
  const artifactRoot = await createArtifactPackage(home, {
    source: `import Missing from './missing.tsx';\nexport default Missing;\n`,
  });

  const error = parseJsonError(runCli(['run', artifactRoot, '--json', '--no-open'], home));

  assert.equal(error.error.code, 'ARTIFACT_RUNTIME_START_FAILED');
  assert.equal(error.error.kind, 'runtime');
  assert.match(error.error.message, /failed to start/);
  assert.deepEqual(await sessionDirectories(home), []);
  assertNoRuntimeProcessForHome(home);
});

test('oa help states the trusted-source execution boundary', () => {
  const home = resolve(tmpdir(), 'open-artifacts-help-home');
  const result = runCli(['run', '--help'], home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted Artifact Source/i);
  assert.match(result.stdout, /without a security sandbox/i);
});
