import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cf-wasm/resvg': path.resolve(import.meta.dirname, 'tests/helpers/stubs/resvg.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/unit/_setup.ts'],
    globals: false,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: 'unit-report.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: 'coverage/unit',
      include: [
        'src/ssr/**/*.ts',
        'src/utils/**/*.ts',
        'src/api/**/*.ts',
        'src/oembed/**/*.ts',
        'worker/**/*.ts',
      ],
      exclude: [
        'src/utils/image-generation.ts',
      ],
      // Ratchet gate — fails the run if aggregate unit coverage drops below
      // these floors. Raise them (never lower) in a PR that adds tests; the
      // goal is a monotonically-non-decreasing ratchet toward 100%. See
      // AGENTS.md「測試架構重點」for the workflow.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
