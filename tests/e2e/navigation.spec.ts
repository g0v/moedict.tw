import { expect, test } from "./_fixtures";

test.describe("navigation flows", () => {
  test("back/forward preserves route", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState("networkidle");
    await page.goBack();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/萌/);
    await page.goForward();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/食/);
  });

  test("clicking logo navigates to home (may redirect to LRU last-lookup)", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    const homeLink = page.locator('a[href="/"]').first();
    if ((await homeLink.count()) === 0) return;
    await homeLink.click();
    await page.waitForLoadState("networkidle");
    // HomeRoute redirects to formatWordPath(lastLookup). Since we just viewed 萌
    // (lang=a), / should redirect back to /萌. Either / or /萌 is acceptable.
    const pathname = new URL(page.url()).pathname;
    expect(pathname === "/" || pathname.includes("萌") || pathname.includes("%E8%90%8C")).toBe(
      true,
    );
  });

  test("404-style unknown route still renders SPA shell", async ({ page }) => {
    const response = await page.goto("/totallymade-up-path-1234");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/萌典|萌/);
  });

  test("direct navigation to radical page /@木", async ({ page }) => {
    await page.goto("/@%E6%9C%A8");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/木/);
  });

  test("direct navigation to Taiwanese radical page /'@木 (g0v/moedict-webkit#122)", async ({
    page,
  }) => {
    await page.goto("/'@%E6%9C%A8");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/木.*台語萌典/);
  });

  test("starred redirect variants", async ({ page }) => {
    for (const path of ["/=*", "/'=*", "/:=*", "/~=*"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/字詞紀錄簿/);
    }
  });

  test("category list (/=近義詞) renders list", async ({ page }) => {
    const response = await page.goto("/=%E8%BF%91%E7%BE%A9%E8%A9%9E");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/近義詞|分類索引/);
  });

  test("legacy hashbang link (g0v/moedict-webkit#131): direct nav to /#'word resolves to /'word, not the homepage", async ({
    page,
  }) => {
    // Content links inside entries still emit `./#'word` (2014 hashbang
    // convention); the browser resolves that to pathname "/" + hash
    // "#'食". Opening it directly (new tab / copied link / typed URL)
    // must land on the real entry, not silently fall back to the homepage.
    const response = await page.goto("/#'%E9%A3%9F");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/食/);
    const pathname = decodeURIComponent(new URL(page.url()).pathname);
    expect(pathname).toBe("/'食");
  });

  test("legacy hashbang radical-tag link (/#@木) resolves to /@木, not the homepage", async ({
    page,
  }) => {
    const response = await page.goto("/#@%E6%9C%A8");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/木/);
    const pathname = decodeURIComponent(new URL(page.url()).pathname);
    expect(pathname).toBe("/@木");
  });
});
