import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  absolutizeProjectNpmConfigPaths,
  artifactCacheKey,
  npmSubprocessCommand,
  packageLockGraphDigest,
  packageLockDependencyKey,
  parseNpmArtifactReference,
  sanitizeRegistryUrl,
  withCacheEntryLock,
  type NpmArtifactProvenance,
} from '../src/cli/npm-artifact.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function ownerDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return ownerDirectories(path);
      return entry.name === 'owner.json' ? [dirname(path)] : [];
    }),
  );
  return nested.flat();
}

describe('npm subprocess command', () => {
  it('passes Windows npm arguments through JSON instead of shell interpolation', () => {
    const arguments_ = ['install', 'artifact@1.0.0; Remove-Item C:\\important'];
    const command = npmSubprocessCommand(
      arguments_,
      'win32',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );

    expect(command).toEqual({
      arguments: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('ConvertFrom-Json'),
      ],
      environment: { OA_NPM_ARGUMENTS_JSON: JSON.stringify(arguments_) },
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    expect(command.arguments.join(' ')).not.toContain('Remove-Item');
    expect(npmSubprocessCommand(arguments_, 'darwin')).toEqual({
      arguments: arguments_,
      environment: {},
      executable: 'npm',
    });
    expect(npmSubprocessCommand(arguments_, 'linux')).toEqual({
      arguments: arguments_,
      environment: {},
      executable: 'npm',
    });
  });
});

describe('npm registry provenance', () => {
  it('removes credentials and query tokens from persisted URLs', () => {
    expect(
      sanitizeRegistryUrl('https://user:secret@registry.example.test/npm/?token=secret#fragment'),
    ).toBe('https://registry.example.test/npm/');
  });
});

describe('project npm config paths', () => {
  it('keeps certificate paths relative to the original project config', () => {
    const configDirectory = join(tmpdir(), 'open-artifacts-project');
    const contents = [
      'cafile=/etc/ssl/cert.pem',
      'cafile=./certs/ca.pem',
      '//registry.example.test/:certfile="../client.crt"',
      "//registry.example.test/:keyfile='${CERTIFICATES}/client.key'",
      'registry=https://registry.example.test/',
      'keyfile=~/keys/client.key',
      '',
    ].join('\n');

    const rewritten = absolutizeProjectNpmConfigPaths(contents, configDirectory, {
      CERTIFICATES: 'credentials',
    });

    expect(rewritten).toContain(`cafile=${JSON.stringify(join(configDirectory, 'certs/ca.pem'))}`);
    expect(rewritten).toContain(
      `//registry.example.test/:certfile=${JSON.stringify(join(configDirectory, '../client.crt'))}`,
    );
    expect(rewritten).toContain(
      `//registry.example.test/:keyfile=${JSON.stringify(
        join(configDirectory, 'credentials/client.key'),
      )}`,
    );
    expect(rewritten.match(/^registry=/gm)).toHaveLength(1);
    expect(rewritten.match(/^cafile=/gm)).toHaveLength(3);
    expect(rewritten.match(/^keyfile=/gm)).toHaveLength(1);
  });

  it('preserves npm ini escaping while resolving relative paths', () => {
    const configDirectory = join(tmpdir(), 'open-artifacts-project');
    const rewritten = absolutizeProjectNpmConfigPaths(
      'cafile=./certs/ca\\#one.pem # comment\n',
      configDirectory,
    );

    expect(rewritten).toContain(
      `cafile=${JSON.stringify(join(configDirectory, 'certs/ca#one.pem'))}`,
    );
  });

  it('does not let an earlier relative assignment override a later absolute value', () => {
    const contents = 'cafile=./first.pem\ncafile=/final.pem\n';

    expect(absolutizeProjectNpmConfigPaths(contents, '/project')).toBe(contents);
  });

  it('does not expand environment placeholders a second time in the copied config', () => {
    const configDirectory = join(tmpdir(), 'open-artifacts-project');
    const rewritten = absolutizeProjectNpmConfigPaths(
      String.raw`cafile=./certs/\${NAME}.pem` + '\n',
      configDirectory,
      { NAME: 'expanded' },
    );
    const protectedPlaceholderPath = join(configDirectory, 'certs', String.raw`\${NAME}.pem`);

    expect(rewritten).toContain(`cafile=${JSON.stringify(protectedPlaceholderPath)}`);
  });
});

describe('npm lockfile package keys', () => {
  it.each([
    ['artifact', 'node_modules/artifact'],
    ['@scope/artifact', 'node_modules/@scope/artifact'],
  ])('uses platform-independent slashes for %s', (name, expected) => {
    const key = packageLockDependencyKey(name);

    expect(key).toBe(expected);
    expect(key).not.toContain('\\');
  });
});

describe('npm dependency lock graph identity', () => {
  const root = {
    integrity: 'sha512-root',
    resolved: 'https://registry.example.test/root/-/root-1.0.0.tgz',
    version: '1.0.0',
  };

  it('changes when a transitive dependency resolution changes', () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        'node_modules/root': root,
        'node_modules/transitive': {
          integrity: 'sha512-transitive-a',
          resolved: 'https://registry-a.example.test/transitive/-/transitive-1.0.0.tgz',
          version: '1.0.0',
        },
      },
    };

    expect(packageLockGraphDigest(lock)).not.toBe(
      packageLockGraphDigest({
        ...lock,
        packages: {
          ...lock.packages,
          'node_modules/transitive': {
            ...lock.packages['node_modules/transitive'],
            integrity: 'sha512-transitive-b',
            resolved: 'https://registry-b.example.test/transitive/-/transitive-1.0.0.tgz',
          },
        },
      }),
    );
  });

  it('does not bind credential-bearing URL components', () => {
    const credentialed = {
      lockfileVersion: 3,
      packages: {
        'node_modules/root': {
          ...root,
          resolved:
            'https://user:secret@registry.example.test/root/-/root-1.0.0.tgz?token=secret#fragment',
        },
      },
    };
    const sanitized = {
      lockfileVersion: 3,
      packages: { 'node_modules/root': root },
    };

    expect(packageLockGraphDigest(credentialed)).toBe(packageLockGraphDigest(sanitized));
  });

  it('preserves immutable commit identity for transitive Git dependencies', () => {
    const gitDependency = (commit: string, credentials = '', token = 'secret') => ({
      lockfileVersion: 3,
      packages: {
        'node_modules/root': root,
        'node_modules/transitive-git': {
          resolved: `git+https://${credentials}github.com/example/transitive.git?token=${token}#${commit}`,
          version: '1.0.0',
        },
      },
    });
    const firstCommit = '1111111111111111111111111111111111111111';
    const secondCommit = '2222222222222222222222222222222222222222';

    expect(packageLockGraphDigest(gitDependency(firstCommit))).not.toBe(
      packageLockGraphDigest(gitDependency(secondCommit)),
    );
    expect(packageLockGraphDigest(gitDependency(firstCommit, 'user:secret@', 'token-a'))).toBe(
      packageLockGraphDigest(gitDependency(firstCommit, '', 'token-b')),
    );
  });
});

