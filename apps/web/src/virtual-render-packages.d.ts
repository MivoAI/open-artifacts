declare module 'virtual:open-artifacts-render-packages' {
  import type { ComponentType } from 'react';

  interface DiscoveredRenderPackage {
    directory: string;
    Render: ComponentType<{ data: unknown }>;
    example: unknown;
    schema: unknown;
    manifest: unknown;
  }

  const renderPackages: DiscoveredRenderPackage[];
  export default renderPackages;
}
