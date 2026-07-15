import { readFile } from 'node:fs/promises';

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
});
