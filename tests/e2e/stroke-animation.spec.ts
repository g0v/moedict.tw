/**
 * Regression for closed issue #41 (字典條目若是只有一個字，則點擊時會顯示筆順動畫)
 * and moedict-webkit#230 (click-to-replay on the stroke grid itself).
 *
 * Most tests verify the container contract without loading real stroke scripts
 * (CDN is blocked by _fixtures.ts to save ~20 s/test). The replay-click test
 * must verify that clicking a *rendered* #strokes container replays
 * rather than closing the panel; it therefore routes the 5 stroke-animation
 * dependencies from local data/assets/js/ and uses the seeded 840c.json fixture
 * so the canvas actually draws and gives the div measurable width.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

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

/** Serve stroke-animation JS from local data/assets/js/ instead of the blocked CDN. */
async function routeStrokeScripts(page: Page): Promise<void> {
  for (const name of STROKE_SCRIPTS) {
    const body = readFileSync(path.join(JS_DIR, name), "utf-8");
    const handler = (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body });
    await page.route(`https://r2-assets.test.local/js/${name}`, handler);
    await page.route(`**/assets/js/${name}`, handler);
  }
}

test.describe("stroke animation trigger", () => {
  test("single-char entry exposes a 筆順動畫 button that mounts #strokes on click", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C"); // /萌
    await waitForAppReady(page);

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await expect(strokeBtn).toBeVisible({ timeout: 15_000 });

    // Before click, StrokeAnimation is unmounted.
    await expect(page.locator("#strokes")).toHaveCount(0);
    await expect(page.locator("#historical-scripts")).toHaveCount(0);

    await strokeBtn.click();

    // After click, StrokeAnimation mounts (empty #strokes + the 歷代書體 button).
    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator("#historical-scripts")).toBeVisible({ timeout: 5_000 });
  });

  test('stroke overlay never injects <i class="icon-spinner"> webfont markup', async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });

    // The stroke JS (when it reaches us via /assets/) creates a `.loader` child
    // inside each `.word`. Its spinner is either absent (animation hasn't
    // started yet) or an <svg>, never an <i class="icon-spinner">.
    const legacySpinners = await page
      .locator("#strokes i.icon-spinner, #strokes i.icon-spin")
      .count();
    expect(legacySpinners).toBe(0);
  });

  test("clicking again toggles the stroke overlay off", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });
    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(0);
    await expect(page.locator("#historical-scripts")).toHaveCount(0);
  });

  // moedict-webkit#230: 陳盈銘 asked for a way to click on the stroke grid
  // itself to restart ("重寫") the animation, instead of having to close and
  // reopen the whole panel (the toggle-off behaviour above) just to watch it
  // again. #strokes is now its own keyboard/mouse-accessible replay control.
  test("#strokes itself is a labelled replay control distinct from the outer toggle", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();

    const strokes = page.locator("#strokes");
    await expect(strokes).toHaveCount(1, { timeout: 5_000 });
    await expect(strokes).toHaveAttribute("role", "button");
    await expect(strokes).toHaveAttribute("tabindex", "0");
    await expect(strokes).toHaveAttribute("aria-label", "點擊重播筆順動畫");
    await expect(strokes).toHaveAttribute("title", "點擊重播筆順動畫");
  });

  test("clicking #strokes replays without closing the panel (unlike the outer toggle)", async ({
    page,
  }) => {
    // Route the 5 stroke-animation JS files from local data/assets/js/ so the
    // scripts actually load and draw 12 canvas strokes for 萌. Without this the
    // CDN is blocked by _fixtures.ts, #strokes stays empty (zero width), and
    // Playwright's actionability check rejects the click.
    await routeStrokeScripts(page);
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();

    const strokes = page.locator("#strokes");
    await expect(strokes).toHaveCount(1, { timeout: 5_000 });

    // Wait for at least one canvas to appear — proves scripts loaded and drew
    // something, giving #strokes measurable width for the click below.
    await expect(strokes.locator("canvas").first()).toBeAttached({ timeout: 15_000 });

    // Clicking the grid itself must NOT collapse the panel the way a second
    // click on the outer pencil toggle does.
    await strokes.click();
    await expect(strokes).toHaveCount(1);
    await expect(page.locator("#historical-scripts")).toBeVisible();

    // Keyboard activation (Enter) must behave identically to a mouse click.
    await strokes.focus();
    await page.keyboard.press("Enter");
    await expect(strokes).toHaveCount(1);
    await expect(page.locator("#historical-scripts")).toBeVisible();
  });

  test("issue #132: pencil button is disabled when stroke data is 404, and stays enabled when available", async ({
    page,
  }) => {
    // 萌 = U+840C → hex "840c". Force the stroke-json probe to 404 regardless
    // of what the local dev backend actually has, so this test is
    // deterministic and environment-independent.
    await page.route("**/api/stroke-json/840c.json", (route) =>
      route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
    );
    await page.goto("/%E8%90%8C"); // /萌
    await waitForAppReady(page);

    const strokeBtn = page.locator("a.iconic-circle.stroke").first();
    await expect(strokeBtn).toBeVisible({ timeout: 15_000 });
    await expect(strokeBtn).toHaveAttribute("aria-disabled", "true", { timeout: 5_000 });
    await expect(strokeBtn).toHaveAttribute("title", "此字尚無筆順動畫資料");
    await expect(strokeBtn).toHaveAttribute("tabindex", "-1");

    // Clicking a disabled trigger must never mount the blank/faded canvas.
    await strokeBtn.click({ force: true });
    await page.waitForTimeout(300);
    await expect(page.locator("#strokes")).toHaveCount(0);
  });

  test("issue #132: pencil button stays enabled once stroke data is confirmed available", async ({
    page,
  }) => {
    await page.route("**/api/stroke-json/840c.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"strokes":[]}' }),
    );
    await page.goto("/%E8%90%8C"); // /萌
    await waitForAppReady(page);

    const strokeBtn = page.locator("a.iconic-circle.stroke").first();
    await expect(strokeBtn).toBeVisible({ timeout: 15_000 });
    await expect(strokeBtn).not.toHaveAttribute("aria-disabled", "true");
    await expect(strokeBtn).toHaveAttribute("title", "筆順動畫");

    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });
  });
});

