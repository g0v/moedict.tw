import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect } from "@playwright/test";

/**
 * Block requests to the fake `r2-assets.test.local` hostname so Playwright
 * doesn't wait for them to DNS-fail. This trims ~20s per test on networkidle.
 * Local assets served by our Miniflare fixture are reached via /assets/* and
 * pass through untouched.
 *
 * When E2E_COVERAGE=1 is set, we also collect V8 JS coverage per test and
 * write the raw entries to coverage/playwright/<hash>.json for the merge
 * script (scripts/merge-coverage.mjs) to pick up.
 */

const COVERAGE_ENABLED = process.env.E2E_COVERAGE === "1";
const COVERAGE_DIR = path.resolve(process.cwd(), "coverage", "playwright");

function safeSlug(input: string): string {
  return (
    input
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "test"
  );
}

export const test = base.extend({
  page: async ({ page }, run, testInfo) => {
    await page.route(/^https?:\/\/r2-[a-z]+\.test\.local\//, (route) => {
      return route.fulfill({
        status: 404,
        contentType: "application/octet-stream",
        body: "",
      });
    });

    if (COVERAGE_ENABLED) {
      // resetOnNavigation:false keeps entries across client-side routes;
      // reportAnonymousScripts:true would include eval'd scripts — we skip
      // that since our bundle is a single named script.
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    }

    await run(page);

    if (COVERAGE_ENABLED) {
      const entries = await page.coverage.stopJSCoverage();
      // Keep only our app bundle — skip about:blank, extensions, CDN scripts.
      const filtered = entries.filter((entry) => {
        if (!entry.url) return false;
        if (!entry.url.startsWith("http://") && !entry.url.startsWith("https://")) return false;
        // Exclude third-party: only the /assets/ bundle (Vite output) is ours.
        const pathname = new URL(entry.url).pathname;
        return pathname.startsWith("/assets/") && pathname.endsWith(".js");
      });
      if (filtered.length > 0) {
        mkdirSync(COVERAGE_DIR, { recursive: true });
        const slug = `${safeSlug(testInfo.titlePath.join("-"))}-${process.pid}-${Date.now()}`;
        writeFileSync(path.join(COVERAGE_DIR, `${slug}.json`), JSON.stringify(filtered), "utf-8");
      }
    }
  },
});

export { expect };
