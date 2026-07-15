import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
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
