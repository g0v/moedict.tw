/**
 * Regression for closed issue #41 (字典條目若是只有一個字，則點擊時會顯示筆順動畫)
 * and moedict-webkit#230 (click-to-replay on the stroke grid itself).
 *
 * We don't run the real stroke animation (that depends on external CDN
 * scripts which Playwright intentionally blocks via _fixtures.ts). What we
 * verify is the contract: a single-character entry exposes a click target
 * titled "筆順動畫" and, when clicked, the `#strokes` container mounts and
 * does NOT carry any lingering `<i class="icon-spinner">` webfont markup;
 * and separately, that `#strokes` is its own accessible replay control
 * (role=button/tabIndex/aria-label, Enter-activatable) that does not close
 * the panel the way a second click on the outer toggle does.
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

  // moedict-webkit#230: 陳盈銘 asked for a way to click on the stroke grid
  // itself to restart ("重寫") the animation, instead of having to close and
  // reopen the whole panel (the toggle-off behaviour above) just to watch it
  // again. #strokes is now its own keyboard/mouse-accessible replay control.
  test("#strokes itself is a labelled replay control distinct from the outer toggle", async ({
    page,
  }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");

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
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");

    const strokeBtn = page.locator('a.iconic-circle.stroke[title="筆順動畫"]').first();
    await strokeBtn.click();

    const strokes = page.locator("#strokes");
    await expect(strokes).toHaveCount(1, { timeout: 5_000 });

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
});
