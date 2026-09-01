import { readFile } from 'node:fs/promises';

import Ajv2020Import from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Constructor } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { artifactPackageManifestSchema } from '../src/cli/artifact-package.js';

describe('Artifact Package manifest schema', () => {
  it('keeps the packed CLI validator aligned with the durable schema document', async () => {
    const documentedSchema = JSON.parse(
      await readFile(
        new URL('../../../docs/spec/artifact-package.v0.schema.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const documentedContract = Object.fromEntries(
      Object.entries(documentedSchema).filter(
        ([key]) => !['$schema', '$id', 'title'].includes(key),
      ),
    );

    expect(artifactPackageManifestSchema).toEqual(documentedContract);
  });

  it('accepts the legacy render format and the scoped runtime format only', () => {
    const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Constructor;
    const validate = new Ajv2020({ strict: true }).compile(artifactPackageManifestSchema);
    const manifest = {
      name: '@open-artifacts/example',
      version: '0.1.0',
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
    };

    expect(validate(manifest)).toBe(true);
    expect(
      validate({
        ...manifest,
        exports: {
          ...manifest.exports,
          './activate': './src/activate.ts',
        },
        openArtifacts: { format: 'react-runtime/v1' },
      }),
    ).toBe(true);
    expect(
      validate({
        ...manifest,
        openArtifacts: { format: 'unknown/v1' },
      }),
    ).toBe(false);
  });
});
