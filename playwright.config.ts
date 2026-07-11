import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8877);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  expect: {
    // Allow a tiny fraction of pixel difference to absorb sub-pixel AA noise.
    toHaveScreenshot: {
      maxDiffPixels: 150,
      animations: 'disabled',
      scale: 'device',
    },
    toMatchAriaSnapshot: {
      timeout: 5_000,
    },
  },
  use: {
    baseURL: BASE_URL,
    colorScheme: 'light',
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    extraHTTPHeaders: {
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/visual-snapshots.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // Visual regression tests — opt-in via `--project=visual`. Baselines are
      // generated per-OS (chromium-linux.png / -darwin.png) and only the linux
      // variant is committed (see .gitignore).
      name: 'visual',
      testMatch: ['**/visual-snapshots.spec.ts'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    // CI pre-builds once (see .github/workflows/ci.yml) and sets E2E_SKIP_BUILD=1;
    // locally we build on-demand so `bun run test:e2e` is one-shot.
    command: process.env.E2E_SKIP_BUILD
      ? `bunx tsx tests/e2e/serve.ts`
      : `bun run build && bunx tsx tests/e2e/serve.ts`,
    port: PORT,
    timeout: 180_000,
    // Decouple server reuse from CI: a stray CI=1 in a dev/agent shell must not
    // force reuseExistingServer:false (which causes port-conflict false failures).
    // Override with PW_REUSE_EXISTING_SERVER=1|0; default reuses locally, not in CI.
    reuseExistingServer: process.env.PW_REUSE_EXISTING_SERVER != null
      ? process.env.PW_REUSE_EXISTING_SERVER === '1'
      : !process.env.CI,
    env: {
      E2E_PORT: String(PORT),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