// Regression for RESCOPE issue #98 (筆順動畫速度控制): the preferences panel
// gains a 筆順動畫速度 <select> (slow/normal/fast) that persists to
// localStorage `stroke-speed` and, unlike the phonetics/pinyin prefs, applies
// live without a page reload.
test.describe("筆順動畫速度 preference (issue #98)", () => {
  async function openPrefPanel(page: Page): Promise<void> {
    // #user-pref is a sibling of #nav-fulltext-search under Layout.tsx's
    // chrome; readiness's `#nav-fulltext-search, #user-pref` OR-selector
    // with `.first()` can resolve on whichever attaches first in DOM
    // order, not necessarily #user-pref itself. Wait for the exact element
    // this function needs before touching it.
    await page.locator("#user-pref").waitFor({ state: "attached", timeout: 15_000 });
    await page.evaluate(() => {
      const panel = document.getElementById("user-pref");
      if (!panel) throw new Error("user-pref element not found in DOM");
      panel.style.display = "block";
    });
    await page.waitForFunction(() => {
      const el = document.getElementById("user-pref");
      return el !== null && el.offsetHeight > 0;
    });
  }

  test("panel exposes a 3-option select defaulting to normal when no pref is stored", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    await openPrefPanel(page);

    const select = page.locator("#pref-select-stroke_speed");
    await expect(select).toBeVisible();
    await expect(select).toHaveValue("normal");

    const optionValues = await select
      .locator("option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(optionValues).toEqual(["slow", "normal", "fast"]);

    const optionLabels = await select
      .locator("option")
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).textContent));
    expect(optionLabels).toEqual(["慢速", "正常速度", "快速"]);
  });

  test("seeded stroke-speed=fast in localStorage is reflected as the select's initial value", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("stroke-speed", "fast");
    });
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    await openPrefPanel(page);

    const select = page.locator("#pref-select-stroke_speed");
    await expect(select).toHaveValue("fast");
  });

  test("changing the select persists to localStorage and does not reload the page", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await waitForAppReady(page);

    // Tag this specific document instance so a reload (which produces a brand
    // new document/window) would make the marker disappear.
    await page.evaluate(() => {
      (window as unknown as { __strokeSpeedSpecMarker?: boolean }).__strokeSpeedSpecMarker = true;
    });

    await openPrefPanel(page);

    const select = page.locator("#pref-select-stroke_speed");
    await expect(select).toHaveValue("normal");

    await page.selectOption("#pref-select-stroke_speed", "slow");
    await expect(select).toHaveValue("slow");

    expect(await page.evaluate(() => window.localStorage.getItem("stroke-speed"))).toBe("slow");

    // If the page had reloaded, this marker would be gone.
    expect(
      await page.evaluate(
        () => (window as unknown as { __strokeSpeedSpecMarker?: boolean }).__strokeSpeedSpecMarker,
      ),
    ).toBe(true);

    // Value survives further interaction (panel still reflects the change).
    await expect(select).toHaveValue("slow");
  });
});
