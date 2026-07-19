import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8877);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  expect: {
    // Allow a tiny fraction of pixel difference to absorb sub-pixel AA noise.
    toHaveScreenshot: {
      maxDiffPixels: 150,
      animations: "disabled",
      scale: "device",
    },
  },
  use: {
    baseURL: BASE_URL,
    colorScheme: "light",
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    extraHTTPHeaders: {
      "Accept-Language": "zh-TW,zh;q=0.9",
    },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ["**/visual-snapshots.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // Visual regression tests — opt-in via `--project=visual`. Baselines are
      // generated per-OS (chromium-linux.png / -darwin.png) and only the linux
      // variant is committed (see .gitignore).
      name: "visual",
      testMatch: ["**/visual-snapshots.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // Focused WebKit project for romanization overlay selection/geometry tests.
      // Runs all test.describe blocks whose title starts with "@romanization" in
      // dictionary.spec.ts — Taigi, Mandarin, and geometry regression describes.
      // Activate locally: E2E_SKIP_BUILD=1 vp exec playwright test --project=webkit-romanization
      name: "webkit-romanization",
      testMatch: ["**/dictionary.spec.ts"],
      grep: /@romanization/,
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1280, height: 800 },
        video: "off",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
  ],
  webServer: {
    // CI pre-builds once (see .github/workflows/ci.yml) and sets E2E_SKIP_BUILD=1;
    // locally we build on-demand so `vp run test:e2e` is one-shot.
    command: process.env.E2E_SKIP_BUILD
      ? `vp exec tsx tests/e2e/serve.ts`
      : `vp run build && vp exec tsx tests/e2e/serve.ts`,
    // `port` alone only proves the TCP socket is open -- Miniflare/workerd
    // binds it before tests/helpers/miniflare-server.ts finishes seeding R2
    // fixture data (DICTIONARY/ASSETS/FONTS), so a test could start
    // navigating before fixtures exist. `url` makes Playwright poll a real
    // hydrated endpoint instead. Deliberately NOT a /api/*.json dictionary
    // route: those are read through readR2JsonCached's per-isolate memo
    // (src/api/r2-json-cache.ts), which caches a MISS as `null` for 10
    // minutes -- a single probe hit that lands before DICTIONARY finishes
    // seeding poisons that key for the rest of the run, no matter how long
    // seeding then takes. The seeded MOEDICT.woff2 asset path is served by
    // serveAssetWithFallback (src/api/release-fallback.ts), which reads
    // directly from the ASSETS R2 binding with no such memo, so repeated
    // pre-seed probes are side-effect-free and it only turns 200 once the
    // font is genuinely seeded.
    url: `${BASE_URL}/assets/fonts/MOEDICT.woff2`,
    timeout: 180_000,
    // Decouple server reuse from CI: a stray CI=1 in a dev/agent shell must not
    // force reuseExistingServer:false (which causes port-conflict false failures).
    // Override with PW_REUSE_EXISTING_SERVER=1|0; default reuses locally, not in CI.
    reuseExistingServer:
      process.env.PW_REUSE_EXISTING_SERVER != null
        ? process.env.PW_REUSE_EXISTING_SERVER === "1"
        : !process.env.CI,
    env: {
      E2E_PORT: String(PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
});
