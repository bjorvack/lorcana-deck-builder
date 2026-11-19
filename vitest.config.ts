import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // full-pipeline training runs take 2-8s depending on hardware;
    // the 5s default was flaky on CI runners
    testTimeout: 20_000,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Thresholds are set just below the current baseline so the gate starts
      // green and only tightens; coverage must not regress on new work.
      // Entry points and UI components (App, main, state, ui/) are not gated yet.
      thresholds: {
        'src/rules/**': {
          statements: 91,
          branches: 89,
          functions: 100,
          lines: 91,
        },
        'src/stats/**': {
          statements: 96,
          branches: 85,
          functions: 95,
          lines: 96,
        },
        'src/generate/**': {
          statements: 87,
          branches: 83,
          functions: 100,
          lines: 87,
        },
        'src/meta/**': {
          statements: 95,
          branches: 89,
          functions: 93,
          lines: 95,
        },
        'src/deck/**': {
          statements: 90,
          branches: 80,
          functions: 80,
          lines: 90,
        },
        'src/text/**': {
          statements: 88,
          branches: 77,
          functions: 92,
          lines: 88,
        },
      },
    },
  },
});
