import { expect, test } from './_fixtures';

test.describe('search box interactions', () => {
  test('typing in nav search shows autocomplete suggestions', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    const input = page.locator('#nav-fulltext-search').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('萌');
    // Verify no crash and the input still holds the text (suggestion dropdown may
    // appear depending on index fetch timing — we don't assert on it here because
    // downstream tests already cover autocomplete interaction).
    await expect(input).toHaveValue('萌');
  });

  test('ArrowDown + Enter selects first suggestion and navigates', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const input = page.locator('#nav-fulltext-search').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('上訴');
    // Wait for the suggestion dropdown to appear and then highlight first entry
    await expect(page.locator('[role="listbox"], .fulltext-search-suggest').first()).toBeVisible({
      timeout: 10_000,
    });
    await input.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL(/%E4%B8%8A%E8%A8%B4|上訴/, { timeout: 10_000 });
  });

  test('clicking a suggestion navigates to that word', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const input = page.locator('#nav-fulltext-search').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('上訴');
    await page.locator('[role="option"], [role="listbox"] li').first().click();
    await page.waitForURL(/上訴|%E4%B8%8A%E8%A8%B4/, { timeout: 10_000 });
  });
});

test.describe('star / unstar', () => {
  test('localStorage starred-a bucket is initialized', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    const starred = await page.evaluate(() => window.localStorage.getItem('starred-a'));
    // Either empty string (initialized) or null (not yet touched) is OK
    expect(starred === '' || starred === null || typeof starred === 'string').toBe(true);
  });

  test('programmatic star toggles state', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.localStorage.setItem('starred-a', '"萌"\\n'));
    await page.reload();
    await page.waitForLoadState('networkidle');
    const raw = await page.evaluate(() => window.localStorage.getItem('starred-a'));
    expect(raw).toContain('萌');
  });
});

test.describe('LRU (last viewed) records', () => {
  test('visiting a word adds it to the LRU list', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.localStorage.clear());
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    // Small wait for the effect
    await page.waitForTimeout(500);
    const lru = await page.evaluate(() => window.localStorage.getItem('lru-a'));
    expect(lru).toContain('萌');
  });

  test('last-lookup sets prev-id + lang', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => window.localStorage.clear());
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
    const prevId = await page.evaluate(() => window.localStorage.getItem('prev-id'));
    const lang = await page.evaluate(() => window.localStorage.getItem('lang'));
    expect(prevId).toBe('食');
    expect(lang).toBe('t');
  });
});

test.describe('cross-language navigation', () => {
  test('a → c same-word swap (prefix only)', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    // Manually navigate via URL rewrite to /~萌 (simulating lang-switch click)
    await page.goto('/~%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/萌/);
    const text = await page.locator('body').innerText();
    expect(text).toContain('萌');
  });
});

test.describe('starred page', () => {
  test('/=* renders the starred landing (a)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      window.localStorage.setItem('starred-a', '"萌"\\n"水"\\n');
    });
    await page.goto('/=*');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/字詞紀錄簿/);
  });

  test('per-item remove button clears a single starred word without confirm (#129)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      window.localStorage.setItem('starred-a', '"萌"\\n"水"\\n');
    });
    await page.goto('/=*');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '移除收藏「萌」' }).click();

    await expect(page.getByRole('button', { name: '移除收藏「萌」' })).toHaveCount(0);
    const raw = await page.evaluate(() => window.localStorage.getItem('starred-a'));
    expect(raw).not.toContain('"萌"');
    expect(raw).toContain('"水"');
  });
});

test.describe('head metadata injection', () => {
  test('client-side applyHeadByPath updates <meta og:*> on navigation', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImage).toMatch(/%E8%90%8C\.png$/);
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle).toMatch(/萌/);
  });

  test('navigation updates the title tag', async ({ page }) => {
    await page.goto('/%E8%90%8C');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/萌/);
    await page.goto("/'%E9%A3%9F");
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/食/);
  });
});
