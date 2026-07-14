import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

const virtualCatalogId = 'virtual:open-artifacts-artifact-packages';
const resolvedVirtualCatalogId = `\0${virtualCatalogId}`;
const packagesRoot = fileURLToPath(new URL('../../packages/', import.meta.url));

interface WorkspacePackageManifest {
  name?: string;
  openArtifacts?: {
    format?: string;
  };
}

function sourceArtifactPackageCatalog(): Plugin {
  return {
    name: 'open-artifacts-source-package-catalog',
    resolveId(id) {
      return id === virtualCatalogId ? resolvedVirtualCatalogId : undefined;
    },
    load(id) {
      if (id !== resolvedVirtualCatalogId) return undefined;

      const artifactPackages = readdirSync(packagesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('artifact-'))
        .map((entry) => {
          const manifest = JSON.parse(
            readFileSync(`${packagesRoot}/${entry.name}/package.json`, 'utf8'),
          ) as WorkspacePackageManifest;
          return { directory: entry.name, manifest };
        })
        .filter(({ manifest }) => manifest.openArtifacts?.format === 'react-render/v0')
        .sort((left, right) => left.directory.localeCompare(right.directory));

      const imports = artifactPackages.flatMap(({ manifest }, index) => {
        if (!manifest.name) throw new Error('Artifact Package is missing its npm name');
        const packageName = JSON.stringify(manifest.name);
        return [
          `import Render${index} from ${packageName};`,
          `import example${index} from ${JSON.stringify(`${manifest.name}/example`)};`,
          `import schema${index} from ${JSON.stringify(`${manifest.name}/schema`)};`,
          `import manifest${index} from ${JSON.stringify(`${manifest.name}/package.json`)};`,
        ];
      });

      const entries = artifactPackages.map(
        ({ directory }, index) =>
          `{ directory: ${JSON.stringify(directory)}, Render: Render${index}, example: example${index}, schema: schema${index}, manifest: manifest${index} }`,
      );

      return `${imports.join('\n')}\nexport default [${entries.join(',\n')}];`;
    },
  };
}

export default defineConfig({
  plugins: [sourceArtifactPackageCatalog(), react()],
});
