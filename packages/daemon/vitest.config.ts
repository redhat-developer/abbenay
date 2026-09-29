import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Several tests exercise process-wide native-module loading and module
    // cache resets. Running files concurrently can let those test doubles
    // observe each other's module state.
    fileParallelism: false,
    server: {
      deps: {
        inline: ['keytar'],
      },
    },
    testTimeout: 30000,
    hookTimeout: 15000,
    include: [
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'tests/**'],
    },
  },
});
