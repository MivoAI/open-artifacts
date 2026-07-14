declare module 'virtual:open-artifacts-artifact-packages' {
  import type { ComponentType } from 'react';

  interface DiscoveredArtifactPackage {
    directory: string;
    Render: ComponentType<{ data: unknown }>;
    example: unknown;
    schema: unknown;
    manifest: unknown;
  }

  const artifactPackages: DiscoveredArtifactPackage[];
  export default artifactPackages;
}
