import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
    },
    exclude: [...configDefaults.exclude, 'e2e/**', 'evals/**'],
    globals: true,
    include: ['**/*.{test,spec}.{ts,tsx}'],
  },
});
