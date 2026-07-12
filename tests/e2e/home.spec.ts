import { expect, test } from "./_fixtures";

test.describe("home route", () => {
  test("/ serves the SPA shell with search box", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"] || "").toMatch(/text\/html/);
    await expect(page).toHaveTitle(/萌典/);
    // Wait for React to hydrate and render the fulltext search input.
    await expect(page.locator("#nav-fulltext-search").first()).toBeVisible({ timeout: 15_000 });
  });

  test("Chinese text renders without mojibake", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const bodyText = await page.locator("body").innerText();
    // Chinese range sanity check: at least one CJK char rendered somewhere
    expect(/[\u4e00-\u9fff]/.test(bodyText)).toBe(true);
  });
});
