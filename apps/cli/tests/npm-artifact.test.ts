import { describe, expect, it } from 'vitest';

import {
  artifactCacheKey,
  npmSubprocessCommand,
  parseNpmArtifactReference,
  sanitizeRegistryUrl,
  type NpmArtifactProvenance,
} from '../src/cli/npm-artifact.js';

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
    name: '@scope/artifact',
    registry: 'https://registry.example.test/',
    resolved: 'https://registry.example.test/@scope/artifact/-/artifact-1.2.3.tgz',
    schemaVersion: 1,
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
  });
});