describe('npm Artifact Reference parsing', () => {
  it.each([
    ['@scope/artifact', '@scope/artifact', 'latest', 'tag'],
    ['@scope/artifact@latest', '@scope/artifact', 'latest', 'tag'],
    ['@scope/artifact@^1.2.0', '@scope/artifact', '^1.2.0', 'range'],
    ['@scope/artifact@1.2.3', '@scope/artifact', '1.2.3', 'version'],
  ] as const)('accepts registry reference %s', (reference, name, selector, type) => {
    expect(parseNpmArtifactReference(reference)).toEqual({ name, selector, type });
  });

  it.each([
    'artifact@npm:other-artifact@1.0.0',
    'github:owner/repository',
    'git+https://example.test/owner/repository.git',
    'https://example.test/artifact.tgz',
    'file:../artifact',
    'workspace:*',
  ])('rejects non-registry reference %s', (reference) => {
    expect(() => parseNpmArtifactReference(reference)).toThrow(
      /registry package name, tag, range, or exact version/,
    );
  });
});

describe('npm Artifact cache identity', () => {
  const provenance: NpmArtifactProvenance = {
    integrity: 'sha512-fixture',
    lockGraphDigest: 'sha256-lock-graph-a',
    name: '@scope/artifact',
    registry: 'https://registry.example.test/',
    resolved: 'https://registry.example.test/@scope/artifact/-/artifact-1.2.3.tgz',
    schemaVersion: 2,
    version: '1.2.3',
  };

  it('is deterministic and includes immutable package provenance', () => {
    expect(artifactCacheKey(provenance)).toBe(artifactCacheKey({ ...provenance }));
    expect(artifactCacheKey({ ...provenance, integrity: 'sha512-other' })).not.toBe(
      artifactCacheKey(provenance),
    );
    expect(artifactCacheKey({ ...provenance, registry: 'https://mirror.example.test/' })).not.toBe(
      artifactCacheKey(provenance),
    );
    expect(artifactCacheKey({ ...provenance, lockGraphDigest: 'sha256-lock-graph-b' })).not.toBe(
      artifactCacheKey(provenance),
    );
  });
});

