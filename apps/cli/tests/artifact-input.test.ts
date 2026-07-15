import { describe, expect, it } from 'vitest';

import type { ResolvedArtifactPackage } from '../src/cli/artifact-package.js';
import { assertArtifactInputOptions, selectArtifactInput } from '../src/cli/artifact-input.js';

const artifactPackage: ResolvedArtifactPackage = {
  exampleInput: { source: 'example' },
  identity: {
    entryPath: '/artifact/src/index.tsx',
    name: '@open-artifacts/input-fixture',
    root: '/artifact',
    version: '0.0.0',
  },
  validateInput: () => [],
};

describe('Artifact Input selection', () => {
  it.each([
    ['null', null],
    ['false', false],
    ['0', 0],
  ])(
    'preserves the JSON value %s instead of falling back to Example Input',
    async (data, value) => {
      await expect(selectArtifactInput(artifactPackage, { data }, process.cwd())).resolves.toBe(
        value,
      );
    },
  );

  it('rejects ambiguous options before Artifact Package resolution', () => {
    expect(() => assertArtifactInputOptions({ data: '{}', input: './input.json' })).toThrow(
      /cannot be used together/,
    );
  });
});
