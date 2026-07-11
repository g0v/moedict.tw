import { defineConfig } from 'vitest/config';
import path from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @lit/react ships a Node/SSR build (no useLayoutEffect event wiring) and
    // a browser build. Vitest/Node resolves the Node export by default, which
    // breaks onClick for @m3e/react wrappers (m3e-icon-button, m3e-button, …).
    // Force the browser build + inline those deps so nested imports honor this.
    alias: {
      '@cf-wasm/resvg': path.resolve(import.meta.dirname, 'tests/helpers/stubs/resvg.ts'),
      '@lit/react': path.resolve(import.meta.dirname, 'node_modules/@lit/react/index.js'),
    },
    conditions: ['browser', 'module', 'import', 'default'],
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
    server: {
      deps: {
        inline: [/@m3e\/react/, /@lit\/react/],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: 'coverage/unit',
      include: [
        'src/ssr/**/*.ts',
        'src/utils/**/*.ts',
        'src/api/**/*.ts',
        'worker/**/*.ts',
      ],
      exclude: [
        'src/utils/image-generation.ts',
      ],
      // Ratchet gate — fails the run if aggregate unit coverage drops below
      // these floors. Raise them (never lower) in a PR that adds tests; the
      // goal is a monotonically-non-decreasing ratchet toward 100%. See
      // CLAUDE.md "Combined coverage across tiers" for the workflow.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
