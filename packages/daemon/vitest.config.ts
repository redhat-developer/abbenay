import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 15000,
    include: [
      'src/**/*.test.ts',            // Unit tests (co-located with source)
      'tests/**/*.test.ts',          // Integration tests
    ],
  },
});
