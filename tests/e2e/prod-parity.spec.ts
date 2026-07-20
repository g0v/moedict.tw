import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";
import allowlist from "./prod-parity-allowlist.json" with { type: "json" };
import { compareEntry, measureEntry } from "../../scripts/lib/prod-parity-measure.mjs";

/**
 * Differential prod-parity geometry harness (parity-sweep-2's allowlist
 * design, cf3b0b9/406de90-era ruby-example fix set). Reads
 * tests/e2e/prod-parity-allowlist.json — a POSITIVE allowlist of surfaces
 * confirmed byte-identical between this branch and LIVE production
 * (https://www.moedict.tw, pre-#152) — and re-measures each entry against
 * THIS branch's local Miniflare fixture server (same server every other
 * e2e spec runs against; zero external network here). Growth model: an
 * entry is added when a NEW surface is confirmed matching (via
 * `vp run refresh:prod-parity`, reviewed in the PR that adds it) and
 * removed in the SAME PR that intentionally changes that surface — see
 * AGENTS.md's UI 慣例與結構性防護 section.
 *
 * Measurement runs through scripts/lib/prod-parity-measure.mjs's
 * measureEntry()/compareEntry() — the SAME module
 * scripts/refresh-prod-parity-baseline.mjs uses to capture prod's
 * `recorded_value`/`recorded_ratio` baseline in the first place, so the
 * captured number and this spec's comparison share one code path (no risk
 * of two independent reimplementations silently disagreeing on rounding,
 * aggregate order, or readiness timing).
 *
 * `provisional` gate (tests/e2e/prod-parity-allowlist.json top-level
 * field): every seed entry in THIS PR was captured ad-hoc (not yet via
 * the canonical `vp run refresh:prod-parity` run under a CI-matching font
 * environment — see the allowlist's own `provisional_note`), so a
 * mismatch here is reported (test annotation + console.warn) but never
 * fails the build. A SELECTOR THAT VANISHES ENTIRELY always hard-fails
 * regardless of `provisional` — that is a broken/renamed surface, not a
 * legitimate geometry drift the provisional soft-fail exists to absorb.
 * Once `provisional` flips to `false` (after a canonical CI-environment
 * refresh confirms the baseline), every entry becomes a normal hard
 * assertion.
 */

// Same interception pair as tests/e2e/legacy-styles-regression.spec.ts /
// visual-invariants.spec.ts (kept local per those files' own convention).
// REQUIRED here, unconditionally: every allowlisted surface's geometry is
// legacy-CSS-cascade-dependent (confirmed live this session — the
// .example container measures 898px unstyled vs. 538.171875px under the
// real cascade, nearly double), so this spec would be measuring the wrong
// number entirely without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STYLES_CSS_PATH = path.join(REPO_ROOT, "data", "assets", "styles.css");

function readWorkingTreeStylesCss(): string {
  return readFileSync(STYLES_CSS_PATH, "utf-8");
}

async function routeStylesCss(page: Page, getCss: () => string): Promise<void> {
  const handler = (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: getCss(),
    });
  await page.route("https://r2-assets.test.local/styles.css", handler);
  await page.route("https://r2-assets.test.local/styles.css?*", handler);
  await page.route("**/assets/styles.css", handler);
  await page.route("**/assets/styles.css?*", handler);
}

async function blockCssSubresources(page: Page): Promise<void> {
  const notFound = (route: Route) =>
    route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "" });
  await page.route("**/assets/fonts/**", (route) => {
    if (new URL(route.request().url()).pathname.includes("/MOEDICT.")) {
      return route.fallback();
    }
    return notFound(route);
  });
  await page.route("**/assets/images/leather_x2.jpg", notFound);
  await page.route("**/assets/images/subtle_stripes_x2.png", notFound);
}

const PROVISIONAL: boolean = allowlist.provisional;

for (const entry of allowlist.entries) {
  test(`prod-parity: ${entry.id}`, async ({ page, baseURL }) => {
    await page.setViewportSize(entry.viewport);
    await blockCssSubresources(page);
    await routeStylesCss(page, readWorkingTreeStylesCss);

    const measured = await measureEntry(page, baseURL!, entry);
    const result = compareEntry(measured, entry);

    // A vanished selector is ALWAYS a hard failure, provisional or not —
    // see module doc comment on compareEntry.
    if (!result.selectorMatched) {
      expect(result.selectorMatched, result.message).toBe(true);
      return;
    }

    if (PROVISIONAL) {
      test.info().annotations.push({
        type: result.pass ? "prod-parity" : "prod-parity-MISMATCH (provisional, non-blocking)",
        description: result.message,
      });
      if (!result.pass) {
        console.warn(`[prod-parity, provisional] ${result.message}`);
      }
      return;
    }

    expect(result.pass, result.message).toBe(true);
  });
}
