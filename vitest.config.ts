import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // full-pipeline training runs take 2-8s depending on hardware;
    // the 5s default was flaky on CI runners
    testTimeout: 20_000,
    environment: 'node',
    environmentOptions: {
      // jsdom only exposes localStorage on a real (non-opaque) origin
      jsdom: { url: 'http://localhost/' },
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
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
          // 90: the engine-winrate worker is an entry-point-like file
          // (driven by postMessage; handler covered, spawn loop exercised
          // via the MockWorker) — full-statement parity is not reachable
          // without testing the transport layer itself
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
        'src/generate/**': {
          statements: 87,
          // 83 was measured with mulberry32 in this directory; the extraction
          // to src/stats/rng.ts shifts the ratio by ~1pt on Node 22 coverage
          branches: 82,
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
          statements: 96,
          branches: 84,
          functions: 95,
          lines: 96,
        },
        'src/text/**': {
          statements: 88,
          branches: 77,
          functions: 92,
          lines: 88,
        },
        'src/ui/**': {
          statements: 80,
          branches: 65,
          functions: 55,
          lines: 80,
        },
      },
    },
  },
});
