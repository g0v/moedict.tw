/**
 * Regression for closed issue #41 (字典條目若是只有一個字，則點擊時會顯示筆順動畫).
 *
 * We don't run the real stroke animation (that depends on external CDN
 * scripts which Playwright intentionally blocks via _fixtures.ts). What we
 * verify is the contract: a single-character entry exposes a click target
 * titled "筆順動畫" and, when clicked, the `#strokes` container mounts and
 * does NOT carry any lingering `<i class="icon-spinner">` webfont markup.
 */

import { expect, test } from "./_fixtures";

test.describe("stroke animation trigger", () => {
  test("single-char entry exposes a 筆順動畫 button that mounts #strokes on click", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C"); // /萌
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(1, { timeout: 5_000 });
    await strokeBtn.click();
    await expect(page.locator("#strokes")).toHaveCount(0);
    await expect(page.locator("#historical-scripts")).toHaveCount(0);
  });
});
