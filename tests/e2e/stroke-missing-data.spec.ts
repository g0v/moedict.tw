/**
 * Regression for issue #76 (若沒有筆順資料, 應更明確顯示 not found).
 *
 * Original bug: when `/api/stroke-json/{cp}.json` 404s (no stroke data for
 * a character), the legacy jquery.strokeWords.js fail handler only faded
 * the empty stroke canvas to 50% opacity (`drawElementWithWord`'s fail
 * branch). That reads as "the click did nothing" — Audrey's own comment on
 * the issue: "a simple question mark will work better than the opacity
 * treatment." (https://github.com/g0v/moedict-webkit/issues/76)
 *
 * This test forces the stroke-json request to 404 and drives the *real*
 * jquery.strokeWords.js (served from a routed copy of the local
 * data/assets/js/*.js — the same files Miniflare/R2 ship in production) so
 * it genuinely exercises the fail path, not just source-text assertions.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const JS_DIR = path.join(REPO_ROOT, "data", "assets", "js");

const STROKE_SCRIPTS = [
  "jquery-2.1.1.min.js",
  "raf.min.js",
  "gl-matrix-min.js",
  "sax.js",
  "jquery.strokeWords.js",
];

/**
 * Serve the stroke-animation dependency chain from the local checked-in
 * files (via the fake r2-assets.test.local host StrokeAnimation.tsx resolves
 * to in this test env) so the real WordStroker code runs instead of being
 * blocked by _fixtures.ts's blanket r2-*.test.local 404.
 */
async function routeStrokeScripts(page: Page): Promise<void> {
  for (const name of STROKE_SCRIPTS) {
    const body = readFileSync(path.join(JS_DIR, name), "utf-8");
    const handler = (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body });
    await page.route(`https://r2-assets.test.local/js/${name}`, handler);
    await page.route(`**/assets/js/${name}`, handler);
  }
}

/** Force every stroke-json data fetch (GET) to 404, simulating a missing codepoint.
 * HEAD requests (used by useStrokeAvailability probe) are allowed through so the
 * button stays enabled — the badge must show AFTER the panel opens, not be blocked
 * by #132's pre-emptive disable which fires when the HEAD probe also 404s. */
async function routeStrokeJsonNotFound(page: Page): Promise<void> {
  await page.route("**/api/stroke-json/**", async (route) => {
    if (route.request().method() === "HEAD") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "" });
    } else {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Not Found"}',
      });
    }
  });
}

test.describe("missing stroke data (#76)", () => {
  test("shows an explicit not-found badge instead of a faded blank canvas", async ({ page }) => {
    await routeStrokeScripts(page);
    await routeStrokeJsonNotFound(page);

    await page.goto("/%E8%90%8C"); // /萌
    await page.waitForLoadState("networkidle");

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await expect(strokeBtn).toBeVisible({ timeout: 15_000 });
    await strokeBtn.click();

    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });

    // The explicit not-found indicator must render — a visible, accessible
    // badge, not a silently-faded canvas.
    const badge = page.locator("#strokes .word.stroke-missing .stroke-missing-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge.locator(".stroke-missing-mark")).toHaveText("？");
    await expect(badge.locator(".stroke-missing-text")).toHaveText("尚無筆順資料");

    // The word wrapper carries an accessible name so assistive tech
    // announces the missing-data state, not just a visual question mark.
    const word = page.locator("#strokes .word.stroke-missing");
    await expect(word).toHaveAttribute("role", "img");
    const ariaLabel = await word.getAttribute("aria-label");
    expect(ariaLabel).toMatch(/尚無筆順資料/);
    expect(ariaLabel).toContain("萌");

    // The underlying canvas must be hidden (not merely faded) — the old
    // "opacity treatment" this issue explicitly asks to replace.
    const canvasVisibility = await page
      .locator("#strokes .word.stroke-missing canvas")
      .evaluate((el) => getComputedStyle(el).visibility);
    expect(canvasVisibility).toBe("hidden");
  });
});
