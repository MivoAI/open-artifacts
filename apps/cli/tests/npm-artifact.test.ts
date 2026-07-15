import { describe, expect, it } from 'vitest';

import {
  artifactCacheKey,
  parseNpmArtifactReference,
  type NpmArtifactProvenance,
} from '../src/cli/npm-artifact.js';

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
