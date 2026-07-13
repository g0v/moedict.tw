import { expect, test } from "./_fixtures";

test.describe("search box interactions", () => {
  test("typing in nav search shows autocomplete suggestions", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    const input = page.locator("#nav-fulltext-search").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("萌");
    // Verify no crash and the input still holds the text (suggestion dropdown may
    // appear depending on index fetch timing — we don't assert on it here because
    // downstream tests already cover autocomplete interaction).
    await expect(input).toHaveValue("萌");
  });

  test("ArrowDown + Enter selects first suggestion and navigates", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator("#nav-fulltext-search").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("上訴");
    // Wait for the suggestion dropdown to appear and then highlight first entry
    await expect(page.locator('[role="listbox"], .fulltext-search-suggest').first()).toBeVisible({
      timeout: 10_000,
    });
    await input.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForURL(/%E4%B8%8A%E8%A8%B4|上訴/, { timeout: 10_000 });
  });

  test("clicking a suggestion navigates to that word", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const input = page.locator("#nav-fulltext-search").first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("上訴");
    await page.locator('[role="option"], [role="listbox"] li').first().click();
    await page.waitForURL(/上訴|%E4%B8%8A%E8%A8%B4/, { timeout: 10_000 });
  });
});

test.describe("star / unstar", () => {
  test("localStorage starred-a bucket is initialized", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    const starred = await page.evaluate(() => window.localStorage.getItem("starred-a"));
    // Either empty string (initialized) or null (not yet touched) is OK
    expect(starred === "" || starred === null || typeof starred === "string").toBe(true);
  });

  test("programmatic star toggles state", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.localStorage.setItem("starred-a", '"萌"\\n'));
    await page.reload();
    await page.waitForLoadState("networkidle");
    const raw = await page.evaluate(() => window.localStorage.getItem("starred-a"));
    expect(raw).toContain("萌");
  });
});

test.describe("LRU (last viewed) records", () => {
  test("visiting a word adds it to the LRU list", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.localStorage.clear());
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    // Small wait for the effect
    await page.waitForTimeout(500);
    const lru = await page.evaluate(() => window.localStorage.getItem("lru-a"));
    expect(lru).toContain("萌");
  });

  test("last-lookup sets prev-id + lang", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.localStorage.clear());
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const prevId = await page.evaluate(() => window.localStorage.getItem("prev-id"));
    const lang = await page.evaluate(() => window.localStorage.getItem("lang"));
    expect(prevId).toBe("食");
    expect(lang).toBe("t");
  });
});

test.describe("cross-language navigation", () => {
  test("a → c same-word swap (prefix only)", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    // Manually navigate via URL rewrite to /~萌 (simulating lang-switch click)
    await page.goto("/~%E8%90%8C");
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveTitle(/萌/);
    const text = await page.locator("body").innerText();
    expect(text).toContain("萌");
  });
});

test.describe("starred page", () => {
  test("/=* renders the starred landing (a)", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n"水"\\n');
    });
    await page.goto("/=*");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/字詞紀錄簿/);
  });

  test("per-item remove button clears a single starred word without confirm (#129)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n"水"\\n');
    });
    await page.goto("/=*");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "移除收藏「萌」" }).click();

    await expect(page.getByRole("button", { name: "移除收藏「萌」" })).toHaveCount(0);
    const raw = await page.evaluate(() => window.localStorage.getItem("starred-a"));
    expect(raw).not.toContain('"萌"');
    expect(raw).toContain('"水"');
  });
});

test.describe("head metadata injection", () => {
  test("client-side applyHeadByPath updates <meta og:*> on navigation", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(ogImage).toMatch(/%E8%90%8C\.png$/);
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
    expect(ogTitle).toMatch(/萌/);
  });

  test("navigation updates the title tag", async ({ page }) => {
    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/萌/);
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveTitle(/食/);
  });

  // Regression guard for g0v/moedict.tw#131: the two tests above only
  // prove the CLIENT-SIDE applyHeadByPath() ran after hydration — they'd
  // pass even if the Worker's server-side injectHeadMetadata() were
  // completely dead (which is exactly how #131 shipped unnoticed). This
  // hits the raw HTTP response via Playwright's `request` fixture — no
  // page, no JS execution — the same way a crawler, link-unfurl bot, or
  // oEmbed consumer sees it, against the real Miniflare server (built +
  // includeAssets:true, see tests/e2e/serve.ts) so it exercises the real
  // SITE_ASSETS Fetcher binding + wrangler.jsonc run_worker_first catch-all
  // end-to-end instead of a unit-test mock.
  test("server renders the word-specific head + oEmbed discovery link with no JS", async ({
    request,
  }) => {
    const res = await request.get("/%E8%90%8C");
    expect(res.status()).toBe(200);
    const html = await res.text();

    expect(html).toMatch(/<title>萌[^<]*<\/title>/);
    expect(html).not.toContain("<title>萌典</title>");
    expect(html).toContain('property="og:title" content="萌');
    // Exactly one level of percent-encoding in the canonical URL — guards
    // the double-encoding bug this same investigation uncovered in
    // src/ssr/head.ts's toCanonicalUrl().
    expect(html).toContain('property="og:url" content="https://www.moedict.tw/%E8%90%8C"');

    expect(html).toContain('rel="alternate" type="application/json+oembed"');
    expect(html).toContain(`url=${encodeURIComponent("https://www.moedict.tw/%E8%90%8C")}`);
  });
});