describe('npm Artifact cache locking', () => {
  it('does not expire an owner while its process is alive', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-lock-test-'));
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    const operations: Promise<unknown>[] = [];

    try {
      operations.push(
        withCacheEntryLock(cacheRoot, 'fixture', async () => {
          firstEntered.resolve();
          await releaseFirst.promise;
        }),
      );
      await firstEntered.promise;

      const [owner] = await ownerDirectories(join(cacheRoot, '.fixture.lock'));
      if (!owner) throw new Error('cache lock owner was not created');
      const oldTimestamp = new Date(Date.now() - 60 * 60_000);
      await utimes(owner, oldTimestamp, oldTimestamp);
      let heartbeatObserved = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await delay(100);
        if ((await stat(owner)).mtimeMs > oldTimestamp.getTime()) {
          heartbeatObserved = true;
          break;
        }
      }
      expect(heartbeatObserved).toBe(true);

      operations.push(
        withCacheEntryLock(cacheRoot, 'fixture', async () => {
          secondEntered.resolve();
          await releaseSecond.promise;
        }),
      );
      expect(await Promise.race([secondEntered.promise.then(() => true), delay(150, false)])).toBe(
        false,
      );

      releaseFirst.resolve();
      await secondEntered.promise;
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled(operations);
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });

  it('reclaims an abandoned owner even when its pid has been reused', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-lock-test-'));
    const token = 'owner-abandoned';
    const owner = join(cacheRoot, '.fixture.lock', token);

    try {
      await mkdir(owner, { recursive: true });
      await writeFile(
        join(owner, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, token })}\n`,
      );
      const oldTimestamp = new Date(Date.now() - 60 * 60_000);
      await utimes(owner, oldTimestamp, oldTimestamp);

      let entered = false;
      await withCacheEntryLock(cacheRoot, 'fixture', async () => {
        entered = true;
      });
      expect(entered).toBe(true);
    } finally {
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });

  it('does not let a stale owner release a successor lock', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'open-artifacts-lock-test-'));
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    const thirdEntered = deferred();
    const releaseThird = deferred();
    const operations: Promise<unknown>[] = [];

    try {
      const firstOperation = withCacheEntryLock(cacheRoot, 'fixture', async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      operations.push(firstOperation);
      await firstEntered.promise;

      const lockRoot = join(cacheRoot, '.fixture.lock');
      const owners = await ownerDirectories(lockRoot);
      expect(owners).toHaveLength(1);
      const [owner] = owners;
      if (!owner) throw new Error('cache lock owner was not created');
      const ownerFile = join(owner, 'owner.json');
      const ownerMetadata = JSON.parse(await readFile(ownerFile, 'utf8'));
      await writeFile(ownerFile, `${JSON.stringify({ ...ownerMetadata, pid: 2_147_483_647 })}\n`);

      operations.push(
        withCacheEntryLock(cacheRoot, 'fixture', async () => {
          secondEntered.resolve();
          await releaseSecond.promise;
        }),
      );
      await secondEntered.promise;

      operations.push(
        withCacheEntryLock(cacheRoot, 'fixture', async () => {
          thirdEntered.resolve();
          await releaseThird.promise;
        }),
      );
      releaseFirst.resolve();
      await firstOperation;

      expect(await Promise.race([thirdEntered.promise.then(() => true), delay(150, false)])).toBe(
        false,
      );
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      releaseThird.resolve();
      await Promise.allSettled(operations);
      await rm(cacheRoot, { force: true, recursive: true });
    }
  });
});
