import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@open-artifacts/sdk/react',
        replacement: fileURLToPath(new URL('../sdk/src/react.ts', import.meta.url)),
      },
      {
        find: '@open-artifacts/sdk',
        replacement: fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
