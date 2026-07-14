import { resolve } from 'node:path';

import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

describe('Workbench Artifact Package discovery', () => {
  it('loads the canonical workspace packages through the Vite catalog', async () => {
    const server = await createServer({
      configFile: resolve('apps/web/vite.config.ts'),
      root: resolve('apps/web'),
      server: { middlewareMode: true },
    });

    try {
      const module = (await server.ssrLoadModule('/src/artifact-registry.ts')) as {
        artifactPackages: Array<{ directory: string; name: string }>;
      };

      expect(module.artifactPackages.map(({ directory, name }) => ({ directory, name }))).toEqual(
        expect.arrayContaining([
          {
            directory: 'artifact-decision-board',
            name: '@open-artifacts/decision-board',
          },
          {
            directory: 'artifact-evidence-trace',
            name: '@open-artifacts/evidence-trace',
          },
        ]),
      );
    } finally {
      await server.close();
    }
  });
});
